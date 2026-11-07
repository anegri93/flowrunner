// Correr el `verify` del repo: lo usan preparar sobre la base y verificar sobre la feature.
import { constants, accessSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/schemas.ts";
import { isUnrunnable, runProc, tail, type ProcResult } from "../proc/proc.ts";

export type VerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly unrunnable: boolean;
      readonly detail: string;
      readonly result?: ProcResult;
    };

export const VERIFY_TIMEOUT_MS = 30 * 60_000;

export async function runVerify(
  worktree: string,
  config: RepoConfig,
  env: NodeJS.ProcessEnv,
): Promise<VerifyResult> {
  const script = join(worktree, config.verify);
  if (!existsSync(script)) {
    return { ok: false, unrunnable: true, detail: `${config.verify} no existe en el repo` };
  }
  if (lstatSync(script).isSymbolicLink()) {
    return {
      ok: false,
      unrunnable: true,
      detail: `${config.verify} es un link: flowrunner no sigue links`,
    };
  }
  try {
    accessSync(script, constants.X_OK);
  } catch {
    return { ok: false, unrunnable: true, detail: `${config.verify} no es ejecutable` };
  }
  const result = await runProc(script, [], { cwd: worktree, env, timeoutMs: VERIFY_TIMEOUT_MS });
  if (result.code === 0) return { ok: true };
  return {
    ok: false,
    unrunnable: isUnrunnable(result),
    detail: `${config.verify} salió ${result.code}${result.timedOut ? " por timeout" : ""}:\n${tail(result)}`,
    result,
  };
}
