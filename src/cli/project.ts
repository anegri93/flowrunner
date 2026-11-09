// `flowrunner project add` y `flowrunner brain init`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { initBrain, loadBrain, refreshTemplates } from "../brain/brain.ts";
import { flowrunnerHome, loadRepoConfig } from "../config/load.ts";
import { ConfigError, globalConfigSchema } from "../config/schemas.ts";
import { runProc } from "../proc/proc.ts";
import { UserError } from "./output.ts";

async function gitRoot(path: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProc("git", ["rev-parse", "--show-toplevel"], { cwd: path, env });
  if (result.code !== 0) throw new UserError(`${path} no es un repo git`);
  return result.stdout.trim();
}

/** Lo que le falta a un repo para correr runs, en palabras: vacío si está listo. */
export function missingForRuns(repo: string): string[] {
  const missing: string[] = [];
  for (const check of [() => loadRepoConfig(repo), () => loadBrain(repo)]) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      missing.push(...error.problems.map((p) => `${p.where}: ${p.message}`));
    }
  }
  return missing;
}

export async function gitRootOf(path: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!existsSync(path)) throw new UserError(`no existe ${path}`);
  return gitRoot(resolve(path), env);
}

export const projectNameFor = (repo: string) =>
  basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");

/** Lee la config global cruda, la cambia y la escribe solo si sigue siendo válida. */
export function updateGlobalConfig(
  env: NodeJS.ProcessEnv,
  change: (raw: Record<string, unknown>) => void,
): void {
  const home = flowrunnerHome(env);
  const file = join(home, "config.yaml");
  const raw: Record<string, unknown> = existsSync(file)
    ? ((parse(readFileSync(file, "utf8")) as Record<string, unknown> | null) ?? {})
    : {};
  change(raw);
  if (raw.github_user === undefined) {
    throw new UserError(
      "falta tu usuario de GitHub: flowrunner lo usa para aprender solo de tus correcciones",
      "flowrunner project add <ruta> --github-user <tu usuario>",
    );
  }
  const checked = globalConfigSchema.safeParse(raw);
  if (!checked.success)
    throw new UserError(`la config global quedaría inválida: ${checked.error.message}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(file, stringify(raw));
}

export async function addProject(
  path: string,
  opts: { name?: string | undefined; githubUser?: string | undefined },
  env: NodeJS.ProcessEnv,
) {
  const repo = await gitRootOf(path, env);
  const name = opts.name ?? projectNameFor(repo);
  updateGlobalConfig(env, (raw) => {
    if (opts.githubUser !== undefined) raw.github_user = opts.githubUser;
    const projects = Array.isArray(raw.projects)
      ? (raw.projects as { name: string; path: string }[])
      : [];
    raw.projects = [...projects.filter((p) => p.name !== name), { name, path: repo }];
  });
  return { ok: true as const, proyecto: name, repo, faltan: missingForRuns(repo) };
}

export async function initRepoBrain(path: string, env: NodeJS.ProcessEnv) {
  const repo = await gitRoot(resolve(path), env);
  const creados = initBrain(repo);
  const actualizados = refreshTemplates(repo);
  return { ok: true as const, repo, creados, actualizados, faltan: missingForRuns(repo) };
}
