// Los comandos que lanzan y operan runs: run, status, resume, fix, accept, rerun, abort y el proceso
// `_run`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { offers, offersFix, reduce, stateOf, type RunState } from "../engine/engine.ts";
import { changesSince, commitAll, headSha } from "../git/git.ts";
import { avisoDeEstado, cambiosDelPlan } from "../notify/estado.ts";
import { notifyMac } from "../notify/notify.ts";
import { productionRuntime } from "../runner/production.ts";
import { writeReport } from "../report/report.ts";
import { runUntilStop } from "../runner/runner.ts";
import type { RunPaths } from "../runner/types.ts";
import { prepared } from "../phases/inputs.ts";
import { readPlan } from "../phases/planificar.ts";
import { PHASES, type Origen, type Phase, type RunEvent } from "../store/events.ts";
import { loadRepoConfig } from "../config/load.ts";
import { ConfigError, MAX_RUNS_DEFAULT } from "../config/schemas.ts";
import { conTurnoGitSync } from "../git/git.ts";
import { isAlive } from "../store/lock.ts";
import { lugarDe, ocupados, soltarLugar, tomarLugar, type Reglas } from "../store/lugares.ts";
import { repoNode } from "../proc/node.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { colaDe, createRun, listRunIds, loadState, ocupaLugar, runPaths } from "../store/runs.ts";
import { conTurno, conTurnoSync, turnoFile } from "../store/turno.ts";
import {
  runStartedSchema,
  statusListSchema,
  statusRunSchema,
  steps,
  summarize,
} from "./contracts.ts";
import { checkFeature } from "./feature-check.ts";
import { manualChangeProblems } from "./manual.ts";
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
      avisarCambio(home, id, "en_cola", env);
      lanzados.push(id);
    }
    return lanzados;
  });
}

/**
 * Avisa el cambio de estado de un run que pasó sin que la persona lo pida: salir de la cola, volver
 * de una pausa. Lo que pide ella con un comando se lo dice la respuesta del comando.
 */
export function avisarCambio(
  home: string,
  id: string,
  antes: RunState["status"],
  env: NodeJS.ProcessEnv,
): void {
  const run = runPaths(home, id);
  const { events } = readLog(run.dir);
  const aviso = avisoDeEstado(antes, stateOf(events), {
    events,
    cambiosExistentes: cambiosDelPlan(run),
  });
  if (aviso !== undefined) notifyMac(aviso.title, aviso.body, env);
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
      vueltas: checked.repoConfig.vueltas,
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

export async function resumeRun(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = loadOrExplain(home, id);
  if (isRunning(home, state))
    throw new UserError(`el run ${id} ya está corriendo`, `flowrunner status ${id}`);
  if (state.status === "detenido" && state.aMano) return resumeByHand(home, id, env);
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
 * Retomar después de `fix --yo`: commitea lo que la persona cambió en el worktree de la feature y
 * vuelve a verificar. Si el cambio toca `.git`, cambia un test bloqueado o agrega un secreto, no
 * commitea ni escribe nada (ADR 0023).
 */
async function resumeByHand(home: string, id: string, env: NodeJS.ProcessEnv) {
  const run = runPaths(home, id);
  const { worktree } = prepared(readLog(run.dir).events);
  // Con el turno de las respuestas: dos `resume` a la vez no commitean ni escriben dos veces.
  const answer = await conTurno(answerTurno(home, id), id, async () => {
    if (!loadState(home, id).aMano) {
      throw new UserError(`el run ${id} ya retomó tu arreglo a mano`, `flowrunner status ${id}`);
    }
    const changes = await changesSince(worktree, await headSha(worktree, env), env);
    const problems = manualChangeProblems(worktree, changes, readPlan(run).locked, id);
    if (problems.length > 0) {
      throw new UserError(
        `tu arreglo a mano no se commitea:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        `corregilo en ${worktree} y volvé a correr: flowrunner resume ${id}`,
      );
    }
    const committed =
      changes.length === 0
        ? null
        : ((await commitAll(worktree, "fix: arreglo a mano", { "Flowrunner-Manual": id }, env)) ??
          null);
    return appendEvent(run.dir, { tipo: "arreglo_manual", sha: committed });
  });
  const sha = answer.tipo === "arreglo_manual" ? answer.sha : null;
  return launchAnswer(
    home,
    id,
    answer,
    sha === null
      ? "sin cambios que commitear: verificar arrancó"
      : "tu arreglo commiteado: verificar arrancó",
    sha === null ? "sin cambios que commitear" : "tu arreglo commiteado",
    env,
  );
}

/**
 * Lanza el run después de la respuesta de la persona. Si el engine no la tomó, porque otro comando
 * (un `rerun`, un `abort`) escribió antes, no hay nada que lanzar: se dice, en vez de contestar que
 * arrancó.
 */
function launchAnswer(
  home: string,
  id: string,
  answer: RunEvent,
  arranco: string,
  encolado: string,
  env: NodeJS.ProcessEnv,
) {
  const { events } = readLog(runPaths(home, id).dir);
  const at = events.findIndex((e) => JSON.stringify(e) === JSON.stringify(answer));
  const before = stateOf(events.slice(0, Math.max(at, 0)));
  const after = stateOf(events);
  if (at < 0 || reduce(before, answer) === before || after.status !== "en_curso") {
    throw new UserError(
      `el run ${id} no tomó tu respuesta: otra llegó antes, y está ${after.status} en ${after.fase}`,
      `flowrunner status ${id}`,
    );
  }
  return lanzamiento(id, arranco, encolado, lanzarOEncolar(home, id, env));
}

/**
 * El turno en que una respuesta de la persona se valida y se escribe: uno propio del run, así dos
 * respuestas a la vez no se validan contra el mismo halt (ADR 0023). No es el de la cola: `resume`
 * lo tiene mientras commitea, y la cola del proyecto no espera a git.
 */
const answerTurno = (home: string, id: string) => join(runPaths(home, id).dir, "respuesta.turno");

function requireOffered(state: RunState, id: string, offered: boolean): void {
  if (offered) return;
  const opciones = state.status === "detenido" ? (state.halt?.opciones ?? []) : [];
  throw new UserError(
    `el run ${id} no ofrece eso ahora (está ${state.status} en ${state.fase})${opciones.length === 0 ? "" : `. Ofrece:\n${opciones.map((o) => `  ${o.comando}`).join("\n")}`}`,
    `flowrunner status ${id}`,
  );
}

/**
 * Una respuesta a la pregunta de un run detenido: que unas sub-tasks lo corrijan con tu instrucción,
 * o, con `yo`, arreglarlo a mano en el worktree y retomarlo con `resume`.
 */
export function fixRun(
  home: string,
  id: string,
  opts: {
    readonly unidades: readonly string[];
    readonly instruccion: string | undefined;
    readonly yo: boolean;
    readonly origen: Origen;
  },
  env: NodeJS.ProcessEnv,
) {
  loadOrExplain(home, id);
  const run = runPaths(home, id);
  if (opts.yo && opts.unidades.length > 0)
    throw new UserError("--yo y --unidad no van juntos: elegí una", `flowrunner status ${id}`);
  if (opts.yo) {
    const worktree = conTurnoSync(answerTurno(home, id), id, () => {
      const state = loadState(home, id);
      requireOffered(state, id, offers(state, `flowrunner fix ${id} --yo`));
      const events = readLog(run.dir).events;
      if (!events.some((e) => e.tipo === "preparado"))
        throw new UserError("el run todavía no tiene worktree", `flowrunner status ${id}`);
      appendEvent(run.dir, { tipo: "arreglo_manual_iniciado", origen: opts.origen });
      return prepared(events).worktree;
    });
    return runStartedSchema.parse({
      ok: true,
      id,
      accion: `editá ${worktree} y después: flowrunner resume ${id}`,
    });
  }
  const unidades = [...new Set(opts.unidades)];
  if (unidades.length === 0) {
    throw new UserError(
      "falta la sub-task: --unidad ST-n, o --yo para arreglarlo vos",
      `flowrunner status ${id}`,
    );
  }
  const instruccion = opts.instruccion?.trim() ?? "";
  const answer = conTurnoSync(answerTurno(home, id), id, () => {
    const state = loadState(home, id);
    requireOffered(state, id, offersFix(state, unidades));
    if (instruccion === "") {
      throw new UserError(
        "falta la instrucción: qué tiene que cambiar",
        `flowrunner fix ${id} --unidad ${unidades[0] ?? "ST-n"} "<qué cambiar>"`,
      );
    }
    if (isRunning(home, state))
      throw new UserError(`el run ${id} ya está corriendo`, `flowrunner status ${id}`);
    return appendEvent(run.dir, {
      tipo: "arreglo_pedido",
      unidades,
      instruccion,
      origen: opts.origen,
    });
  });
  return launchAnswer(home, id, answer, `arreglando ${unidades.join(", ")}`, "arreglo pedido", env);
}

/**
 * Seguir a la fase siguiente con la fase detenida en rojo. Es una decisión de la persona y queda en
 * el informe y en la PR con su motivo: sin motivo no se acepta (ADR 0023).
 */
export function acceptRun(
  home: string,
  id: string,
  motivo: string | undefined,
  origen: Origen,
  env: NodeJS.ProcessEnv,
) {
  loadOrExplain(home, id);
  const run = runPaths(home, id);
  const answer = conTurnoSync(answerTurno(home, id), id, () => {
    const state = loadState(home, id);
    requireOffered(state, id, offers(state, `flowrunner accept ${id} `));
    if (motivo === undefined || motivo.trim() === "") {
      throw new UserError(
        "falta el motivo: por qué seguir así",
        `flowrunner accept ${id} "<por qué>"`,
      );
    }
    if (isRunning(home, state))
      throw new UserError(`el run ${id} ya está corriendo`, `flowrunner status ${id}`);
    return appendEvent(run.dir, {
      tipo: "aceptado",
      fase: state.fase,
      motivo: motivo.trim(),
      origen,
    });
  });
  const next = loadState(home, id).fase;
  return launchAnswer(
    home,
    id,
    answer,
    `aceptado: ${next} arrancó`,
    `aceptado: sigue en ${next}`,
    env,
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
  if (state.status === "detenido" && state.aMano) throw pendingByHand(id);
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
  // Rehacer sobre un arreglo a mano sin commitear verificaría ese cambio y entregaría la rama sin él.
  if (state.status === "detenido" && state.aMano && hasUncommitted(home, id))
    throw pendingByHand(id);
  appendEvent(runPaths(home, id).dir, { tipo: "rehacer", desde: from as Phase });
  return lanzamiento(
    id,
    `rehaciendo desde ${from}`,
    `listo para rehacer desde ${from}`,
    lanzarOEncolar(home, id, env),
  );
}

/** El error de un comando que perdería un arreglo a mano todavía sin commitear. */
function pendingByHand(id: string): UserError {
  return new UserError(
    `el run ${id} espera tu arreglo a mano, sin commitear: commitealo y seguí con resume, o descartá esos cambios del worktree antes`,
    `flowrunner resume ${id}`,
  );
}

/** Si el worktree de la feature tiene cambios sin commitear. Sin worktree, no tiene. */
function hasUncommitted(home: string, id: string): boolean {
  const events = readLog(runPaths(home, id).dir).events;
  if (!events.some((e) => e.tipo === "preparado")) return false;
  const { worktree } = prepared(events);
  if (!existsSync(worktree)) return false;
  try {
    return (
      execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== ""
    );
  } catch {
    // Sin poder mirarlo, se trata como sucio: es lo que no pierde el arreglo.
    return true;
  }
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
    avisarCambio(home, id, state.status, env);
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
