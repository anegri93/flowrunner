// Lo que `resume` chequea antes de commitear un arreglo a mano (`fix --yo`, ADR 0023).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "../git/git.ts";
import { checkSecrets } from "../tripwires/rules.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Lo que impide commitear un arreglo a mano: algo dentro de `.git`, un test bloqueado distinto de su
 * hash o un secreto agregado. Nada más: las rutas protegidas (`ALWAYS_PROTECTED`) protegen de los
 * agentes, no de la persona, y arreglar a mano un `CLAUDE.md`, como en VF-6, es para lo que existe
 * `fix --yo`. Tampoco aplica el alcance de ninguna sub-task.
 */
export function manualChangeProblems(
  root: string,
  changes: readonly FileChange[],
  locked: Readonly<Record<string, string>>,
  runId: string,
): string[] {
  const problems: string[] = [];
  for (const change of changes) {
    if (change.path.split("/").includes(".git")) {
      problems.push(`${change.path} es parte de .git: no se commitea`);
      continue;
    }
    const hash = locked[change.path];
    if (hash !== undefined) {
      const file = join(root, change.path);
      const now = existsSync(file) ? sha256(readFileSync(file, "utf8")) : undefined;
      if (now !== hash) {
        problems.push(
          `${change.path} es un test bloqueado del plan: si tiene que cambiar, replanificá con flowrunner rerun ${runId} --desde planificar`,
        );
        continue;
      }
    }
    const secret = checkSecrets(change.path, change.added);
    if (!secret.ok) problems.push(secret.motivo);
  }
  return problems;
}
