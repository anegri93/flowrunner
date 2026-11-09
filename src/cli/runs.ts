// Los comandos que lanzan y operan runs: run, status, resume, rerun, abort y el proceso `_run`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateOf, type RunState } from "../engine/engine.ts";
import { notifyMac } from "../notify/notify.ts";
import { productionRuntime } from "../runner/production.ts";
import { writeReport } from "../report/report.ts";
import { runUntilStop } from "../runner/runner.ts";
import type { RunPaths } from "../runner/types.ts";
import { PHASES, type Phase } from "../store/events.ts";
import { acquireLock, isAlive, LockHeldError, readLock, releaseLock } from "../store/lock.ts";
import { repoNode } from "../proc/node.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { createRun, holderStatus, listRunIds, loadState, runPaths } from "../store/runs.ts";
import {
  runStartedSchema,
  statusListSchema,
  statusRunSchema,
  steps,
  summarize,
} from "./contracts.ts";
import { checkFeature } from "./feature-check.ts";
import { UserError } from "./output.ts";

export const BIN = join(import.meta.dirname, "..", "..", "bin", "flowrunner.js");

/** Lanza el proceso del run separado de la terminal; su salida va a `run.log`. */
function spawnRunProcess(run: RunPaths, env: NodeJS.ProcessEnv): number {
  const log = openSync(join(run.dir, "run.log"), "a");
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", BIN, "_run", run.id],
    { detached: true, stdio: ["ignore", log, log], env },
  );
  child.unref();
  return child.pid ?? -1;
}

/** Lanza el proceso del run y le pasa el lock, que este comando tomó con su propio pid. */
export function handOver(
  home: string,
  project: string,
  run: RunPaths,
  env: NodeJS.ProcessEnv,
): void {
  const pid = spawnRunProcess(run, env);
  acquireLock(home, project, run.id, pid, (id) => holderStatus(home, id));
}

function lockOrExplain(home: string, project: string, runId: string, pid: number): void {
  try {
    acquireLock(home, project, runId, pid, (id) => holderStatus(home, id));
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new UserError(error.message, `flowrunner status ${error.holder.run_id}`);
    }
    throw error;
  }
}

/** El run tiene un proceso vivo que lo está avanzando. */
function isRunning(home: string, state: RunState): boolean {
  const lock = readLock(home, state.proyecto);
  return lock?.run_id === state.runId && isAlive(lock.pid) && lock.pid !== process.pid;
}

export function startRun(home: string, file: string, env: NodeJS.ProcessEnv, now: Date) {
  const checked = checkFeature(file, env);
  const featureText = readFileSync(checked.file, "utf8");
  const run = createRun(
    home,
    {
      clave: checked.feature.clave,
      proyecto: checked.project.name,
      repo: checked.project.path,
      budgetUsd: checked.repoConfig.budget?.run_usd,
      featureText,
    },
    now,
  );
  try {
    lockOrExplain(home, checked.project.name, run.id, process.pid);
  } catch (error) {
    rmSync(run.dir, { recursive: true, force: true });
    throw error;
  }
  handOver(home, checked.project.name, run, env);
  return runStartedSchema.parse({ ok: true, id: run.id, accion: "lanzado en segundo plano" });
}

export function statusAll(home: string) {
  return statusListSchema.parse({
    ok: true,
    runs: listRunIds(home).map((id) => summarize(loadState(home, id))),
  });
}

export function statusOne(home: string, id: string) {
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "events.jsonl")))
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  const { events } = readLog(run.dir);
  return statusRunSchema.parse({ ok: true, run: summarize(stateOf(events)), pasos: steps(events) });
}

function loadOrExplain(home: string, id: string): RunState {
  try {
    return loadState(home, id);
  } catch {
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  }
}

export function resumeRun(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = loadOrExplain(home, id);
  if (isRunning(home, state))
    throw new UserError(`el run ${id} ya está corriendo`, `flowrunner status ${id}`);
  const resumable =
    state.status === "detenido" ||
    state.status === "pausado_por_limite" ||
    state.status === "en_curso";
  if (!resumable) {
    throw new UserError(
      `el run ${id} está ${state.status}: no hay nada que retomar`,
      `flowrunner status ${id}`,
    );
  }
  const run = runPaths(home, id);
  lockOrExplain(home, state.proyecto, id, process.pid);
  appendEvent(run.dir, { tipo: "reanudado" });
  handOver(home, state.proyecto, run, env);
  return runStartedSchema.parse({ ok: true, id, accion: `retomado en ${state.fase}` });
}

/**
 * Entregar aunque probar dejó criterios sin probar. Es una decisión de la persona y queda escrita con
 * su motivo en el informe y en la PR: sin motivo no se acepta. Ver ADR 0017.
 */
export function acceptUntested(
  home: string,
  id: string,
  motivo: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (motivo === undefined || motivo.trim() === "") {
    throw new UserError(
      "falta el motivo: por qué se entrega con criterios sin probar",
      `flowrunner accept-untested ${id} "<por qué>"`,
    );
  }
  const state = loadOrExplain(home, id);
  if (state.status !== "detenido" || !state.sinProbar) {
    throw new UserError(
      `el run ${id} no está detenido por criterios sin probar (está ${state.status} en ${state.fase})`,
      `flowrunner status ${id}`,
    );
  }
  const run = runPaths(home, id);
  lockOrExplain(home, state.proyecto, id, process.pid);
  appendEvent(run.dir, { tipo: "sin_probar_aceptado", motivo: motivo.trim() });
  handOver(home, state.proyecto, run, env);
  return runStartedSchema.parse({
    ok: true,
    id,
    accion: "aceptado sin probar: entregar arrancó",
  });
}

export function rerunRun(
  home: string,
  id: string,
  from: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (from === undefined || !(PHASES as readonly string[]).includes(from)) {
    throw new UserError(
      `--desde tiene que ser una fase: ${PHASES.join(", ")}`,
      `flowrunner rerun ${id} --desde <fase>`,
    );
  }
  const state = loadOrExplain(home, id);
  if (state.status === "abortado") throw new UserError(`el run ${id} fue abortado`);
  if (isRunning(home, state))
    throw new UserError(`el run ${id} ya está corriendo`, `flowrunner abort ${id}`);
  const run = runPaths(home, id);
  lockOrExplain(home, state.proyecto, id, process.pid);
  appendEvent(run.dir, { tipo: "rehacer", desde: from as Phase });
  handOver(home, state.proyecto, run, env);
  return runStartedSchema.parse({ ok: true, id, accion: `rehaciendo desde ${from}` });
}

/** Borra los worktrees del run; las ramas quedan. */
export function removeWorktrees(run: RunPaths, repo: string): void {
  if (!existsSync(run.worktrees)) return;
  for (const entry of readdirSync(run.worktrees)) {
    try {
      execFileSync(
        "git",
        ["-C", repo, "worktree", "remove", "--force", join(run.worktrees, entry)],
        {
          stdio: "ignore",
        },
      );
    } catch {
      // Un worktree que git ya no conoce se borra igual abajo.
    }
  }
  rmSync(run.worktrees, { recursive: true, force: true });
  try {
    execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  } catch {
    // Sin repo no hay nada que podar.
  }
}

export function abortRun(home: string, id: string) {
  const state = loadOrExplain(home, id);
  if (state.status === "abortado") throw new UserError(`el run ${id} ya estaba abortado`);
  const run = runPaths(home, id);
  appendEvent(run.dir, { tipo: "abortado" });
  const lock = readLock(home, state.proyecto);
  if (lock?.run_id === id && lock.pid !== process.pid && isAlive(lock.pid)) {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      // El proceso terminó entre la lectura del lock y la señal.
    }
  }
  removeWorktrees(run, state.repo);
  releaseLock(home, state.proyecto, id);
  return runStartedSchema.parse({ ok: true, id, accion: "abortado; las ramas quedan" });
}

/** El proceso del run: toma el lock, avanza hasta detenerse y suelta el lock si terminó. */
export async function runProcess(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = loadState(home, id);
  acquireLock(home, state.proyecto, id, process.pid, (other) => holderStatus(home, other));
  // Setup, agentes y fixers corren con el Node del repo. Si no está instalado, verify se niega a
  // correr y el run se detiene con el motivo.
  const { deps, phases } = await productionRuntime(
    (await repoNode(state.repo, env)).env,
    (title, body) => {
      notifyMac(title, body, env);
    },
  );
  const run = runPaths(home, id);
  const final = await runUntilStop(run, phases, deps);
  // El informe se escribe siempre al terminar el proceso: completo o parcial si se detuvo.
  writeReport(run, readLog(run.dir).events);
  if (holderStatus(home, id) === "terminado") releaseLock(home, final.proyecto, id);
  return final;
}
