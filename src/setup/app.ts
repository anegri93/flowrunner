// El flowrunner que corre runs: un worktree fijo del repo, separado del checkout de desarrollo.
// Cambiar de rama en el checkout con un run en curso le cambiaba los prompts a mitad de camino (ML-1).
// `flowrunner self-update` lo crea o lo mueve a origin/main y re-apunta el comando, launchd, Orca y la
// skill desde su código (ADR 0020).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { UserError } from "../cli/output.ts";
import { flowrunnerHome } from "../config/load.ts";
import {
  addDetachedWorktree,
  conTurnoGit,
  fetchOrigin,
  git,
  GitError,
  headSha,
} from "../git/git.ts";
import { runProc, runShell, tail } from "../proc/proc.ts";
import { isAlive, tryLock } from "../store/lock.ts";
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
  const home = flowrunnerHome(env);
  const vivos = procesosVivos(home);
  if (vivos.length > 0) {
    throw new UserError(
      `no actualizo con runs corriendo: ${vivos.join(", ")}`,
      "esperá a que terminen o corré flowrunner status",
    );
  }
  // Con el lock del tick: uno que lance launchd mientras dura el install correría la app a medio
  // actualizar, y podría retomar o despachar runs con ese código. Ese tick sale sin hacer nada.
  mkdirSync(home, { recursive: true });
  const tickLock = join(home, "tick.lock");
  if (!tryLock(tickLock)) {
    throw new UserError(
      "no actualizo con un tick corriendo",
      "esperá a que termine y volvé a correr self-update",
    );
  }
  try {
    return await actualizar(env);
  } finally {
    rmSync(tickLock, { force: true });
  }
}

async function actualizar(env: NodeJS.ProcessEnv): Promise<SelfUpdate> {
  const repo = await commonDir(SOURCE_REPO, env);
  if (repo === undefined) throw new UserError(`${SOURCE_REPO} no es un repo de git`);
  try {
    await fetchOrigin(SOURCE_REPO, env);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new UserError(`no pude traer origin: ${error.message}`);
  }

  const app = appDir(env);
  const creado = !existsSync(app);
  if (creado) {
    // Una app borrada a mano sigue registrada como worktree, y `worktree add` se negaría.
    await conTurnoGit(SOURCE_REPO, () => git(SOURCE_REPO, ["worktree", "prune"], env));
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
    // --force: nadie edita la app; lo que un proceso haya escrito ahí no pasa al código nuevo.
    await git(app, ["checkout", "--detach", "--force", "--quiet", "origin/main"], env);
    await git(app, ["clean", "-fdq", "-e", "node_modules"], env);
  }
  const sha = await headSha(app, env);

  const install = await runShell(env.FLOWRUNNER_APP_INSTALL ?? "pnpm install --frozen-lockfile", {
    cwd: app,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (install.code !== 0) {
    throw new UserError(
      `la app quedó en ${sha.slice(0, 7)} sin sus dependencias: no se pudieron instalar en ${app}:\n${tail(install)}`,
      "arreglá lo de arriba y volvé a correr flowrunner self-update",
    );
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
  return { ok: true, app, sha, creado, reapuntado };
}
