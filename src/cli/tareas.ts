// Las tareas de mantenimiento que el panel de Orca lanza y sigue: actualizar flowrunner, cargar el
// plugin de Orca y auditar el cerebro de un repo. Tardan más que los 20 s de un comando del worker, y
// actualizar recarga el plugin a mitad de camino: cada una corre en su propio proceso y deja su estado
// en `~/.flowrunner/tareas/<nombre>.json`, que el panel lee (ADR 0039).
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { notifyMac } from "../notify/notify.ts";
import { isAlive, tryLock } from "../store/lock.ts";
import { UserError } from "./output.ts";
import { BIN } from "./runs.ts";

/** Un nombre de tarea: también es el nombre de su archivo, y llega como argumento de `_tarea`. */
export const TAREA_NOMBRE = /^(self-update|orca-install|auditar-[a-z0-9-]+)$/;
/** Lo que tiene un proceso recién lanzado para escribir su pid antes de darlo por muerto. */
const ARRANQUE_MS = 60_000;
/**
 * Lo más que tarda una tarea: la auditoría tiene 15 minutos de sesión. Más que esto con el pid vivo es
 * un pid reciclado después de un reinicio, no la tarea.
 */
const MAX_TAREA_MS = 2 * 60 * 60_000;

export const tareaSchema = z.object({
  nombre: z.string().regex(TAREA_NOMBRE),
  estado: z.enum(["corriendo", "ok", "falla"]),
  /** El proceso que la corre; null entre que se lanza y que el proceso arranca. */
  pid: z.int().nullable(),
  inicio: z.iso.datetime(),
  fin: z.iso.datetime().nullable(),
  /** Qué está haciendo, o en qué quedó. */
  mensaje: z.string(),
  /** El comando que la persona tiene que correr en la terminal para seguir, si hace falta. */
  siguiente: z.string().nullable(),
});
export type Tarea = z.infer<typeof tareaSchema>;

/** Lo que devuelve el trabajo de una tarea al terminar bien. */
export interface Fin {
  readonly ok: boolean;
  readonly mensaje: string;
  readonly siguiente?: string;
}

const dirOf = (home: string) => join(home, "tareas");
const fileOf = (home: string, nombre: string) => join(dirOf(home), `${nombre}.json`);
export const tareaLog = (home: string, nombre: string) => join(dirOf(home), `${nombre}.log`);

function nombreOk(nombre: string): string {
  if (!TAREA_NOMBRE.test(nombre)) throw new UserError(`tarea desconocida: ${nombre}`);
  return nombre;
}

function escribir(home: string, tarea: Tarea): void {
  mkdirSync(dirOf(home), { recursive: true });
  writeFileSync(fileOf(home, tarea.nombre), `${JSON.stringify(tarea, null, 2)}\n`);
}

/**
 * La tarea como está: una que dice correr sin proceso vivo se cortó (un reinicio, un kill), y se ve
 * como falla con dónde está el detalle. Undefined si nunca corrió o su archivo no se entiende.
 */
export function leerTarea(
  home: string,
  nombre: string,
  now: Date,
  vivo: (pid: number) => boolean = isAlive,
): Tarea | undefined {
  const file = fileOf(home, nombreOk(nombre));
  if (!existsSync(file)) return undefined;
  let parsed: Tarea;
  try {
    parsed = tareaSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
  if (parsed.estado !== "corriendo") return parsed;
  const lleva = now.getTime() - Date.parse(parsed.inicio);
  const muerta =
    lleva > MAX_TAREA_MS || (parsed.pid === null ? lleva > ARRANQUE_MS : !vivo(parsed.pid));
  if (!muerta) return parsed;
  return {
    ...parsed,
    estado: "falla",
    mensaje: `se cortó sin terminar: el detalle está en ${tareaLog(home, nombre)}`,
  };
}

export function listarTareas(home: string, now: Date): Tarea[] {
  const dir = dirOf(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((n) => TAREA_NOMBRE.test(n))
    .flatMap((n) => leerTarea(home, n, now) ?? [])
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/**
 * Lanza `_tarea <nombre> ...args` en un proceso aparte, salvo que ya esté corriendo. El estado se
 * escribe antes de lanzar: el proceso lo pisa con su pid al arrancar y con el resultado al terminar,
 * así nunca queda un «corriendo» escrito después de un «ok».
 */
export function lanzarTarea(
  home: string,
  nombre: string,
  args: readonly string[],
  mensaje: string,
  env: NodeJS.ProcessEnv,
  now: Date,
): { ok: true; tarea: string; resultado: string } {
  // Mirar y escribir con un candado: sin él, dos pedidos casi juntos lanzaban la tarea dos veces.
  mkdirSync(dirOf(home), { recursive: true });
  const candado = join(dirOf(home), `${nombreOk(nombre)}.lanzando`);
  if (!tryLock(candado))
    return {
      ok: true,
      tarea: nombre,
      resultado: "ya está corriendo: la está lanzando otro pedido",
    };
  try {
    return lanzarConCandado(home, nombre, args, mensaje, env, now);
  } finally {
    rmSync(candado, { force: true });
  }
}

function lanzarConCandado(
  home: string,
  nombre: string,
  args: readonly string[],
  mensaje: string,
  env: NodeJS.ProcessEnv,
  now: Date,
): { ok: true; tarea: string; resultado: string } {
  const actual = leerTarea(home, nombre, now);
  if (actual?.estado === "corriendo")
    return { ok: true, tarea: nombre, resultado: `ya está corriendo: ${actual.mensaje}` };
  escribir(home, {
    nombre: nombreOk(nombre),
    estado: "corriendo",
    pid: null,
    inicio: now.toISOString(),
    fin: null,
    mensaje,
    siguiente: null,
  });
  const log = openSync(tareaLog(home, nombre), "a");
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", BIN, "_tarea", nombre, ...args],
    { detached: true, stdio: ["ignore", log, log], env },
  );
  child.unref();
  return { ok: true, tarea: nombre, resultado: mensaje };
}

/** El proceso de una tarea: anota su pid, corre el trabajo y deja en qué quedó, también si falló. */
export async function correrTarea(
  home: string,
  nombre: string,
  mensaje: string,
  trabajo: () => Promise<Fin>,
  env: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): Promise<Fin> {
  // Lo que escribió `lanzarTarea` dice mejor qué hace («actualizando flowrunner…»): se conserva.
  const lanzada = leerTarea(home, nombre, now());
  const previa = lanzada?.estado === "corriendo" ? lanzada : undefined;
  const inicio = previa?.inicio ?? now().toISOString();
  escribir(home, {
    nombre: nombreOk(nombre),
    estado: "corriendo",
    pid: process.pid,
    inicio,
    fin: null,
    mensaje: previa?.mensaje ?? mensaje,
    siguiente: null,
  });
  let fin: Fin;
  try {
    fin = await trabajo();
  } catch (error) {
    const texto = error instanceof Error ? error.message : String(error);
    const next = error instanceof UserError ? error.next : undefined;
    fin = { ok: false, mensaje: texto, ...(next === undefined ? {} : { siguiente: next }) };
  }
  escribir(home, {
    nombre,
    estado: fin.ok ? "ok" : "falla",
    pid: process.pid,
    inicio,
    fin: now().toISOString(),
    mensaje: fin.mensaje,
    siguiente: fin.siguiente ?? null,
  });
  notifyMac("flowrunner", `${nombre}: ${fin.ok ? "listo" : "no se pudo"}. ${fin.mensaje}`, env);
  return fin;
}

/**
 * El comando que aprueba el plugin, si Orca lo pidió: lo corre la persona en la terminal, porque
 * aprobar un plugin que corre comandos en su máquina es decisión suya (ver `orca install`).
 */
export function aprobarPlugin(salida: string): string | undefined {
  const fp = /--approve\s+([\w.:-]+)/.exec(salida)?.[1];
  return fp === undefined ? undefined : `flowrunner orca install --approve ${fp}`;
}
