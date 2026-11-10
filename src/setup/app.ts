// El flowrunner que corre runs: un worktree fijo del repo, separado del checkout de desarrollo.
// Cambiar de rama en el checkout con un run en curso le cambiaba los prompts a mitad de camino (ML-1).
// `flowrunner self-update` lo crea o lo mueve a origin/main y re-apunta el comando, launchd, Orca y la
// skill desde su código (ADR 0020).
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { UserError } from "../cli/output.ts";
import { flowrunnerHome } from "../config/load.ts";
import { addDetachedWorktree, fetchOrigin, git, GitError, headSha } from "../git/git.ts";
import { runProc, runShell, tail } from "../proc/proc.ts";
import { isAlive } from "../store/lock.ts";
import { leerLugar } from "../store/lugares.ts";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** launchctl y el CLI de Orca, que tiene su propio tope de un minuto. */
const REAPUNTAR_TIMEOUT_MS = 5 * 60_000;

export function appDir(env: NodeJS.ProcessEnv): string {
  return join(flowrunnerHome(env), "app");
}

/** El bin que corre runs: el de la app. */
export function appBin(env: NodeJS.ProcessEnv): string {
  return join(appDir(env), "bin", "flowrunner.js");
}

/** Si `link` resuelve al bin de la app. Falso si alguno de los dos no existe. */
export function resolvesToApp(link: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return realpathSync(link) === realpathSync(appBin(env));
  } catch {
    return false;
  }
}

/** El repo de flowrunner del código que corre: la carpeta de arriba de src/. */
export const SOURCE_REPO = join(import.meta.dirname, "..", "..");

/** Los procesos vivos que impiden actualizar: lugares con pid vivo y un tick corriendo. */
export function procesosVivos(home: string): string[] {
  const vivos: string[] = [];
  const locks = join(home, "locks");
  const proyectos = existsSync(locks)
    ? readdirSync(locks, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  for (const proyecto of proyectos) {
    const dir = join(locks, proyecto.name, "lugares");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((e) => e.endsWith(".json"))) {
      const lugar = leerLugar(join(dir, entry));
      if (lugar !== undefined && isAlive(lugar.pid)) {
        vivos.push(`${lugar.run_id} (pid ${String(lugar.pid)})`);
      }
    }
  }
  const tick = join(home, "tick.lock");
  if (existsSync(tick)) {
    const pid = Number(readFileSync(tick, "utf8"));
    if (isAlive(pid)) vivos.push(`tick (pid ${String(pid)})`);
  }
  return vivos;
}

export interface SelfUpdate {
  ok: true;
  app: string;
  sha: string;
  creado: boolean;
  reapuntado: string[];
}

const reapuntadoSchema = z.object({ ok: z.literal(true), reapuntado: z.array(z.string()) });

/** El `.git` común de un checkout, absoluto y sin links; undefined si no es un repo de git. */
async function commonDir(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return realpathSync(resolve(dir, await git(dir, ["rev-parse", "--git-common-dir"], env)));
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

export async function selfUpdate(env: NodeJS.ProcessEnv): Promise<SelfUpdate> {
  const vivos = procesosVivos(flowrunnerHome(env));
  if (vivos.length > 0) {
    throw new UserError(
      `no actualizo con runs corriendo: ${vivos.join(", ")}`,
      "esperá a que terminen o corré flowrunner status",
    );
  }
  const repo = await commonDir(SOURCE_REPO, env);
  if (repo === undefined) throw new UserError(`${SOURCE_REPO} no es un repo de git`);
  await fetchOrigin(SOURCE_REPO, env);

  const app = appDir(env);
  const creado = !existsSync(app);
  if (creado) {
    await addDetachedWorktree(SOURCE_REPO, app, "origin/main", env);
  } else {
    // Su raíz tiene que ser la app misma: una carpeta adentro de otro checkout también da su `.git`.
    const top = await git(app, ["rev-parse", "--show-toplevel"], env).catch(() => undefined);
    if (
      (await commonDir(app, env)) !== repo ||
      top === undefined ||
      realpathSync(top) !== realpathSync(app)
    ) {
      throw new UserError(
        `${app} existe y no es un worktree de flowrunner: borralo y volvé a correr self-update`,
      );
    }
    await git(app, ["checkout", "--detach", "--quiet", "origin/main"], env);
    await git(app, ["clean", "-fdq", "-e", "node_modules"], env);
  }

  const install = await runShell(env.FLOWRUNNER_APP_INSTALL ?? "pnpm install --frozen-lockfile", {
    cwd: app,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (install.code !== 0) {
    throw new UserError(`no se pudieron instalar las dependencias en ${app}:\n${tail(install)}`);
  }

  // Con el código de la app: así BIN, ORCA_PLUGIN_DIR y la skill salen de ahí, no de este checkout.
  const reapuntar = await runProc(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(app, "bin", "flowrunner.js"),
      "_reapuntar",
      "--json",
    ],
    { cwd: app, env, timeoutMs: REAPUNTAR_TIMEOUT_MS },
  );
  let reapuntado: string[];
  try {
    reapuntado = reapuntadoSchema.parse(JSON.parse(reapuntar.stdout)).reapuntado;
  } catch {
    throw new UserError(`no se pudo re-apuntar a ${app}:\n${tail(reapuntar)}`);
  }
  return { ok: true, app, sha: await headSha(app, env), creado, reapuntado };
}
