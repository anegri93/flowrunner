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

/** El candado tiene el pid de quien la escribe: uno muerto no la está escribiendo. */
export const explicando = (lock: string): boolean =>
  existsSync(lock) && isAlive(Number(readFileSync(lock, "utf8")));

export function estadoExplicacion(
  run: Pick<RunPaths, "dir">,
  detencion: number | undefined,
): EstadoExplicacion | undefined {
  if (detencion === undefined) return undefined;
  const p = explicacionPaths(run, detencion);
  if (existsSync(p.md)) return { estado: "lista" };
  if (explicando(p.lock)) return { estado: "explicando" };
  if (existsSync(p.error)) return { estado: "fallo", motivo: readFileSync(p.error, "utf8").trim() };
  return undefined;
}
