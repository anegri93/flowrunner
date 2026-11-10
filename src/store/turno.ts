// Turnos: un lock de archivo para lo que dos runs del mismo repo no pueden usar a la vez, como el
// entorno de verify y probar o el `.git` del checkout. Vale mientras su dueño vive (ADR 0019).
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { isAlive } from "./lock.ts";

const dueñoSchema = z.strictObject({ run_id: z.string(), pid: z.int(), token: z.string() });
export type Dueño = z.infer<typeof dueñoSchema>;

/** `cola` serializa despachar la cola; adentro se toma `lugares`, nunca al revés. */
export type NombreTurno = "entorno" | "lecciones" | "lugares" | "cola";

export function turnoFile(home: string, proyecto: string, nombre: NombreTurno): string {
  return join(home, "locks", proyecto, `${nombre}.lock`);
}

/** Dos horas por defecto: lo que tarda un probar largo de otro run, con margen. */
export const LIMITE_TURNO_MS = 2 * 60 * 60_000;

export class TurnoAgotadoError extends Error {
  constructor(file: string, dueño: Dueño, limiteMs: number) {
    const minutos = Math.round(limiteMs / 60_000);
    super(
      `${String(minutos)} min esperando el turno de ${basename(file, ".lock")}, que tiene ${dueño.run_id} (pid ${String(dueño.pid)}); cuando termine, retomá este run`,
    );
    this.name = "TurnoAgotadoError";
  }
}

function readRaw(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parse(raw: string): Dueño | undefined {
  try {
    return dueñoSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function leerTurno(file: string): Dueño | undefined {
  const raw = readRaw(file);
  return raw === undefined ? undefined : parse(raw);
}

/**
 * Crea `file` con el contenido entero o falla con EEXIST: el link es atómico, así que nadie lee un
 * lock a medio escribir y lo toma por roto.
 */
function crearExclusivo(file: string, content: string): boolean {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Saca un lock vencido sin pisar uno nuevo: lo mueve a un nombre propio y lo borra solo si es el que
 * se leyó. Si entre la lectura y el movimiento otro ya lo había roto y tomado, lo devuelve a su lugar.
 */
function romperVencido(file: string, leido: string): void {
  const aparte = `${file}.${randomUUID()}.vencido`;
  try {
    renameSync(file, aparte);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    if (readFileSync(aparte, "utf8") !== leido) linkSync(aparte, file);
  } catch (error) {
    // EEXIST: un tercero ya creó el lock; el que se movió por error queda sin archivo. Hace falta que
    // tres procesos coincidan en microsegundos con un dueño muerto: no se protege más que esto.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(aparte, { force: true });
  }
}

export type Intento =
  | { readonly tipo: "tomado"; readonly dueño: Dueño }
  | { readonly tipo: "ocupado"; readonly dueño: Dueño };

/** Toma el turno si está libre o su dueño murió; si no, dice quién lo tiene. No espera. */
export function intentarTurno(
  file: string,
  runId: string,
  alive: (pid: number) => boolean = isAlive,
): Intento {
  mkdirSync(dirname(file), { recursive: true });
  const mio: Dueño = { run_id: runId, pid: process.pid, token: randomUUID() };
  const content = JSON.stringify(mio);
  for (;;) {
    if (crearExclusivo(file, content)) return { tipo: "tomado", dueño: mio };
    const raw = readRaw(file);
    if (raw === undefined) continue;
    const actual = parse(raw);
    // Un dueño en este mismo proceso también ocupa: dos sub-tasks de un run comparten el pid.
    if (actual !== undefined && alive(actual.pid)) return { tipo: "ocupado", dueño: actual };
    romperVencido(file, raw);
  }
}

/** Suelta el turno solo si sigue siendo de quien lo tomó. */
export function soltarTurno(file: string, dueño: Dueño): void {
  if (leerTurno(file)?.token === dueño.token) rmSync(file, { force: true });
}

export interface EsperaTurno {
  readonly limiteMs?: number;
  /** El intervalo entre intentos crece de `desde` a `hasta`. */
  readonly pausaMs?: { readonly desde: number; readonly hasta: number };
  /** Se llama una vez, la primera vez que el turno está ocupado. */
  readonly alEsperar?: (dueño: Dueño) => void;
  readonly ahora?: () => number;
  readonly alive?: (pid: number) => boolean;
}

/**
 * Las esperas de este proceso, por archivo: dos sub-tasks del mismo run se turnan en memoria, en el
 * orden en que llegan y sin la demora de revisar el archivo. El archivo turna entre procesos.
 */
const enEsteProceso = new Map<string, Promise<void>>();

/** Espera el turno, corre `fn` y lo suelta aunque `fn` falle. */
export async function conTurno<T>(
  file: string,
  runId: string,
  fn: () => Promise<T>,
  opts: EsperaTurno & { readonly esperar?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const anterior = enEsteProceso.get(file) ?? Promise.resolve();
  let liberar = () => {};
  const propia = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  const fila = anterior.then(() => propia);
  enEsteProceso.set(file, fila);
  try {
    await anterior;
    const esperar = opts.esperar ?? ((ms: number) => sleep(ms));
    const dueño = await esperarCon(file, runId, opts, esperar);
    try {
      return await fn();
    } finally {
      soltarTurno(file, dueño);
    }
  } finally {
    liberar();
    if (enEsteProceso.get(file) === fila) enEsteProceso.delete(file);
  }
}

/**
 * Lo mismo para código sincrónico: el CLI, que toma lugares, y abort, que borra worktrees. Mientras
 * espera bloquea el proceso, así que un mismo archivo nunca se espera sincrónico en un proceso que lo
 * puede tener tomado con `conTurno`: el dueño no podría soltarlo. Hoy `cola` y `lugares` son solo
 * sincrónicos, y el de git sincrónico solo lo usa abort, desde el CLI.
 */
export function conTurnoSync<T>(
  file: string,
  runId: string,
  fn: () => T,
  opts: EsperaTurno = {},
): T {
  const dueño = esperarSync(file, runId, opts);
  try {
    return fn();
  } finally {
    soltarTurno(file, dueño);
  }
}

const DEFAULT_PAUSA = { desde: 2_000, hasta: 15_000 };

async function esperarCon(
  file: string,
  runId: string,
  opts: EsperaTurno,
  esperar: (ms: number) => Promise<void>,
): Promise<Dueño> {
  const ahora = opts.ahora ?? Date.now;
  const limite = opts.limiteMs ?? LIMITE_TURNO_MS;
  const { desde, hasta } = opts.pausaMs ?? DEFAULT_PAUSA;
  const inicio = ahora();
  let pausa = desde;
  let avisado = false;
  for (;;) {
    const intento = intentarTurno(file, runId, opts.alive);
    if (intento.tipo === "tomado") return intento.dueño;
    if (!avisado) {
      opts.alEsperar?.(intento.dueño);
      avisado = true;
    }
    if (ahora() - inicio >= limite) throw new TurnoAgotadoError(file, intento.dueño, limite);
    await esperar(pausa);
    pausa = Math.min(hasta, pausa * 2);
  }
}

function esperarSync(file: string, runId: string, opts: EsperaTurno): Dueño {
  const ahora = opts.ahora ?? Date.now;
  const limite = opts.limiteMs ?? LIMITE_TURNO_MS;
  const { desde, hasta } = opts.pausaMs ?? DEFAULT_PAUSA;
  const inicio = ahora();
  const celda = new Int32Array(new SharedArrayBuffer(4));
  let pausa = desde;
  for (;;) {
    const intento = intentarTurno(file, runId, opts.alive);
    if (intento.tipo === "tomado") return intento.dueño;
    if (ahora() - inicio >= limite) throw new TurnoAgotadoError(file, intento.dueño, limite);
    Atomics.wait(celda, 0, 0, pausa);
    pausa = Math.min(hasta, pausa * 2);
  }
}
