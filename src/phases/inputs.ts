// Lo que las fases leen del run: la feature copiada, las rutas de trabajo y la preparación hecha.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFeature, type Feature } from "../feature/feature.ts";
import type { RunPaths } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";

export function runFeature(run: RunPaths): Feature {
  const file = join(run.dir, "feature.md");
  return parseFeature(file, readFileSync(file, "utf8"));
}

export const featureWorktree = (run: RunPaths) => join(run.worktrees, "feature");
export const graftIndex = (run: RunPaths) => join(run.dir, "graft");

/** La rama de la feature: `feat/<clave>-<título en minúsculas, sin tildes>`. */
export function featureBranch(feature: Feature): string {
  const slug = feature.titulo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `feat/${feature.clave}-${slug}`;
}

export type Prepared = Extract<RunEvent, { tipo: "preparado" }>;

export function prepared(events: readonly RunEvent[]): Prepared {
  const last = events.findLast((e): e is Prepared => e.tipo === "preparado");
  if (last === undefined) throw new Error("el run no pasó por preparar");
  return last;
}
