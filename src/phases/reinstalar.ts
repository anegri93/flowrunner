// Las dependencias del worktree de la feature, al día con su rama: si la rama cambió manifiestos o
// lockfiles contra la base, el `node_modules` (o lo que instale el setup) es el de preparar y no sirve.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
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

/** Un setup que solo corre la instalación de npm, con sus opciones. */
const SOLO_NPM = /^npm (ci|install|i)( +--?[\w-]+(=[\w.-]+)?)*$/;

export const soloInstala = (setup: string) => SOLO_NPM.test(setup.trim());

/** Los scripts que npm corre al instalar y pueden escribir fuera de node_modules. */
const CICLO_DE_VIDA = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];

/** Cuánto puede tardar clonar los node_modules: más es un disco con problemas, y se corre el setup. */
const CLONAR_TIMEOUT_MS = 5 * 60_000;

const lockSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      optional: z.boolean().optional(),
      devOptional: z.boolean().optional(),
    }),
  ),
});

function leerLock(path: string): z.infer<typeof lockSchema>["packages"] | undefined {
  try {
    return lockSchema.parse(JSON.parse(readFileSync(path, "utf8"))).packages;
  } catch {
    return undefined;
  }
}

/**
 * Si lo instalado es lo que pide el lockfile: el registro que deja npm en `node_modules/.package-lock.json`
 * tiene cada paquete del lockfile con su versión, salvo los opcionales de otra plataforma, y nada más.
 */
export function mismoArbol(lockfile: string, instalado: string): boolean {
  const pedido = leerLock(lockfile);
  const hay = leerLock(instalado);
  if (pedido === undefined || hay === undefined) return false;
  const deMas = Object.entries(hay).some(([k, p]) => pedido[k]?.version !== p.version);
  const faltan = Object.entries(pedido).some(
    ([k, p]) => k !== "" && !(k in hay) && p.optional !== true && p.devOptional !== true,
  );
  return !deMas && !faltan;
}

export type Reuso =
  { readonly reusado: true } | { readonly reusado: false; readonly aviso?: string };

/**
 * Clona en el worktree de una sub-task los node_modules del de la feature, en vez de correr el setup:
 * `npm ci` tardaba 25 a 37 s por sub-task en pizarra-en-vivo, y clonar es copy-on-write (ADR 0035).
 * Solo con npm, si lo instalado en la feature es exactamente lo que pide el lockfile de la sub-task, y
 * si ningún package.json del repo tiene scripts que npm corre al instalar. Si no, el setup de siempre;
 * si el clon falla, con un aviso.
 */
export async function reusarDependencias(
  feature: string,
  destino: string,
  config: RepoConfig,
  env: NodeJS.ProcessEnv,
): Promise<Reuso> {
  if (!soloInstala(config.setup)) return { reusado: false };
  if (
    !mismoArbol(
      join(destino, "package-lock.json"),
      join(feature, "node_modules", ".package-lock.json"),
    )
  )
    return { reusado: false };
  const manifiestos = (
    await git(destino, ["ls-files", "-z", "--", "package.json", "**/package.json"], env)
  )
    .split("\0")
    .filter((m) => m !== "");
  for (const m of manifiestos) {
    let scripts: Record<string, unknown>;
    try {
      scripts =
        (
          JSON.parse(readFileSync(join(destino, m), "utf8")) as {
            scripts?: Record<string, unknown>;
          }
        ).scripts ?? {};
    } catch {
      return { reusado: false };
    }
    if (CICLO_DE_VIDA.some((s) => s in scripts)) return { reusado: false };
  }
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
  if (carpetas.length === 0) return { reusado: false };
  // Copy-on-write: clonefile en macOS (APFS), reflink en Linux si el sistema de archivos lo tiene.
  const flags = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
  const clones = await Promise.all(
    carpetas.map(async (carpeta) => {
      mkdirSync(dirname(join(destino, carpeta)), { recursive: true });
      return runProc("cp", [...flags, join(feature, carpeta), join(destino, carpeta)], {
        cwd: destino,
        env,
        timeoutMs: CLONAR_TIMEOUT_MS,
      });
    }),
  );
  const fallo = clones.find((r) => r.code !== 0);
  if (fallo === undefined) return { reusado: true };
  // A medias no sirve: se borra lo clonado y el setup instala de cero.
  for (const c of carpetas) rmSync(join(destino, c), { recursive: true, force: true });
  return {
    reusado: false,
    aviso: `no se pudo clonar node_modules de la feature (${tail(fallo, 3)}): corre el setup`,
  };
}
