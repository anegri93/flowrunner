// Leer y validar las configs desde disco.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  ConfigError,
  globalConfigSchema,
  problemsFrom,
  repoConfigSchema,
  type GlobalConfig,
  type RepoConfig,
} from "./schemas.ts";

/** `~/.flowrunner`, o `FLOWRUNNER_HOME` si está definido: así un test usa un home propio sin perder
 * la sesión de Claude Code de la persona, que vive en su HOME real. */
export function flowrunnerHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWRUNNER_HOME;
  return override !== undefined && override !== ""
    ? override
    : join(env.HOME ?? homedir(), ".flowrunner");
}

function readYaml(file: string): unknown {
  if (!existsSync(file)) throw new ConfigError([{ where: file, message: "no existe" }]);
  try {
    return parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([{ where: file, message: `YAML inválido: ${reason}` }]);
  }
}

export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const file = join(flowrunnerHome(env), "config.yaml");
  const result = globalConfigSchema.safeParse(readYaml(file));
  if (!result.success) throw new ConfigError(problemsFrom(file, result.error));
  const home = env.HOME ?? homedir();
  return {
    ...result.data,
    projects: result.data.projects.map((p) => ({
      ...p,
      path: p.path.startsWith("~/") ? join(home, p.path.slice(2)) : resolve(p.path),
    })),
  };
}

export function repoConfigPath(repo: string): string {
  return join(repo, ".flowrunner", "config.yaml");
}

/** `./.flowrunner/verify.sh`, `.flowrunner/verify.sh` o `bash .flowrunner/verify.sh`: el verify del repo. */
export function isVerifyCommand(config: RepoConfig, comando: string): boolean {
  const bare = (p: string) =>
    p
      .trim()
      .replace(/^(?:ba)?sh\s+/, "")
      .replace(/^\.\//, "");
  return bare(comando) === bare(config.verify);
}

export function loadRepoConfig(repo: string): RepoConfig {
  if (!isAbsolute(repo)) throw new Error(`la ruta del repo tiene que ser absoluta: ${repo}`);
  const file = repoConfigPath(repo);
  if (!existsSync(file)) {
    throw new ConfigError([
      {
        where: file,
        message: "el repo no tiene .flowrunner/config.yaml; corré `flowrunner brain init`",
      },
    ]);
  }
  const result = repoConfigSchema.safeParse(readYaml(file));
  if (!result.success) throw new ConfigError(problemsFrom(file, result.error));
  return result.data;
}
