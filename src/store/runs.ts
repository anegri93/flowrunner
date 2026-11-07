// Los runs en disco: crear su directorio, encontrarlos y saber en qué están.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateOf, TERMINAL, type RunState } from "../engine/engine.ts";
import type { RunPaths } from "../runner/types.ts";
import type { HolderStatus } from "./lock.ts";
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
  readonly budgetUsd: number;
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
      budget_usd: run.budgetUsd,
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

/** Para el lock: un run entregado ya soltó el repo; uno en espera lo conserva sin proceso. */
export function holderStatus(home: string, id: string): HolderStatus {
  let state: RunState;
  try {
    state = loadState(home, id);
  } catch {
    return "terminado";
  }
  if (TERMINAL.has(state.status) || state.status === "entregado") return "terminado";
  if (state.status === "esperando_aprobacion" || state.status === "pausado_por_limite") {
    return "esperando";
  }
  return "activo";
}
