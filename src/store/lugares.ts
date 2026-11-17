// Lugares: cuántos runs de un repo avanzan a la vez (`max_runs`). Un lugar vale mientras su proceso
// vive y su run está en curso: esperar, terminar o morir lo libera (ADR 0019).
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isAlive } from "./lock.ts";
import { conTurnoSync, turnoFile } from "./turno.ts";

/** Entregar tiene su propio carril (ADR 0031); un lugar de antes, sin carril, es normal. */
const carrilSchema = z.enum(["normal", "entrega"]);
export type Carril = z.infer<typeof carrilSchema>;

const lugarSchema = z.strictObject({
  run_id: z.string(),
  pid: z.int(),
  carril: carrilSchema.optional(),
});
export type Lugar = z.infer<typeof lugarSchema>;

export function lugaresDir(home: string, proyecto: string): string {
  return join(home, "locks", proyecto, "lugares");
}

function lugarFile(home: string, proyecto: string, runId: string): string {
  return join(lugaresDir(home, proyecto), `${runId}.json`);
}

/** El lock único de antes del ADR 0019: un run por repo. */
export function lockViejo(home: string, proyecto: string): string {
  return join(home, "locks", `${proyecto}.lock`);
}

/** Un archivo de lugar; undefined si no existe o no se puede leer entero. */
export function leerLugar(file: string): Lugar | undefined {
  try {
    return lugarSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Escribe y renombra: quien lee un lugar lo ve entero o no lo ve. */
function escribir(file: string, lugar: Lugar): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(lugar));
  renameSync(tmp, file);
}

export interface Reglas {
  readonly max: number;
  /** Si el run está en curso según su log. */
  readonly ocupa: (runId: string) => boolean;
  /**
   * El carril del que toma o cuenta: `max` cuenta solo los lugares de ese carril, que queda fijo al
   * tomarlo aunque el run cambie de fase. Normal si falta (ADR 0031).
   */
  readonly carril?: Carril;
  readonly alive?: (pid: number) => boolean;
}

export type Toma = { readonly ok: true } | { readonly ok: false; readonly corriendo: string[] };

/** Los otros runs con un lugar que vale. Con `borrar`, saca de paso los que no valen. */
function vigentes(
  home: string,
  proyecto: string,
  reglas: Reglas,
  opts: { readonly borrar: boolean; readonly salvo?: string },
): string[] {
  const dir = lugaresDir(home, proyecto);
  if (!existsSync(dir)) return [];
  const alive = reglas.alive ?? isAlive;
  const ids: string[] = [];
  for (const entry of readdirSync(dir)
    .filter((e) => e.endsWith(".json"))
    .sort()) {
    const id = entry.slice(0, -".json".length);
    if (id === opts.salvo) continue;
    const lugar = leerLugar(join(dir, entry));
    const vale = lugar !== undefined && lugar.run_id === id && alive(lugar.pid) && reglas.ocupa(id);
    if (vale) ids.push(id);
    else if (opts.borrar) rmSync(join(dir, entry), { force: true });
  }
  return ids;
}

/** El lock viejo pasa a ser un lugar: un run que corría al actualizar no pierde el suyo. */
function migrar(home: string, proyecto: string): void {
  const viejo = lockViejo(home, proyecto);
  if (!existsSync(viejo)) return;
  const lugar = leerLugar(viejo);
  if (lugar !== undefined) escribir(lugarFile(home, proyecto, lugar.run_id), lugar);
  rmSync(viejo, { force: true });
}

/**
 * Le da un lugar al run, o le reescribe el pid si ya tenía uno. Contar y escribir pasan con el turno
 * de lugares: dos comandos a la vez no cuentan los dos el mismo lugar libre.
 */
export function tomarLugar(
  home: string,
  proyecto: string,
  runId: string,
  pid: number,
  reglas: Reglas,
): Toma {
  mkdirSync(lugaresDir(home, proyecto), { recursive: true });
  return conTurnoSync(
    turnoFile(home, proyecto, "lugares"),
    runId,
    (): Toma => {
      migrar(home, proyecto);
      const carril = reglas.carril ?? "normal";
      const otros = delCarril(
        home,
        proyecto,
        carril,
        vigentes(home, proyecto, reglas, { borrar: true, salvo: runId }),
      );
      const file = lugarFile(home, proyecto, runId);
      const propio = leerLugar(file);
      if (propio === undefined && otros.length >= reglas.max)
        return { ok: false, corriendo: otros };
      // Quien ya tenía lugar conserva su carril: se fija una vez, al tomarlo.
      escribir(file, { run_id: runId, pid, carril: propio?.carril ?? carril });
      return { ok: true };
    },
    // Se tiene por milisegundos: diez segundos sin tomarlo es un error, no una espera.
    { limiteMs: 10_000, pausaMs: { desde: 10, hasta: 200 } },
  );
}

/** Los runs que hoy ocupan un lugar, sin tocar nada. */
export function ocupados(home: string, proyecto: string, reglas: Reglas): string[] {
  return delCarril(
    home,
    proyecto,
    reglas.carril ?? "normal",
    vigentes(home, proyecto, reglas, { borrar: false }),
  );
}

/** De los lugares vigentes, los de ese carril. */
function delCarril(
  home: string,
  proyecto: string,
  carril: Carril,
  ids: readonly string[],
): string[] {
  return ids.filter((id) => (lugarDe(home, proyecto, id)?.carril ?? "normal") === carril);
}

export function soltarLugar(home: string, proyecto: string, runId: string): void {
  rmSync(lugarFile(home, proyecto, runId), { force: true });
}

export function lugarDe(home: string, proyecto: string, runId: string): Lugar | undefined {
  return leerLugar(lugarFile(home, proyecto, runId));
}
