// Lo que `resume` chequea antes de commitear un arreglo a mano (`fix --yo`, ADR 0023).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "../git/git.ts";
import { checkSecrets } from "../tripwires/rules.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Lo que impide commitear un arreglo a mano: algo dentro de `.git` (también un repo git embebido), un
 * test bloqueado distinto de su hash o un secreto agregado. Nada más: las rutas protegidas
 * (`ALWAYS_PROTECTED`) protegen de los agentes, no de la persona, y arreglar a mano un `CLAUDE.md`,
 * como en VF-6, es para lo que existe `fix --yo`. Tampoco aplica el alcance de ninguna sub-task.
 *
 * `changes` es lo que no se commiteó, leído del worktree; `committed`, lo que la persona commiteó
 * por su cuenta, commit por commit (`commitChanges`), con las líneas que trae cada uno.
 */
export function manualChangeProblems(
  root: string,
  changes: readonly FileChange[],
  locked: Readonly<Record<string, string>>,
  runId: string,
  committed: readonly FileChange[] = [],
): string[] {
  const problems = new Set<string>();
  const all = [
    ...committed.map((c) => ({ ...c, fromDisk: false })),
    ...changes.map((c) => ({ ...c, fromDisk: true })),
  ];
  for (const change of all) {
    // Git lista un repo embebido sin seguir como su carpeta, con la barra: `git add -A` lo commitearía
    // como gitlink, con lo que tenga adentro sin chequear.
    if (change.status === "agregado" && change.path.endsWith("/")) {
      problems.add(`${change.path} es un repositorio git adentro del worktree: no se commitea`);
      continue;
    }
    // Lo que no se pudo leer no se pudo chequear: no pasa. Lo commiteado trae sus líneas del commit.
    const file = join(root, change.path);
    if (
      change.fromDisk &&
      change.status === "agregado" &&
      !(existsSync(file) && statSync(file).isFile())
    ) {
      problems.add(`${change.path} no se pudo leer para chequearlo: no se commitea`);
      continue;
    }
    if (change.path.split("/").includes(".git")) {
      problems.add(`${change.path} es parte de .git: no se commitea`);
      continue;
    }
    const hash = locked[change.path];
    if (hash !== undefined) {
      const now = existsSync(file) ? sha256(readFileSync(file, "utf8")) : undefined;
      if (now !== hash) {
        problems.add(
          `${change.path} es un test bloqueado del plan: si tiene que cambiar, replanificá con flowrunner rerun ${runId} --desde planificar`,
        );
        continue;
      }
    }
    const secret = checkSecrets(change.path, change.added);
    if (!secret.ok) problems.add(secret.motivo);
  }
  return [...problems];
}
