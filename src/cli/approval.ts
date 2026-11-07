// `flowrunner plan`, `approve` y `changes`: la persona revisa el plan, desde Claude Code o la terminal.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { allDependencies, subtaskSchema } from "../gates/plan.ts";
import { git } from "../git/git.ts";
import { prepared } from "../phases/inputs.ts";
import { readPlan } from "../phases/planificar.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { loadState, runPaths } from "../store/runs.ts";
import { summarize, runSummarySchema } from "./contracts.ts";
import { UserError } from "./output.ts";
import { handOver } from "./runs.ts";

export const planViewSchema = z.strictObject({
  ok: z.literal(true),
  run: runSummarySchema,
  plan: z.string(),
  subtareas: z.array(subtaskSchema),
  criterios: z.array(z.object({ id: z.string(), comando: z.string(), subtarea: z.string() })),
  tests: z.array(z.string()),
  diff_tests: z.string(),
});

export async function showPlan(home: string, id: string, env: NodeJS.ProcessEnv) {
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "plan.md"))) {
    throw new UserError(`el run ${id} todavía no tiene un plan`, `flowrunner status ${id}`);
  }
  const { events } = readLog(run.dir);
  const plan = readPlan(run);
  const prep = prepared(events);
  const diff = await git(
    prep.worktree,
    ["diff", prep.base_sha, "HEAD", "--", ...Object.keys(plan.locked)],
    env,
  );
  return planViewSchema.parse({
    ok: true,
    run: summarize(loadState(home, id)),
    plan: plan.plan,
    subtareas: plan.subtareas,
    criterios: plan.criterios,
    tests: Object.keys(plan.locked),
    diff_tests: diff,
  });
}

export function describePlan(view: z.infer<typeof planViewSchema>): string {
  const parallel = view.subtareas.filter((t) => t.depende_de.length === 0).map((t) => t.id);
  return [
    `${view.run.id} · ${view.run.status}`,
    `${view.subtareas.length} sub-tasks · ${view.criterios.length} criterios con tests en rojo · arrancan juntas: ${parallel.join(", ")}`,
    "",
    ...view.subtareas.map(
      (t) =>
        `  ${t.id}  ${t.titulo}  ${t.alcance.join(", ")}` +
        (t.depende_de.length > 0 ? `  depende de ${t.depende_de.join(", ")}` : "") +
        (allDependencies(t).length > 0 ? `  agrega ${allDependencies(t).join(", ")}` : ""),
    ),
    "",
    ...view.criterios.map((c) => `  ${c.id} → ${c.subtarea}: ${c.comando}`),
    "",
    view.plan,
    "",
    view.diff_tests,
  ].join("\n");
}

function waitingOrExplain(home: string, id: string) {
  let state;
  try {
    state = loadState(home, id);
  } catch {
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  }
  if (state.status !== "esperando_aprobacion") {
    throw new UserError(
      `el run ${id} está ${state.status}, no esperando aprobación`,
      `flowrunner status ${id}`,
    );
  }
  return state;
}

export function approveRun(home: string, id: string, env: NodeJS.ProcessEnv) {
  const state = waitingOrExplain(home, id);
  const run = runPaths(home, id);
  appendEvent(run.dir, { tipo: "aprobado" });
  handOver(home, state.proyecto, run, env);
  return { ok: true as const, id, accion: "aprobado: implementar arrancó" };
}

export function requestChanges(
  home: string,
  id: string,
  motivo: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (motivo === undefined || motivo.trim() === "") {
    throw new UserError(
      "falta el motivo de los cambios",
      `flowrunner changes ${id} "<qué cambiar>"`,
    );
  }
  const state = waitingOrExplain(home, id);
  const run = runPaths(home, id);
  appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: motivo.trim() });
  handOver(home, state.proyecto, run, env);
  return { ok: true as const, id, accion: "cambios pedidos: planificar vuelve a correr" };
}
