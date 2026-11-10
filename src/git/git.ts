// Las operaciones de git de flowrunner. Ningún agente llama a git hacia afuera: solo este módulo.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runProc } from "../proc/proc.ts";
import { conTurno, conTurnoSync, type EsperaTurno } from "../store/turno.ts";

export class GitError extends Error {
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} falló: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Ramas que flowrunner puede empujar. Cualquier otra, `main` incluida, se rechaza. */
const PUSHABLE =
  /^(feat\/[A-Za-z0-9._/-]+|chore\/lecciones-[A-Za-z0-9._-]+|chore\/flowrunner-(init|borrador))$/;

export async function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return (await gitRaw(cwd, args, env)).trim();
}

/** La salida de git tal cual, sin recortar: con `-z`, un espacio al principio es parte de una ruta. */
async function gitRaw(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = await runProc("git", args, { cwd, env });
  if (result.code !== 0) throw new GitError(args, result.stderr);
  return result.stdout;
}

/**
 * El turno de git del checkout: `fetch` y `worktree add/remove/prune` tocan refs y `.git/worktrees`,
 * que comparten todos los runs y las sub-tasks del repo. Vive en el `.git` común, al lado de los
 * locks de git. Es el turno más interno: quien lo tiene no pide otro (ADR 0019).
 */
function gitTurnoFile(repo: string): string {
  const args = ["rev-parse", "--git-common-dir"];
  let common: string;
  try {
    common = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new GitError(args, typeof stderr === "string" ? stderr : String(error));
  }
  return join(resolve(repo, common), "flowrunner.lock");
}

/** Dura segundos; quince minutos sin tomarlo es otro proceso colgado, no una espera. */
const GIT_TURNO: EsperaTurno = { limiteMs: 15 * 60_000, pausaMs: { desde: 50, hasta: 1_000 } };

export function conTurnoGit<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return conTurno(gitTurnoFile(repo), "git", fn, GIT_TURNO);
}

export function conTurnoGitSync<T>(repo: string, fn: () => T): T {
  return conTurnoSync(gitTurnoFile(repo), "git", fn, GIT_TURNO);
}

export async function fetchOrigin(repo: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await conTurnoGit(repo, () => git(repo, ["fetch", "--quiet", "origin"], env));
}

/** Crea `path` como worktree en una rama nueva desde `startPoint`; si ya existían, los rehace. */
export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  startPoint: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  await conTurnoGit(repo, async () => {
    await git(repo, ["worktree", "remove", "--force", path], env).catch(() => undefined);
    await git(repo, ["worktree", "prune"], env);
    await git(repo, ["worktree", "add", "--quiet", "-B", branch, path, startPoint], env);
  });
  return headSha(path, env);
}

/** Un worktree sin rama en `commit`, como los de init y reparar; con el turno de git. */
export async function addDetachedWorktree(
  repo: string,
  path: string,
  commit: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await conTurnoGit(repo, () =>
    git(repo, ["worktree", "add", "--quiet", "--detach", path, commit], env),
  );
}

export function headSha(worktree: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return git(worktree, ["rev-parse", "HEAD"], env);
}

export async function removeWorktree(
  repo: string,
  path: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await conTurnoGit(repo, async () => {
    await git(repo, ["worktree", "remove", "--force", path], env).catch(() => undefined);
    await git(repo, ["worktree", "prune"], env);
  });
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

/** Deja `changes` como estaban en `base`: los archivos nuevos se borran y el resto se restaura. */
export async function discardChanges(
  worktree: string,
  base: string,
  changes: readonly FileChange[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  for (const c of changes.filter((c) => c.status === "agregado"))
    rmSync(join(worktree, c.path), { force: true });
  const restore = changes.filter((c) => c.status !== "agregado").map((c) => c.path);
  if (restore.length > 0) await git(worktree, ["checkout", base, "--", ...restore], env);
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
    throw new GitError(
      ["push", branch],
      "flowrunner solo empuja ramas feat/, chore/lecciones-, chore/flowrunner-init y chore/flowrunner-borrador",
    );
  // Con el turno de git: el push actualiza refs/remotes/origin, que un fetch de otro run reescribe.
  await conTurnoGit(worktree, () =>
    git(
      worktree,
      ["push", "--quiet", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`],
      env,
    ),
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
  // Con -z, git da las rutas tal cual: sin él, escapa entre comillas las que tienen tildes, comillas o
  // caracteres de control, y esas no se podían leer ni chequear.
  const fields = (out: string) => out.split("\0").filter((f) => f !== "");
  const tracked = fields(
    await gitRaw(worktree, ["diff", "--name-status", "--no-renames", "-z", base], env),
  );
  for (let i = 0; i + 1 < tracked.length; i += 2) {
    const code = tracked[i] ?? "";
    const path = tracked[i + 1] ?? "";
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
  const untracked = fields(
    await gitRaw(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], env),
  );
  for (const path of untracked) {
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
