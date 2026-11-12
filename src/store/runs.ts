// Los runs en disco: crear su directorio, encontrarlos y saber en qué están.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_NETWORK_RETRIES, stateOf, type RunState } from "../engine/engine.ts";
import type { RunPaths } from "../runner/types.ts";
import type { RunEvent } from "./events.ts";
import { appendEvent, readLog } from "./run-log.ts";

export function runPaths(home: string, id: string): RunPaths {
  return { id, home, dir: join(home, "runs", id), worktrees: join(home, "worktrees", id) };
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export interface NewRun {
  readonly clave: string;
  readonly proyecto: string;
  readonly repo: string;
  readonly budgetUsd?: number | undefined;
  /** Las vueltas automáticas de la config del repo; sin ellas, el run vale las de antes (2). */
  readonly vueltas?: number | undefined;
  readonly featureText: string;
}

export function createRun(home: string, run: NewRun, now: Date): RunPaths {
  let id = `${run.clave}-${stamp(now)}`;
  for (let n = 2; existsSync(runPaths(home, id).dir); n++) id = `${run.clave}-${stamp(now)}-${n}`;
  const paths = runPaths(home, id);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, "feature.md"), run.featureText);
  appendEvent(
    paths.dir,
    {
      tipo: "run_creado",
      run_id: id,
      clave: run.clave,
      proyecto: run.proyecto,
      repo: run.repo,
      ...(run.budgetUsd === undefined ? {} : { budget_usd: run.budgetUsd }),
      ...(run.vueltas === undefined ? {} : { vueltas: run.vueltas }),
      reintentos_red: MAX_NETWORK_RETRIES,
    },
    () => now,
  );
  return paths;
}

export function listRunIds(home: string): string[] {
  const dir = join(home, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "events.jsonl")))
    .map((d) => d.name)
    .sort();
}

export function loadState(home: string, id: string): RunState {
  const paths = runPaths(home, id);
  if (!existsSync(join(paths.dir, "events.jsonl"))) throw new Error(`no existe el run ${id}`);
  return stateOf(readLog(paths.dir).events);
}

/** Si el run ocupa un lugar del repo: solo uno en curso. Uno que no existe no ocupa. */
export function ocupaLugar(home: string, id: string): boolean {
  try {
    return loadState(home, id).status === "en_curso";
  } catch {
    return false;
  }
}

export interface EnCola {
  readonly id: string;
  readonly state: RunState;
}

/**
 * Cuándo se priorizó el run en esta pasada por la cola: un `priorizado` después de su último
 * `reanudado`. Salir de la cola lo gasta.
 */
export function priorizadoEn(events: readonly RunEvent[]): string | undefined {
  const salio = events.findLastIndex((e) => e.tipo === "reanudado");
  return events.slice(salio + 1).findLast((e) => e.tipo === "priorizado")?.at;
}

/**
 * Los runs del proyecto en cola: primero los priorizados, el priorizado más reciente antes; después el
 * resto, el más viejo primero: el que antes se creó, antes sale.
 */
export function colaDe(home: string, proyecto: string): EnCola[] {
  const out: (EnCola & { readonly creado: string; readonly priorizado: string })[] = [];
  for (const id of listRunIds(home)) {
    const { events } = readLog(runPaths(home, id).dir);
    const state = stateOf(events);
    if (state.proyecto !== proyecto || state.status !== "en_cola") continue;
    out.push({ id, state, creado: events[0]?.at ?? "", priorizado: priorizadoEn(events) ?? "" });
  }
  return out
    .sort(
      (a, b) =>
        b.priorizado.localeCompare(a.priorizado) ||
        a.creado.localeCompare(b.creado) ||
        a.id.localeCompare(b.id),
    )
    .map(({ id, state }) => ({ id, state }));
}
