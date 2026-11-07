// Un run preparado y con plan, listo para implementar: lo que dejarían preparar y planificar.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../../src/gates/plan.ts";
import { commitAll } from "../../src/git/git.ts";
import { prepared } from "../../src/phases/inputs.ts";
import { writePlanArtifacts } from "../../src/phases/planificar.ts";
import { preparar } from "../../src/phases/preparar.ts";
import type { Deps, RunPaths } from "../../src/runner/types.ts";
import { appendEvent, readLog } from "../../src/store/run-log.ts";
import { FEATURE } from "./plan-fixtures.ts";
import { contextFor, makeProject, newRun, writeFiles, type ProjectOptions } from "./project.ts";

export async function plannedRun(
  plan: Plan,
  tests: Record<string, string>,
  deps: Deps,
  project: ProjectOptions = {},
  feature = FEATURE,
): Promise<{ run: RunPaths; featureWt: string; work: string; baseSha: string }> {
  const { work } = makeProject({
    config: { setup: "true", tests_globs: ["tests/**"] },
    ...project,
  });
  const run = newRun(work, feature);
  const outcome = await preparar(contextFor(run, "preparar", deps));
  if (outcome.tipo !== "ok") throw new Error(`preparar falló: ${JSON.stringify(outcome)}`);
  const prep = prepared(readLog(run.dir).events);
  writeFiles(prep.worktree, tests);
  await commitAll(prep.worktree, "test: criterios en rojo", { "Flowrunner-Run": run.id }, deps.env);
  const locked = Object.fromEntries(
    Object.keys(tests).map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(join(prep.worktree, p), "utf8"))
        .digest("hex"),
    ]),
  );
  writePlanArtifacts(run, plan, locked);
  for (const fase of ["planificar", "aprobar"] as const) {
    appendEvent(run.dir, { tipo: "accion_iniciada", fase });
    appendEvent(run.dir, { tipo: "accion_terminada", fase, resultado: { tipo: "ok" } });
  }
  appendEvent(run.dir, { tipo: "accion_iniciada", fase: "implementar" });
  return { run, featureWt: prep.worktree, work, baseSha: prep.base_sha };
}
