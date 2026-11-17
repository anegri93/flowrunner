// Las dependencias del worktree de la feature, al día con su rama: si la rama cambió manifiestos o
// lockfiles contra la base, el `node_modules` (o lo que instale el setup) es el de preparar y no sirve.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { runProc, runShell, tail } from "../proc/proc.ts";
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

/** Un setup que solo instala paquetes de node, con sus opciones: lo único que deja es node_modules. */
const SOLO_INSTALA =
  /^(npm (ci|install|i)|pnpm (install|i)|yarn( install)?|bun install)( +--?[\w-]+(=[\w.-]+)?)*$/;

export const soloInstala = (setup: string) => SOLO_INSTALA.test(setup.trim());

/** Cuánto puede tardar clonar un node_modules: más es un disco con problemas, y se corre el setup. */
const CLONAR_TIMEOUT_MS = 5 * 60_000;

/**
 * Clona en el worktree de una sub-task los node_modules del de la feature, en vez de correr el setup:
 * `npm ci` tardaba 25 a 37 s por sub-task en pizarra-en-vivo, y clonar es copy-on-write (ADR 0035).
 * Solo si el setup únicamente instala paquetes de node, y si la rama no cambió manifiestos ni lockfiles
 * desde la base: así el node_modules de la feature es el que instaló preparar con esos mismos archivos.
 * Devuelve false si no se puede, y entonces corre el setup de siempre.
 */
export async function reusarDependencias(
  feature: string,
  destino: string,
  config: RepoConfig,
  base: string,
  start: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!soloInstala(config.setup)) return false;
  const depFiles = new Set([...config.lockfiles, ...config.manifests]);
  const cambiaron = (await git(feature, ["diff", "--name-only", base, start], env))
    .split("\n")
    .some((f) => depFiles.has(f) || f.endsWith("/package.json"));
  if (cambiaron) return false;
  const carpetas = (
    await git(
      feature,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      env,
    )
  )
    .split("\0")
    .filter((p) => /(^|\/)node_modules\/$/.test(p))
    .map((p) => p.slice(0, -1));
  if (carpetas.length === 0) return false;
  // Copy-on-write: clonefile en macOS (APFS), reflink en Linux si el sistema de archivos lo tiene.
  const flags = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
  for (const carpeta of carpetas) {
    mkdirSync(dirname(join(destino, carpeta)), { recursive: true });
    const r = await runProc("cp", [...flags, join(feature, carpeta), join(destino, carpeta)], {
      cwd: destino,
      env,
      timeoutMs: CLONAR_TIMEOUT_MS,
    });
    if (r.code !== 0) {
      // A medias no sirve: se borra lo clonado y el setup instala de cero.
      for (const c of carpetas) rmSync(join(destino, c), { recursive: true, force: true });
      return false;
    }
  }
  return true;
}
