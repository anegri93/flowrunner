// Las explicaciones de las detenciones de un run (ADR 0037): un Markdown por detención, su candado
// mientras una sesión la escribe y el motivo si no pudo. Viven en la carpeta del run, fuera del log.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPaths } from "../runner/types.ts";
import { isAlive } from "./lock.ts";

/** Dónde vive la explicación de una detención, su candado mientras se escribe y su último error. */
export function explicacionPaths(run: Pick<RunPaths, "dir">, detencion: number) {
  const dir = join(run.dir, "explicaciones");
  const base = join(dir, `detencion-${String(detencion)}`);
  return {
    dir,
    md: `${base}.md`,
    lock: `${base}.lock`,
    error: `${base}.error`,
    log: `${base}.log`,
  };
}

/** Cómo está la explicación de la detención actual, para watch y el panel de Orca. */
export type EstadoExplicacion =
  | { readonly estado: "lista" }
  | { readonly estado: "explicando" }
  | { readonly estado: "fallo"; readonly motivo: string };

/**
 * Un archivo que puede desaparecer en cualquier momento (el candado, el error): si no está, undefined.
 * Así un `watch --json` que lee justo cuando el proceso lo borra no falla entero.
 */
function leer(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** El pid del candado, si existe y es de un proceso vivo. */
export function pidDelCandado(lock: string): number | undefined {
  const text = leer(lock);
  if (text === undefined) return undefined;
  const pid = Number(text);
  return isAlive(pid) ? pid : undefined;
}

/** El candado tiene el pid de quien la escribe: uno muerto no la está escribiendo. */
export const explicando = (lock: string): boolean => pidDelCandado(lock) !== undefined;

export function estadoExplicacion(
  run: Pick<RunPaths, "dir">,
  detencion: number | undefined,
): EstadoExplicacion | undefined {
  if (detencion === undefined) return undefined;
  const p = explicacionPaths(run, detencion);
  if (existsSync(p.md)) return { estado: "lista" };
  if (explicando(p.lock)) return { estado: "explicando" };
  const error = leer(p.error);
  if (error !== undefined) return { estado: "fallo", motivo: error.trim() };
  return undefined;
}
