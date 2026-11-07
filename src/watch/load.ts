// Lo que `flowrunner watch` lee del disco: el log, el plan, el título y los transcripts de cada run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateOf, TERMINAL } from "../engine/engine.ts";
import { transcriptSteps, type Step } from "../report/transcript.ts";
import { loadRepoConfig } from "../config/load.ts";
import { DEFAULT_MODELS } from "../config/schemas.ts";
import type { Phase } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import { listRunIds, runPaths } from "../store/runs.ts";
import { runTree, tidyStep, type RunTree, type SessionFile } from "./tree.ts";

function readTasks(dir: string): { id: string; titulo: string; depende_de: string[] }[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((t: { id?: unknown; titulo?: unknown; depende_de?: unknown }) => ({
      id: String(t.id),
      titulo: String(t.titulo),
      depende_de: Array.isArray(t.depende_de) ? t.depende_de.map(String) : [],
    }));
  } catch {
    return []; // todavía no hay plan
  }
}

function readTitle(dir: string): string {
  try {
    return (
      /^titulo:\s*(.+)$/m.exec(readFileSync(join(dir, "feature.md"), "utf8"))?.[1]?.trim() ?? ""
    );
  } catch {
    return "";
  }
}

function readSessions(dir: string): Map<string, SessionFile> {
  const sesiones = join(dir, "sesiones");
  const out = new Map<string, SessionFile>();
  if (!existsSync(sesiones)) return out;
  for (const file of readdirSync(sesiones)) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(sesiones, file);
    const stat = statSync(path);
    out.set(file.slice(0, -6), {
      jsonl: readFileSync(path, "utf8"),
      birthMs: stat.birthtimeMs,
      mtimeMs: stat.mtimeMs,
    });
  }
  return out;
}

/** El esfuerzo de cada fase con agente: el de la config del repo, o el de flowrunner si no se lee. */
function readEfforts(repo: string | undefined): Partial<Record<Phase, string>> {
  let models: Record<string, { effort: string }> = DEFAULT_MODELS;
  try {
    if (repo !== undefined) models = loadRepoConfig(repo).models;
  } catch {
    // la config todavía no está en el checkout de la persona: quedan los defaults
  }
  return Object.fromEntries(Object.entries(models).map(([fase, m]) => [fase, m.effort]));
}

export function loadTree(home: string, id: string, now: number): RunTree {
  const { dir } = runPaths(home, id);
  const events = readLog(dir).events;
  const created = events.find((e) => e.tipo === "run_creado");
  return runTree({
    events,
    esfuerzos: readEfforts(created?.tipo === "run_creado" ? created.repo : undefined),
    tasks: readTasks(dir),
    titulo: readTitle(dir),
    sessions: readSessions(dir),
    now,
  });
}

/** Los pasos de una sesión, como texto de terminal: sin el escapado que lleva el informe Markdown. */
export function loadSteps(home: string, id: string, session: string): Step[] {
  const file = join(runPaths(home, id).dir, "sesiones", `${session}.jsonl`);
  if (!existsSync(file)) return [];
  const { worktrees } = runPaths(home, id);
  return transcriptSteps(readFileSync(file, "utf8")).map((s) =>
    tidyStep(
      {
        ...s,
        texto: s.texto.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
      },
      worktrees,
    ),
  );
}

/** Un run por su id o por su clave: con la clave, el más reciente. */
export function resolveRun(home: string, arg: string): string | undefined {
  const ids = listRunIds(home);
  if (ids.includes(arg)) return arg;
  return ids
    .filter((id) => id.startsWith(`${arg}-`))
    .sort()
    .at(-1);
}

/** Los runs que todavía piden atención: los que no están cerrados ni abortados. */
export function activeRuns(home: string): string[] {
  return listRunIds(home)
    .filter((id) => {
      try {
        return !TERMINAL.has(stateOf(readLog(runPaths(home, id).dir).events).status);
      } catch {
        return false;
      }
    })
    .sort();
}
