// El doble control: las mismas reglas del hook sobre el diff real del worktree. Un comando permitido,
// como un test, puede escribir archivos por su cuenta; esto lo ve antes del commit.
import type { FileChange } from "../git/git.ts";
import { checkContent, checkWritePath, type Scope } from "./rules.ts";

export interface Violation {
  readonly path: string;
  readonly motivo: string;
}

export function checkChanges(scope: Scope, changes: readonly FileChange[]): Violation[] {
  const violations: Violation[] = [];
  for (const change of changes) {
    const path = checkWritePath(scope, change.path);
    if (!path.ok) {
      violations.push({ path: change.path, motivo: path.motivo });
      continue;
    }
    const content = checkContent(scope, change.path, change.added);
    if (!content.ok) violations.push({ path: change.path, motivo: content.motivo });
  }
  return violations;
}

export function describeViolations(violations: readonly Violation[]): string {
  return `el diff rompe las reglas:\n${violations.map((v) => `- ${v.motivo}`).join("\n")}`;
}
