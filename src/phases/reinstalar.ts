// Las dependencias del worktree de la feature, al día con su rama: si la rama cambió manifiestos o
// lockfiles contra la base, el `node_modules` (o lo que instale el setup) es el de preparar y no sirve.
import type { RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { runShell, tail } from "../proc/proc.ts";
import { SETUP_TIMEOUT_MS } from "./preparar.ts";

/** Corre el setup si `base..HEAD` toca manifiestos o lockfiles. Devuelve el motivo si falla. */
export async function reinstalarSiCambiaron(
  worktree: string,
  config: RepoConfig,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const depFiles = new Set([...config.lockfiles, ...config.manifests]);
  const changed = (await git(worktree, ["diff", "--name-only", base, "HEAD"], env))
    .split("\n")
    .filter((f) => depFiles.has(f));
  if (changed.length === 0) return undefined;
  const setup = await runShell(config.setup, { cwd: worktree, env, timeoutMs: SETUP_TIMEOUT_MS });
  return setup.code === 0
    ? undefined
    : `la feature cambió ${changed.join(", ")} y el setup \`${config.setup}\` salió ${String(setup.code)} al reinstalar:\n${tail(setup)}`;
}
