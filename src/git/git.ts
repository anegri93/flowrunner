// Las operaciones de git de flowrunner. Ningún agente llama a git hacia afuera: solo este módulo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProc } from "../proc/proc.ts";

export class GitError extends Error {
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} falló: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Ramas que flowrunner puede empujar. Cualquier otra, `main` incluida, se rechaza. */
const PUSHABLE = /^(feat\/[A-Za-z0-9._/-]+|chore\/lecciones-[A-Za-z0-9._-]+)$/;

export async function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = await runProc("git", args, { cwd, env });
  if (result.code !== 0) throw new GitError(args, result.stderr);
  return result.stdout.trim();
}

export async function fetchOrigin(repo: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await git(repo, ["fetch", "--quiet", "origin"], env);
}

/** Crea `path` como worktree en una rama nueva desde `startPoint`; si ya existían, los rehace. */
export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  startPoint: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  await git(repo, ["worktree", "remove", "--force", path], env).catch(() => undefined);
  await git(repo, ["worktree", "prune"], env);
  await git(repo, ["worktree", "add", "--quiet", "-B", branch, path, startPoint], env);
  return headSha(path, env);
}

export function headSha(worktree: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return git(worktree, ["rev-parse", "HEAD"], env);
}

export async function resetHard(
  worktree: string,
  sha: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await git(worktree, ["reset", "--quiet", "--hard", sha], env);
  await git(worktree, ["clean", "-fdq"], env);
}

/** Commitea todo lo que cambió, con los trailers dados. Devuelve el sha, o undefined si no había nada. */
export async function commitAll(
  worktree: string,
  message: string,
  trailers: Record<string, string>,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  await git(worktree, ["add", "-A"], env);
  const staged = await git(worktree, ["diff", "--cached", "--name-only"], env);
  if (staged === "") return undefined;
  const trailerArgs = Object.entries(trailers).flatMap(([k, v]) => ["--trailer", `${k}: ${v}`]);
  await git(worktree, ["commit", "--quiet", "--no-verify", "-m", message, ...trailerArgs], env);
  return headSha(worktree, env);
}

export type CherryPick =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly conflicts: string[] };

/** Aplica `sha` sobre la rama del worktree. Si choca, deja el worktree como estaba. */
export async function cherryPick(
  worktree: string,
  sha: string,
  env?: NodeJS.ProcessEnv,
): Promise<CherryPick> {
  try {
    await git(worktree, ["cherry-pick", "--allow-empty", sha], env);
    return { ok: true, sha: await headSha(worktree, env) };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const conflicts = (
      await git(worktree, ["diff", "--name-only", "--diff-filter=U"], env).catch(() => "")
    )
      .split("\n")
      .filter((f) => f !== "");
    await git(worktree, ["cherry-pick", "--abort"], env).catch(() => undefined);
    return {
      ok: false,
      conflicts: conflicts.length > 0 ? conflicts : ["(sin archivos: el cherry-pick falló)"],
    };
  }
}

export async function pushBranch(
  worktree: string,
  branch: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!PUSHABLE.test(branch))
    throw new GitError(["push", branch], "flowrunner solo empuja ramas feat/ y chore/lecciones-");
  await git(
    worktree,
    ["push", "--quiet", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`],
    env,
  );
}

export interface FileChange {
  readonly path: string;
  readonly status: "agregado" | "modificado" | "borrado";
  /** Las líneas agregadas; para un archivo nuevo, todo su contenido. */
  readonly added: readonly string[];
}

/** Lo que cambió en el worktree respecto de `base`, incluidos los archivos sin seguimiento. */
export async function changesSince(
  worktree: string,
  base: string,
  env?: NodeJS.ProcessEnv,
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const tracked = await git(worktree, ["diff", "--name-status", "--no-renames", base], env);
  for (const line of tracked.split("\n").filter((l) => l !== "")) {
    const [code = "", path = ""] = line.split("\t");
    const status = code === "A" ? "agregado" : code === "D" ? "borrado" : "modificado";
    const patch =
      status === "borrado"
        ? ""
        : await git(worktree, ["diff", "--unified=0", base, "--", path], env);
    const added = patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
    changes.push({ path, status, added });
  }
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard"], env);
  for (const path of untracked.split("\n").filter((l) => l !== "")) {
    let added: string[] = [];
    try {
      added = readFileSync(join(worktree, path), "utf8").split("\n");
    } catch {
      added = [];
    }
    changes.push({ path, status: "agregado", added });
  }
  return changes;
}
