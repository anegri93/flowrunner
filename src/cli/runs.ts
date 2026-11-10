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
import { loadRepoConfig } from "../config/load.ts";
import { ConfigError, MAX_RUNS_DEFAULT } from "../config/schemas.ts";
import { conTurnoGitSync } from "../git/git.ts";
import { isAlive } from "../store/lock.ts";
import { lugarDe, ocupados, soltarLugar, tomarLugar, type Reglas } from "../store/lugares.ts";
import { repoNode } from "../proc/node.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { colaDe, createRun, listRunIds, loadState, ocupaLugar, runPaths } from "../store/runs.ts";
import { conTurnoSync, turnoFile } from "../store/turno.ts";
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

/**
 * El tope del repo. Una config que no carga no traba la cola: el run que arranque se detiene en
 * preparar con el motivo, que es donde se valida la config.
 */
function maxRuns(repo: string): number {
  try {
    return loadRepoConfig(repo).max_runs;
  } catch (error) {
    if (error instanceof ConfigError) return MAX_RUNS_DEFAULT;
    throw error;
  }
}

function reglas(home: string, repo: string): Reglas {
  return { max: maxRuns(repo), ocupa: (id) => ocupaLugar(home, id) };
}

/** Lanza el proceso del run y le pasa el lugar, que este comando ya tomó con su propio pid. */
function handOver(home: string, state: RunState, run: RunPaths, env: NodeJS.ProcessEnv): void {
  const pid = spawnRunProcess(run, env);
  tomarLugar(home, state.proyecto, run.id, pid, reglas(home, state.repo));
}

/** El run tiene un proceso vivo, que no es este, que lo está avanzando. */
function isRunning(home: string, state: RunState): boolean {
  const lugar = lugarDe(home, state.proyecto, state.runId);
  return lugar !== undefined && isAlive(lugar.pid) && lugar.pid !== process.pid;
}

export type Lanzado =
  | { readonly tipo: "lanzado" }
  | { readonly tipo: "en_cola"; readonly posicion: number; readonly corriendo: string[] };

/**
 * Después del evento que deja al run en curso: lo lanza si hay lugar, o lo deja en cola. Corre con
 * el turno de la cola, igual que despacharla: así un run nunca termina con dos procesos.
 */
export function lanzarOEncolar(home: string, id: string, env: NodeJS.ProcessEnv): Lanzado {
  const state = loadState(home, id);
  return conTurnoSync(turnoFile(home, state.proyecto, "cola"), id, (): Lanzado => {
    if (isRunning(home, state)) return { tipo: "lanzado" };
    const run = runPaths(home, id);
    const toma = tomarLugar(home, state.proyecto, id, process.pid, reglas(home, state.repo));
    if (toma.ok) {
      handOver(home, state, run, env);
      return { tipo: "lanzado" };
    }
    appendEvent(run.dir, { tipo: "encolado" });
    const posicion = colaDe(home, state.proyecto).findIndex((q) => q.id === id) + 1;
    return { tipo: "en_cola", posicion, corriendo: toma.corriendo };
  });
}

/**
 * Lanza los runs en cola del proyecto, el más viejo primero, mientras haya lugar. La llaman el
 * proceso que suelta un lugar, abort y tick, que es el respaldo si ese proceso murió sin hacerlo.
 */
export function despacharCola(home: string, proyecto: string, env: NodeJS.ProcessEnv): string[] {
  return conTurnoSync(turnoFile(home, proyecto, "cola"), "cola", () => {
    const lanzados: string[] = [];
    for (const { id, state } of colaDe(home, proyecto)) {
      // abort y rerun no toman este turno: un run que dejó la cola mientras tanto no se lanza.
      if (loadState(home, id).status !== "en_cola") continue;
      const r = reglas(home, state.repo);
      // Sin lugar no se toca el log: tick pasa cada pocos minutos y el run seguiría igual en cola.
      if (ocupados(home, proyecto, r).length >= r.max) break;
      const run = runPaths(home, id);
      appendEvent(run.dir, { tipo: "reanudado" });
      if (!tomarLugar(home, proyecto, id, process.pid, r).ok) {
        appendEvent(run.dir, { tipo: "encolado" });
        break;
      }
      handOver(home, loadState(home, id), run, env);
      lanzados.push(id);
    }
    return lanzados;
  });
}

/** La respuesta de un comando que lanza un run: arrancó, o en qué lugar de la cola quedó. */
export function lanzamiento(id: string, arranco: string, encolado: string, lanzado: Lanzado) {
  if (lanzado.tipo === "lanzado") return runStartedSchema.parse({ ok: true, id, accion: arranco });
  return runStartedSchema.parse({
    ok: true,
    id,
    accion: `${encolado}; en cola, ${String(lanzado.posicion)}.º: corren ${lanzado.corriendo.join(", ")}`,
    cola: { posicion: lanzado.posicion, corriendo: lanzado.corriendo },
  });
}

/** Dos runs vivos de la misma clave trabajan en la misma rama: el segundo no se crea. */
function rejectSameKey(home: string, proyecto: string, clave: string): void {
  for (const other of listRunIds(home)) {
    const state = loadState(home, other);
    if (state.proyecto !== proyecto || state.clave !== clave) continue;
    if (["cerrado", "abortado", "entregado"].includes(state.status)) continue;
    throw new UserError(
      `ya hay un run de ${clave} en ${proyecto}: ${other} está ${state.status}`,
      `flowrunner status ${other}`,
    );
  }
}

export function startRun(home: string, file: string, env: NodeJS.ProcessEnv, now: Date) {
  const checked = checkFeature(file, env);
  rejectSameKey(home, checked.project.name, checked.feature.clave);
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
  return lanzamiento(
    run.id,
    "lanzado en segundo plano",
    "creado",
    lanzarOEncolar(home, run.id, env),
  );
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
  appendEvent(runPaths(home, id).dir, { tipo: "reanudado" });
  return lanzamiento(
    id,
    `retomado en ${state.fase}`,
    `listo para retomar en ${state.fase}`,
    lanzarOEncolar(home, id, env),
  );
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
  appendEvent(runPaths(home, id).dir, { tipo: "sin_probar_aceptado", motivo: motivo.trim() });
  return lanzamiento(
    id,
    "aceptado sin probar: entregar arrancó",
    "aceptado sin probar",
    lanzarOEncolar(home, id, env),
  );
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
  appendEvent(runPaths(home, id).dir, { tipo: "rehacer", desde: from as Phase });
  return lanzamiento(
    id,
    `rehaciendo desde ${from}`,
    `listo para rehacer desde ${from}`,
    lanzarOEncolar(home, id, env),
  );
}

/** Borra los worktrees del run; las ramas quedan. */
export function removeWorktrees(run: RunPaths, repo: string): void {
  if (!existsSync(run.worktrees)) return;
  const remove = () => {
    for (const entry of readdirSync(run.worktrees)) {
      try {
        execFileSync(
          "git",
          ["-C", repo, "worktree", "remove", "--force", join(run.worktrees, entry)],
          { stdio: "ignore" },
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
  };
  try {
    conTurnoGitSync(repo, remove);
  } catch (error) {
    // Sin repo no hay turno de git, y tampoco nada que otro run pueda estar tocando.
    if (!existsSync(repo)) remove();
    else throw error;
  }
}

export function abortRun(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = loadOrExplain(home, id);
  if (state.status === "abortado") throw new UserError(`el run ${id} ya estaba abortado`);
  const run = runPaths(home, id);
  appendEvent(run.dir, { tipo: "abortado" });
  const lugar = lugarDe(home, state.proyecto, id);
  if (lugar !== undefined && lugar.pid !== process.pid && isAlive(lugar.pid)) {
    try {
      process.kill(lugar.pid, "SIGTERM");
    } catch {
      // El proceso terminó entre la lectura del lugar y la señal.
    }
  }
  removeWorktrees(run, state.repo);
  soltarLugar(home, state.proyecto, id);
  despacharCola(home, state.proyecto, env);
  return runStartedSchema.parse({ ok: true, id, accion: "abortado; las ramas quedan" });
}

/**
 * El proceso del run: confirma su lugar, avanza hasta detenerse y, salga como salga, suelta el lugar
 * y despacha la cola. Un run que espera o terminó no ocupa lugar.
 */
export async function runProcess(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = loadState(home, id);
  const run = runPaths(home, id);
  if (!tomarLugar(home, state.proyecto, id, process.pid, reglas(home, state.repo)).ok) {
    // Perdió su lugar entre el lanzamiento y el arranque: espera el próximo como cualquiera.
    appendEvent(run.dir, { tipo: "encolado" });
    return loadState(home, id);
  }
  try {
    // Setup, agentes y fixers corren con el Node del repo. Si no está instalado, verify se niega a
    // correr y el run se detiene con el motivo.
    const { deps, phases } = await productionRuntime(
      (await repoNode(state.repo, env)).env,
      (title, body) => {
        notifyMac(title, body, env);
      },
    );
    const final = await runUntilStop(run, phases, deps);
    // El informe se escribe siempre al terminar el proceso: completo o parcial si se detuvo.
    writeReport(run, readLog(run.dir).events);
    return final;
  } finally {
    soltarLugar(home, state.proyecto, id);
    despacharCola(home, state.proyecto, env);
  }
}
