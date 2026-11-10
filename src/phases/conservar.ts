// El código que un replan conserva, sobre git (ADR 0024). Antes de la sesión del planificador, la rama
// se rearma con todas las sub-tasks ya integradas; después, solo con las que el plan conserva. La punta
// vieja queda apuntada por una ref hasta que el plan pasa el gate, así un intento rechazado o cortado
// a mitad de camino retoma desde el mismo punto.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Candidata } from "../gates/conserva.ts";
import type { Subtask } from "../gates/plan.ts";
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
import type { PhaseContext, RunPaths } from "../runner/types.ts";
import { isTestFile } from "../tripwires/rules.ts";

export const SUBTASK_TRAILER = "Flowrunner-Subtask";
export const MANUAL_TRAILER = "Flowrunner-Manual";

/** La ref que mantiene viva la punta de antes del replan: un `gc` no se lleva sus commits. */
export const refAnterior = (run: RunPaths) => `refs/flowrunner/${run.id}/anterior`;
const candidatasFile = (run: RunPaths) => join(run.dir, "candidatas.json");

export interface Rama {
  readonly subtasks: readonly Candidata[];
  /** Los commits de «lo arreglo yo», en orden. No son sub-tasks: se aplican siempre, al final. */
  readonly manuales: readonly string[];
}

const SIN_RAMA: Rama = { subtasks: [], manuales: [] };

/** Los commits de base..HEAD con su trailer de sub-task o de arreglo manual, en orden. */
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
      `--format=%H%x09${trailer(SUBTASK_TRAILER)}%x09${trailer(MANUAL_TRAILER)}`,
      `${base}..HEAD`,
    ],
    env,
  );
  const byId = new Map<string, string[]>();
  const manuales: string[] = [];
  for (const line of out.split("\n").filter((l) => l !== "")) {
    const [sha = "", subtask = "", manual = ""] = line.split("\t");
    const id = subtask.split(",")[0]?.trim() ?? "";
    if (id !== "") byId.set(id, [...(byId.get(id) ?? []), sha]);
    else if (manual.trim() !== "") manuales.push(sha);
    // Lo demás, como el commit de los tests del plan, lo reescribe el plan nuevo.
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

/** Las candidatas que dejó un intento anterior de esta misma preparación, si su ref sigue en pie. */
async function guardadas(
  run: RunPaths,
  worktree: string,
  donde: { readonly preparado: number; readonly base: string },
  env: NodeJS.ProcessEnv,
): Promise<CandidatasFile | undefined> {
  if (!existsSync(candidatasFile(run))) return undefined;
  let data: CandidatasFile;
  try {
    data = candidatasSchema.parse(JSON.parse(readFileSync(candidatasFile(run), "utf8")));
  } catch {
    return undefined;
  }
  if (data.preparado !== donde.preparado || data.base !== donde.base) return undefined;
  return (await refSha(worktree, refAnterior(run), env)) === data.anterior ? data : undefined;
}

/**
 * Lo que había en la rama antes de este replan. Si un intento anterior ya lo guardó (un gate
 * rechazado, o un corte a mitad del rearmado), es eso: la rama de ahora ya no lo tiene entero. Si no,
 * sale de git, y la punta queda apuntada por `refAnterior` antes de tocar nada.
 */
export async function ramaAnterior(
  run: RunPaths,
  worktree: string,
  donde: { readonly preparado: number; readonly base: string },
  env: NodeJS.ProcessEnv,
): Promise<Rama> {
  const saved = await guardadas(run, worktree, donde, env);
  if (saved !== undefined) return { subtasks: saved.subtasks, manuales: saved.manuales };
  const rama = await commitsDeLaRama(worktree, donde.base, env);
  if (rama.subtasks.length === 0 && rama.manuales.length === 0) {
    await soltarAnterior(run, worktree, env);
    return SIN_RAMA;
  }
  const anterior = await headSha(worktree, env);
  await conTurnoGit(worktree, () => git(worktree, ["update-ref", refAnterior(run), anterior], env));
  const data: CandidatasFile = {
    ...donde,
    anterior,
    subtasks: rama.subtasks.map((c) => ({ id: c.id, shas: [...c.shas] })),
    manuales: [...rama.manuales],
  };
  writeFileSync(candidatasFile(run), `${JSON.stringify(data, null, 2)}\n`);
  return rama;
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
