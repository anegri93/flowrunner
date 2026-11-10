// El código que un replan conserva, sobre git (ADR 0024). Antes de la sesión del planificador, la rama
// se rearma con todas las sub-tasks ya integradas; después, solo con las que el plan conserva. La punta
// vieja queda apuntada por una ref hasta que el plan pasa el gate, así un intento rechazado o cortado
// a mitad de camino retoma desde el mismo punto.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Candidata, ConservaInput } from "../gates/conserva.ts";
import type { Plan, Subtask } from "../gates/plan.ts";
import {
  changesSince,
  cherryPick,
  conTurnoGit,
  fileAt,
  git,
  GitError,
  headSha,
  resetHard,
} from "../git/git.ts";
import { callersOf } from "../gates/llamadores.ts";
import { GraftError, llamadoresDe } from "../graft/contexto.ts";
import type { PhaseContext, RunPaths } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { isTestFile } from "../tripwires/rules.ts";

export const SUBTASK_TRAILER = "Flowrunner-Subtask";
export const MANUAL_TRAILER = "Flowrunner-Manual";
const RUN_TRAILER = "Flowrunner-Run";

/** La ref que mantiene viva la punta de antes del replan: un `gc` no se lleva sus commits. */
export const refAnterior = (run: RunPaths) => `refs/flowrunner/${run.id}/anterior`;
const candidatasFile = (run: RunPaths) => join(run.dir, "candidatas.json");

export interface Rama {
  readonly subtasks: readonly Candidata[];
  /** Los commits de «lo arreglo yo», en orden. No son sub-tasks: se aplican siempre, al final. */
  readonly manuales: readonly string[];
}

const SIN_RAMA: Rama = { subtasks: [], manuales: [] };

/**
 * Los commits de base..HEAD con su trailer de sub-task o de arreglo manual, en orden. Un commit sin
 * ningún trailer de flowrunner es de la persona (`resume` acepta los que hizo por su cuenta durante
 * `fix --yo`): va con los manuales. Solo se descarta lo que flowrunner commiteó sin ser una sub-task,
 * como los tests del plan, que el plan nuevo reescribe.
 */
export async function commitsDeLaRama(
  worktree: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<Rama> {
  const trailer = (key: string) => `%(trailers:key=${key},valueonly,separator=%x2C)`;
  const out = await git(
    worktree,
    [
      "log",
      "--reverse",
      `--format=%H%x09${trailer(SUBTASK_TRAILER)}%x09${trailer(MANUAL_TRAILER)}%x09${trailer(RUN_TRAILER)}`,
      `${base}..HEAD`,
    ],
    env,
  );
  const byId = new Map<string, string[]>();
  const manuales: string[] = [];
  for (const line of out.split("\n").filter((l) => l !== "")) {
    const [sha = "", subtask = "", manual = "", runId = ""] = line.split("\t");
    const id = subtask.split(",")[0]?.trim() ?? "";
    if (id !== "") byId.set(id, [...(byId.get(id) ?? []), sha]);
    else if (manual.trim() !== "" || runId.trim() === "") manuales.push(sha);
  }
  return { subtasks: [...byId].map(([id, shas]) => ({ id, shas })), manuales };
}

export interface Rearmado {
  /** Los SHAs nuevos de cada candidata que entró, en orden. */
  readonly nuevos: Record<string, string[]>;
  readonly chocaron: string[];
  readonly manualesDescartados: string[];
}

/** Reaplica sobre `base` los commits pedidos; devuelve los SHAs nuevos por id y lo que chocó. */
export async function rearmar(
  worktree: string,
  base: string,
  subtasks: readonly Candidata[],
  manuales: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Rearmado> {
  await resetHard(worktree, base, env);
  const nuevos: Record<string, string[]> = {};
  const chocaron: string[] = [];
  for (const c of subtasks) {
    const before = await headSha(worktree, env);
    const shas: string[] = [];
    for (const sha of c.shas) {
      const picked = await cherryPick(worktree, sha, env);
      if (!picked.ok) break;
      shas.push(picked.sha);
    }
    if (shas.length === c.shas.length) nuevos[c.id] = shas;
    else {
      // Una sub-task entra entera o no entra: sus commits de antes del choque se sacan.
      await resetHard(worktree, before, env);
      chocaron.push(c.id);
    }
  }
  const manualesDescartados: string[] = [];
  for (const sha of manuales) {
    if (!(await cherryPick(worktree, sha, env)).ok) manualesDescartados.push(sha);
  }
  return { nuevos, chocaron, manualesDescartados };
}

/** Lo que dependía, directa o indirectamente, de alguna de `ids`. */
function dependents(tasks: readonly Subtask[], ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) {
      if (!out.has(t.id) && t.depende_de.some((d) => out.has(d))) {
        out.add(t.id);
        grew = true;
      }
    }
  }
  return out;
}

export interface Reaplicado {
  /** Las candidatas que quedaron en la rama. */
  readonly candidatas: Candidata[];
  readonly nuevos: Record<string, string[]>;
}

/**
 * `rearmar`, y si una candidata choca, la saca junto con lo que depende de ella (según `tareas`) y
 * vuelve a rearmar sin ellas: lo que queda en la rama es exactamente lo que devuelve. Avisa cada
 * sub-task que se va a reimplementar y cada arreglo a mano descartado, una sola vez por `avisados`.
 */
export async function reaplicar(
  worktree: string,
  base: string,
  rama: Rama,
  tareas: readonly Subtask[],
  env: NodeJS.ProcessEnv,
  emit: PhaseContext["emit"],
  avisados: Set<string> = new Set(),
): Promise<Reaplicado> {
  const aviso = (key: string, texto: string) => {
    if (avisados.has(key)) return;
    avisados.add(key);
    emit({ tipo: "aviso", fase: "planificar", texto });
  };
  let candidatas = [...rama.subtasks];
  for (;;) {
    const r = await rearmar(worktree, base, candidatas, rama.manuales, env);
    for (const id of r.chocaron)
      aviso(id, `${id} no se pudo reaplicar sobre la base: se va a reimplementar`);
    const fuera = dependents(tareas, new Set(r.chocaron));
    const arrastradas = candidatas.filter((c) => fuera.has(c.id) && !r.chocaron.includes(c.id));
    for (const c of arrastradas)
      aviso(
        c.id,
        `${c.id} depende de una sub-task que no se pudo reaplicar: se va a reimplementar`,
      );
    candidatas = candidatas.filter((c) => !fuera.has(c.id));
    // Lo que chocó ya quedó afuera de la rama; lo que dependía de eso entró, y se rearma sin ello.
    if (arrastradas.length > 0) continue;
    for (const sha of r.manualesDescartados)
      aviso(
        `manual:${sha}`,
        `el arreglo a mano ${sha.slice(0, 7)} no se pudo reaplicar sobre la base y se descartó: con \`git cherry-pick ${sha}\` en el worktree se recupera`,
      );
    return { candidatas, nuevos: r.nuevos };
  }
}

const candidatasSchema = z.object({
  /** La posición del `preparado` en el log: otra preparación es otra rama, y esto no vale. */
  preparado: z.int(),
  base: z.string(),
  /** La punta de antes del replan, a la que apunta `refAnterior`. */
  anterior: z.string(),
  subtasks: z.array(z.object({ id: z.string(), shas: z.array(z.string()) })),
  manuales: z.array(z.string()),
  /**
   * Los pedidos y el motivo con que empezó el replan, para la regla (c): el engine reemplaza la
   * instrucción por el motivo del gate en cada reintento, y el motivo del `rerun` se perdería.
   */
  textos: z.array(z.string()),
  /** Cuántos eventos tenía el log al guardarlo: si después corrió otra fase, la rama ya es otra. */
  log: z.int(),
});
type CandidatasFile = z.infer<typeof candidatasSchema>;

async function refSha(worktree: string, ref: string, env: NodeJS.ProcessEnv) {
  try {
    return await git(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env);
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/** La preparación vigente: otra preparación (`rerun --desde preparar`) es otra rama. */
const preparadoEn = (events: readonly RunEvent[]) =>
  events.findLastIndex((e) => e.tipo === "preparado");

/**
 * Las candidatas que dejó un intento anterior de este replan, si siguen valiendo: la misma preparación
 * y la misma base, la ref en pie, y ninguna otra fase ni arreglo a mano en el medio.
 */
async function guardadas(
  run: RunPaths,
  worktree: string,
  events: readonly RunEvent[],
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<CandidatasFile | undefined> {
  if (!existsSync(candidatasFile(run))) return undefined;
  let data: CandidatasFile;
  try {
    data = candidatasSchema.parse(JSON.parse(readFileSync(candidatasFile(run), "utf8")));
  } catch {
    return undefined;
  }
  if (data.preparado !== preparadoEn(events) || data.base !== base) return undefined;
  const otraFase = events
    .slice(data.log)
    .some(
      (e) =>
        (e.tipo === "accion_iniciada" && e.fase !== "planificar") ||
        e.tipo === "arreglo_manual_iniciado" ||
        e.tipo === "arreglo_manual",
    );
  if (otraFase) return undefined;
  return (await refSha(worktree, refAnterior(run), env)) === data.anterior ? data : undefined;
}

export interface RamaAnterior extends Rama {
  /** Los textos de la regla (c): los de cuando empezó el replan, más los de este intento. */
  readonly textos: readonly string[];
}

/**
 * Lo que había en la rama antes de este replan. Si un intento anterior ya lo guardó (un gate
 * rechazado, o un corte a mitad del rearmado), es eso: la rama de ahora ya no lo tiene entero. Si no,
 * sale de git, y la punta queda apuntada por `refAnterior` antes de tocar nada.
 */
export async function ramaAnterior(
  run: RunPaths,
  worktree: string,
  events: readonly RunEvent[],
  base: string,
  /** Los pedidos de cambios y el motivo de este intento. */
  textos: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RamaAnterior> {
  const saved = await guardadas(run, worktree, events, base, env);
  if (saved !== undefined)
    return {
      subtasks: saved.subtasks,
      manuales: saved.manuales,
      textos: [...new Set([...saved.textos, ...textos])],
    };
  const rama = await commitsDeLaRama(worktree, base, env);
  if (rama.subtasks.length === 0 && rama.manuales.length === 0) {
    await soltarAnterior(run, worktree, env);
    return { ...SIN_RAMA, textos };
  }
  const anterior = await headSha(worktree, env);
  await conTurnoGit(worktree, () => git(worktree, ["update-ref", refAnterior(run), anterior], env));
  const data: CandidatasFile = {
    preparado: preparadoEn(events),
    base,
    anterior,
    subtasks: rama.subtasks.map((c) => ({ id: c.id, shas: [...c.shas] })),
    manuales: [...rama.manuales],
    textos: [...textos],
    log: events.length,
  };
  writeFileSync(candidatasFile(run), `${JSON.stringify(data, null, 2)}\n`);
  return { ...rama, textos };
}

/**
 * El contenido de `path` en la punta de antes del replan, si su ref sigue en pie. Un intento cortado en
 * pleno rearmado dejó el worktree sin los tests del plan anterior; la punta vieja los tiene.
 */
export async function enAnterior(
  run: RunPaths,
  worktree: string,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if ((await refSha(worktree, refAnterior(run), env)) === undefined) return undefined;
  return fileAt(worktree, refAnterior(run), path, env);
}

/** El plan pasó el gate: la punta vieja y las candidatas ya no hacen falta. */
export async function soltarAnterior(
  run: RunPaths,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  rmSync(candidatasFile(run), { force: true });
  if ((await refSha(worktree, refAnterior(run), env)) !== undefined)
    await conTurnoGit(worktree, () => git(worktree, ["update-ref", "-d", refAnterior(run)], env));
}

/**
 * Corre `fn`, que rearma la rama, sin perder los tests que escribió el planificador desde `desde`:
 * se guardan antes, con su contenido, y se vuelven a escribir (o a borrar) después.
 */
export async function conLosTests<T>(
  worktree: string,
  desde: string,
  testGlobs: readonly string[],
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
): Promise<T> {
  const tests = (await changesSince(worktree, desde, env))
    .filter((c) => isTestFile(testGlobs, c.path))
    .map((c) => ({
      path: c.path,
      content: c.status === "borrado" ? undefined : readFileSync(join(worktree, c.path)),
    }));
  const result = await fn();
  for (const t of tests) {
    const file = join(worktree, t.path);
    if (t.content === undefined) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, t.content);
    }
  }
  return result;
}

/**
 * Los llamadores de cada `simbolo` que el plan cambia, para la regla (d) de `checkConserva`. Si graft
 * no puede responder, ese símbolo va a `sinLlamadores`: no saber quién lo llama no es «nadie».
 */
export async function llamadoresDelPlan(
  plan: Pick<Plan, "cambia_lo_existente">,
  worktree: string,
  indexDir: string,
  /** Por qué el índice no está al día, si no lo está. */
  sinIndice: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly llamadores: Map<string, string[]>;
  readonly sinLlamadores: Map<string, string>;
}> {
  const llamadores = new Map<string, string[]>();
  const sinLlamadores = new Map<string, string>();
  const simbolos = new Set(
    plan.cambia_lo_existente.flatMap((c) =>
      c.simbolo === undefined || c.simbolo.trim() === "" ? [] : [c.simbolo.trim()],
    ),
  );
  for (const simbolo of simbolos) {
    if (sinIndice !== undefined) {
      sinLlamadores.set(simbolo, sinIndice);
      continue;
    }
    try {
      // graft no ve una llamada a través de una variable sin tipo (CUENTAS-1): grep, como el gate de
      // llamadores, completa la unión. Lo conservador es la unión.
      const porGraft = await llamadoresDe(worktree, indexDir, simbolo, env);
      const porTexto = await callersOf(simbolo, worktree, env);
      llamadores.set(simbolo, [...new Set([...porGraft, ...porTexto])].sort());
    } catch (error) {
      if (!(error instanceof GraftError)) throw error;
      sinLlamadores.set(simbolo, error.message);
    }
  }
  return { llamadores, sinLlamadores };
}

/** Lo que se sabe al abrir la sesión para decidir el `conserva` de un plan (ADR 0024). */
export interface BaseConserva {
  /** Las sub-tasks del plan anterior. */
  readonly anteriores: readonly Subtask[];
  /** Las candidatas que están en la rama al abrir la sesión. */
  readonly candidatas: readonly Candidata[];
  /** Los textos de la regla (c). */
  readonly pedidos: readonly string[];
  readonly worktree: string;
  readonly indexDir: string;
  /** Por qué el índice no está al día, si no lo está. */
  readonly sinIndice: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * El `ConservaInput` de un plan, o undefined si no conserva nada. Lo usan el gate y `validar_plan`, sobre
 * el mismo worktree, así no pueden divergir. Solo lee: git grep y el índice de graft, sin refrescarlo.
 */
export async function conservaDelPlan(
  plan: Pick<Plan, "subtareas" | "cambia_lo_existente">,
  base: BaseConserva,
): Promise<ConservaInput | undefined> {
  if (!plan.subtareas.some((t) => t.conserva === true)) return undefined;
  return {
    plan,
    anteriores: base.anteriores,
    candidatas: base.candidatas,
    pedidos: base.pedidos,
    ...(await llamadoresDelPlan(plan, base.worktree, base.indexDir, base.sinIndice, base.env)),
  };
}
