// La versión del flowrunner que corre comparada con origin/main, sin red: contra el último fetch. El
// panel de Orca la muestra en el doctor para saber si conviene `self-update`, que sí trae origin.
import { git, GitError } from "../git/git.ts";
import { SOURCE_REPO } from "./app.ts";

export interface Version {
  /** El commit del código que corre, corto; null si no es un repo de git. */
  readonly sha: string | null;
  /** origin/main del último fetch, corto; null si el repo no lo tiene. */
  readonly main: string | null;
  /** Cuántos commits le faltan para llegar a ese origin/main; null si no se pudo contar. */
  readonly atras: number | null;
}

const short = (sha: string) => sha.slice(0, 7);

async function tryGit(
  dir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    return await git(dir, args, env);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

export async function localVersion(
  env: NodeJS.ProcessEnv,
  dir: string = SOURCE_REPO,
): Promise<Version> {
  const sha = await tryGit(dir, ["rev-parse", "HEAD"], env);
  const main = await tryGit(dir, ["rev-parse", "--verify", "--quiet", "origin/main"], env);
  if (sha === null || main === null)
    return {
      sha: sha === null ? null : short(sha),
      main: main === null ? null : short(main),
      atras: null,
    };
  const count = await tryGit(dir, ["rev-list", "--count", `${sha}..${main}`], env);
  return { sha: short(sha), main: short(main), atras: count === null ? null : Number(count) };
}

export function describeVersion(v: Version): string {
  if (v.sha === null) return "versión: no es un repo de git";
  if (v.main === null || v.atras === null) return `versión ${v.sha}`;
  if (v.atras === 0) return `versión ${v.sha}: al día con origin/main del último fetch`;
  return `versión ${v.sha}: ${String(v.atras)} ${v.atras === 1 ? "commit" : "commits"} atrás de origin/main (${v.main}, del último fetch): corré flowrunner self-update`;
}
