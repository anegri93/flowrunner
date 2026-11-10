// Lo que necesitan los tests que instalan el flowrunner que corre (`self-update`, `init --aplicar`):
// un repo fuente que no es el real. `self-update` hace fetch y `worktree add` sobre el repo del código
// que corre, así que esos tests corren el CLI desde un clon y nunca tocan el `.git` real.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "../../src/agent/env.ts";
import { TEST_BIN } from "./cli.ts";
import { git, tempDir } from "./git.ts";

/** El checkout de flowrunner que corre los tests. */
export const REAL_REPO = realpathSync(join(import.meta.dirname, "..", ".."));

export interface Fuente {
  /** El clon: hace de checkout de desarrollo. */
  readonly repo: string;
  /** Su `origin`, un bare propio. */
  readonly remote: string;
}

/**
 * Un clon `--shared` del repo real, con el árbol de trabajo encima commiteado: lo que se prueba es el
 * código de este checkout, commiteado o no. Su `origin` es un bare propio con ese commit en `main`, y
 * su `node_modules` es un link al real.
 */
export function fuenteClonada(): Fuente {
  const repo = join(realpathSync(tempDir("flowrunner-fuente-")), "flowrunner");
  execFileSync("git", ["clone", "--quiet", "--shared", REAL_REPO, repo]);
  const files = execFileSync(
    "git",
    ["-C", REAL_REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const target = join(repo, file);
    if (existsSync(join(REAL_REPO, file))) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(REAL_REPO, file), target);
    } else {
      rmSync(target, { force: true });
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-verify", "--allow-empty", "-m", "el árbol que se prueba");
  const remote = realpathSync(tempDir("flowrunner-fuente-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(repo, "remote", "set-url", "origin", remote);
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "fetch", "-q", "--prune", "origin");
  // Después del commit: `node_modules/` del .gitignore no cubre un link.
  symlinkSync(join(REAL_REPO, "node_modules"), join(repo, "node_modules"));
  return { repo, remote };
}

/**
 * Lo que suma al entorno de un test que instala la app: `~/.local/bin` en el PATH, el Orca falso (el
 * real puede estar instalado) y una instalación de dependencias que linkea las del repo real.
 * `-sfn`: con la app ya instalada, el link existe, y `ln -s` crearía otro adentro del real.
 */
export function conApp(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localBin = join(env.HOME ?? "", ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const path = (env.PATH ?? "").split(":").filter((d) => d !== TEST_BIN && d !== localBin);
  return {
    ...env,
    PATH: [TEST_BIN, localBin, ...path].join(":"),
    ORCA: join(TEST_BIN, "orca"),
    FLOWRUNNER_APP_INSTALL: `ln -sfn ${shellQuote(join(REAL_REPO, "node_modules"))} node_modules`,
  };
}
