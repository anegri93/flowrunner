// El servicio de la feature que la persona levanta para probarla a mano con la PR abierta (ADR 0042):
// su estado vive en la carpeta del run, fuera del log, y lo escribe el proceso que lo tiene arriba.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunPaths } from "../runner/types.ts";
import { isAlive } from "./lock.ts";

export const servicioSchema = z.object({
  estado: z.enum(["levantando", "arriba", "parando", "parado", "falla"]),
  /** El proceso que lo tiene arriba; null entre que se lanza y que el proceso arranca. */
  pid: z.int().nullable(),
  inicio: z.iso.datetime(),
  /** Las URLs de `probar.urls` donde la persona prueba la feature. */
  urls: z.record(z.string(), z.string()),
  /** Qué está haciendo, o en qué quedó. */
  mensaje: z.string(),
});
export type Servicio = z.infer<typeof servicioSchema>;

/** Lo que ven watch y el panel de Orca. */
export type EstadoServicio = Pick<Servicio, "estado" | "urls" | "mensaje">;

/** Lo que tiene un proceso recién lanzado para escribir su pid antes de darlo por muerto. */
const ARRANQUE_MS = 60_000;

const ACTIVOS = new Set<Servicio["estado"]>(["levantando", "arriba", "parando"]);
export const servicioActivo = (s: { estado: Servicio["estado"] } | undefined): boolean =>
  s !== undefined && ACTIVOS.has(s.estado);

export const servicioFile = (run: Pick<RunPaths, "dir">) => join(run.dir, "servicio.json");
export const servicioLog = (run: Pick<RunPaths, "dir">) => join(run.dir, "servicio.log");

export function escribirServicio(run: Pick<RunPaths, "dir">, servicio: Servicio): void {
  mkdirSync(run.dir, { recursive: true });
  writeFileSync(servicioFile(run), `${JSON.stringify(servicio, null, 2)}\n`);
}

/**
 * El servicio como está: uno que dice estar arriba sin su proceso vivo se cortó (un reinicio, un
 * kill) y se ve como falla. Undefined si nunca se levantó o su archivo no se entiende.
 */
export function leerServicio(
  run: Pick<RunPaths, "dir">,
  now: Date,
  vivo: (pid: number) => boolean = isAlive,
): Servicio | undefined {
  let parsed: Servicio;
  try {
    parsed = servicioSchema.parse(JSON.parse(readFileSync(servicioFile(run), "utf8")));
  } catch {
    return undefined;
  }
  if (!servicioActivo(parsed)) return parsed;
  const muerto =
    parsed.pid === null
      ? now.getTime() - Date.parse(parsed.inicio) > ARRANQUE_MS
      : !vivo(parsed.pid);
  if (!muerto) return parsed;
  return {
    ...parsed,
    estado: "falla",
    mensaje: `se cortó: el detalle está en ${servicioLog(run)}`,
  };
}
