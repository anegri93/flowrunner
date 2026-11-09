// Lo que un run cambia de lo que ya existía en la base. El planificador lo declara en
// `cambia_lo_existente`; esto lo detecta en el diff, para que el aviso no dependa de que lo diga.
// Un test existente que cambia es la señal más confiable de que cambia un comportamiento: es lo que lo
// fijaba.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "../git/git.ts";
import { git } from "../git/git.ts";
import { isTestFile } from "../tripwires/rules.ts";
import type { CambioExistente, Subtask } from "./plan.ts";

/** Los tests que el diff modifica o borra. Contra la base, son tests que ya existían. */
export function testsTouched(changes: readonly FileChange[], testGlobs: readonly string[]) {
  return changes
    .filter((c) => c.status !== "agregado" && isTestFile(testGlobs, c.path))
    .map((c) => c.path);
}

/** Los tests existentes que una sub-task nombra uno por uno en su alcance: el plan le da permiso de reescribirlos. */
export function testsInScope(
  subtareas: readonly Subtask[],
  worktree: string,
  testGlobs: readonly string[],
): string[] {
  return subtareas.flatMap((t) =>
    t.alcance
      .map((a) => a.replace(/^\.\//, ""))
      .filter((a) => isTestFile(testGlobs, a))
      .filter((a) => existsSync(join(worktree, a)) && statSync(join(worktree, a)).isFile()),
  );
}

/** Las rutas que no aparecen en el `donde` de ningún cambio declarado. */
export function undeclared(paths: readonly string[], declared: readonly CambioExistente[]) {
  return [...new Set(paths)].filter((p) => !declared.some((c) => c.donde.includes(p)));
}

/** De `paths`, las que existían en `sha`. */
export async function existedAt(
  worktree: string,
  sha: string,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await git(worktree, ["ls-tree", "-r", "--name-only", sha, "--", ...paths], env);
  const there = new Set(out.split("\n").filter((l) => l !== ""));
  return paths.filter((p) => there.has(p));
}

export const AVISO_TEST_EXISTENTE = "test existente cambiado: ";
