// El lint en modo arreglar y el formateador del repo sobre los tests de aceptación. Los tests quedan
// bloqueados byte a byte y ninguna sub-task los puede tocar: si no se arreglan con las herramientas
// del repo, un `let` que debía ser `const` o una línea larga dejan verify en rojo sin salida, como en
// VF-1 y VF-4. Lo usan planificar, antes de bloquearlos, y verificar, sobre los ya bloqueados.
import { shellQuote } from "../agent/env.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { runShell, tail } from "../proc/proc.ts";

export const FIX_TIMEOUT_MS = 5 * 60_000;

/** Lo que salió mal de una herramienta, para el motivo: su comando, su código y el final de la salida. */
export interface FixerFailure {
  readonly falla: string;
  readonly detalle: string;
}

/** Corre el lint en modo arreglar y después el formateador sobre `paths`; devuelve los que fallaron. */
export async function runFixers(
  worktree: string,
  config: Pick<RepoConfig, "lint_fix" | "format">,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<FixerFailure[]> {
  if (paths.length === 0) return [];
  const fixers = [
    { command: config.lint_fix, falla: "el lint dejó errores que no arregla solo" },
    { command: config.format, falla: "el formateador falló" },
  ];
  const failures: FixerFailure[] = [];
  for (const { command, falla } of fixers) {
    if (command === undefined) continue;
    const fixed = await runShell(`${command} ${paths.map(shellQuote).join(" ")}`, {
      cwd: worktree,
      env,
      timeoutMs: FIX_TIMEOUT_MS,
    });
    if (fixed.code !== 0) {
      failures.push({
        falla,
        detalle: `\`${command}\` salió ${String(fixed.code)}:\n${tail(fixed, 12)}`,
      });
    }
  }
  return failures;
}
