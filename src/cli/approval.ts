// `flowrunner plan`, `approve` y `changes`: la persona revisa el plan, desde Claude Code o la terminal.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  allDependencies,
  cambioExistenteSchema,
  subtaskSchema,
  type CambioExistente,
} from "../gates/plan.ts";
import { git } from "../git/git.ts";
import { prepared } from "../phases/inputs.ts";
import { planChanges, previousDir } from "../phases/plan-anterior.ts";
import { readPlan, readPlanAt } from "../phases/planificar.ts";
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
  /** Lo que hoy existe y el plan cambia. Con algo acá, `approve` pide `--acepto-cambios`. */
  cambia_lo_existente: z.array(cambioExistenteSchema),
  /** Qué cambió contra el plan anterior; null en el primer plan. */
  cambios: z
    .strictObject({
      subtareas_agregadas: z.array(z.string()),
      subtareas_quitadas: z.array(z.string()),
      alcance_agregado: z.array(z.string()),
      alcance_quitado: z.array(z.string()),
      tests_agregados: z.array(z.string()),
      tests_quitados: z.array(z.string()),
    })
    .nullable(),
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
    cambia_lo_existente: plan.cambia_lo_existente,
    cambios: existsSync(join(previousDir(run), "plan.md"))
      ? planChanges(readPlanAt(previousDir(run)), plan)
      : null,
  });
}

export function describePlan(view: z.infer<typeof planViewSchema>): string {
  const parallel = view.subtareas.filter((t) => t.depende_de.length === 0).map((t) => t.id);
  return [
    `${view.run.id} · ${view.run.status}`,
    `${view.subtareas.length} sub-tasks · ${view.criterios.length} criterios con tests en rojo · arrancan juntas: ${parallel.join(", ")}`,
    ...existingText(view.cambia_lo_existente),
    "",
    ...view.subtareas.map(
      (t) =>
        `  ${t.id}  ${t.titulo}  ${t.alcance.join(", ")}` +
        (t.depende_de.length > 0 ? `  depende de ${t.depende_de.join(", ")}` : "") +
        (allDependencies(t).length > 0 ? `  agrega ${allDependencies(t).join(", ")}` : ""),
    ),
    "",
    ...view.criterios.map((c) => `  ${c.id} → ${c.subtarea}: ${c.comando}`),
    ...changesText(view.cambios),
    "",
    view.plan,
    "",
    view.diff_tests,
  ].join("\n");
}

/** Arriba de todo: es lo primero que tiene que leer quien aprueba. */
function existingText(cambios: readonly CambioExistente[]): string[] {
  if (cambios.length === 0) return [];
  return [
    "",
    `⚠ Cambia lo que ya existe (${String(cambios.length)}). Aprobar pide --acepto-cambios:`,
    ...cambios.map((c) => `  - ${c.que} (${c.donde}) ← ${c.criterio}`),
  ];
}

function changesText(cambios: z.infer<typeof planViewSchema>["cambios"]): string[] {
  if (cambios === null) return [];
  const rows = [
    ["sub-tasks nuevas", cambios.subtareas_agregadas],
    ["sub-tasks que ya no están", cambios.subtareas_quitadas],
    ["alcance nuevo", cambios.alcance_agregado],
    ["alcance que ya no está", cambios.alcance_quitado],
    ["tests nuevos", cambios.tests_agregados],
    ["tests que ya no están", cambios.tests_quitados],
  ] as const;
  const changed = rows.filter(([, items]) => items.length > 0);
  return [
    "",
    "Contra el plan anterior:",
    ...(changed.length === 0
      ? ["  las mismas sub-tasks, alcances y tests"]
      : changed.map(([label, items]) => `  ${label}: ${items.join(", ")}`)),
  ];
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

/**
 * Un plan que cambia lo que ya existe no se aprueba de pasada: hace falta `--acepto-cambios`, que solo
 * se escribe después de haberlos visto. Lo mismo vale para un panel o una sesión que aprueba por la
 * persona: sin el flag, el error le muestra qué cambia.
 */
export function approveRun(
  home: string,
  id: string,
  env: NodeJS.ProcessEnv,
  aceptaCambios = false,
) {
  const state = waitingOrExplain(home, id);
  const run = runPaths(home, id);
  const cambios = readPlan(run).cambia_lo_existente;
  if (cambios.length > 0 && !aceptaCambios) {
    throw new UserError(
      `el plan de ${id} cambia lo que ya existe:\n${cambios.map((c) => `- ${c.que} (${c.donde}) ← ${c.criterio}`).join("\n")}\nSi esos cambios van, aprobá con --acepto-cambios; si no, pedí cambios`,
      `flowrunner approve ${id} --acepto-cambios`,
    );
  }
  appendEvent(run.dir, { tipo: "aprobado", cambios_aceptados: cambios.length });
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
