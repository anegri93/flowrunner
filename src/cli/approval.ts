// `flowrunner plan`, `approve` y `changes`: la persona revisa el plan, desde Claude Code o la terminal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadRepoConfig } from "../config/load.ts";
import {
  allDependencies,
  cambioExistenteSchema,
  effectiveScope,
  scopeOverlap,
  subtaskSchema,
  type CambioExistente,
  type PlanRepoRules,
  type Subtask,
} from "../gates/plan.ts";
import { git } from "../git/git.ts";
import { prepared } from "../phases/inputs.ts";
import { planChanges, previousDir } from "../phases/plan-anterior.ts";
import { readPlan, readPlanAt } from "../phases/planificar.ts";
import type { Origen } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { listRunIds, loadState, runPaths } from "../store/runs.ts";
import { summarize, runSummarySchema } from "./contracts.ts";
import { UserError } from "./output.ts";
import { lanzamiento, lanzarOEncolar } from "./runs.ts";

/** Otro run del proyecto cuyo alcance se pisa con este plan. Avisa; no bloquea (ADR 0019). */
export const pisadaSchema = z.strictObject({
  run: z.string(),
  status: runSummarySchema.shape.status,
  /** La PR del otro run, si ya la abrió: un run entregado soltó su lugar, pero su PR sigue abierta. */
  pr: z.int().nullable(),
  /** Las rutas de este plan que también toca el otro. */
  archivos: z.array(z.string()).min(1),
});
export type Pisada = z.infer<typeof pisadaSchema>;

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
  /** Los otros runs del proyecto, con la PR sin cerrar, cuyo alcance se pisa con este plan. */
  se_pisa_con: z.array(pisadaSchema),
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
    se_pisa_con: pisadas(home, id, plan.subtareas, loadRepoConfig(prep.worktree)),
    cambios: existsSync(join(previousDir(run), "plan.md"))
      ? planChanges(readPlanAt(previousDir(run)), plan)
      : null,
  });
}

/** Las sub-tasks de otro run, o nada si su plan no está o no se lee: el aviso no inventa choques. */
function subtasksOf(home: string, id: string): Subtask[] | undefined {
  const file = join(runPaths(home, id).dir, "tasks.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = z.array(subtaskSchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Un tasks.json a medio escribir por el planificador del otro run: se mira en el próximo plan.
    return undefined;
  }
}

/**
 * Compara el alcance efectivo de este plan con el de cada otro run del proyecto cuya PR no se cerró.
 * Los tripwires no dejan escribir fuera del alcance, así que es un techo de lo que cada run toca.
 */
export function pisadas(
  home: string,
  id: string,
  subtareas: readonly Subtask[],
  rules: PlanRepoRules,
): Pisada[] {
  const proyecto = loadState(home, id).proyecto;
  const own = subtareas.flatMap((t) => effectiveScope(t, rules));
  const out: Pisada[] = [];
  for (const other of listRunIds(home)) {
    if (other === id) continue;
    const state = loadState(home, other);
    if (state.proyecto !== proyecto || state.status === "cerrado" || state.status === "abortado")
      continue;
    const theirs = subtasksOf(home, other);
    if (theirs === undefined) continue;
    const archivos = scopeOverlap(
      own,
      theirs.flatMap((t) => effectiveScope(t, rules)),
    );
    if (archivos.length === 0) continue;
    const pr = readLog(runPaths(home, other).dir).events.findLast((e) => e.tipo === "pr");
    out.push({
      run: other,
      status: state.status,
      pr: pr?.tipo === "pr" ? pr.numero : null,
      archivos,
    });
  }
  return out;
}

export function describePlan(view: z.infer<typeof planViewSchema>): string {
  const parallel = view.subtareas.filter((t) => t.depende_de.length === 0).map((t) => t.id);
  return [
    `${view.run.id} · ${view.run.status}`,
    `${view.subtareas.length} sub-tasks · ${view.criterios.length} criterios con tests en rojo · arrancan juntas: ${parallel.join(", ")}`,
    ...existingText(view.cambia_lo_existente),
    ...overlapText(view.se_pisa_con),
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

/** Al lado de lo que cambia: decidir si aprobar igual o esperar al otro run es de la persona. */
function overlapText(pisadas: readonly Pisada[]): string[] {
  if (pisadas.length === 0) return [];
  return [
    "",
    "⚠ Se pisa con otros runs del proyecto. No bloquea: aprobá, esperá al otro o abortá:",
    ...pisadas.map(
      (p) =>
        `  - ${p.run} (${p.status}${p.pr === null ? "" : `, PR #${String(p.pr)}`}): ${p.archivos.join(", ")}`,
    ),
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
  origen: Origen = "terminal",
) {
  waitingOrExplain(home, id);
  const run = runPaths(home, id);
  const cambios = readPlan(run).cambia_lo_existente;
  if (cambios.length > 0 && !aceptaCambios) {
    throw new UserError(
      `el plan de ${id} cambia lo que ya existe:\n${cambios.map((c) => `- ${c.que} (${c.donde}) ← ${c.criterio}`).join("\n")}\nSi esos cambios van, aprobá con --acepto-cambios; si no, pedí cambios`,
      `flowrunner approve ${id} --acepto-cambios`,
    );
  }
  appendEvent(run.dir, { tipo: "aprobado", cambios_aceptados: cambios.length, origen });
  return lanzamiento(
    id,
    "aprobado: implementar arrancó",
    "aprobado",
    lanzarOEncolar(home, id, env),
  );
}

export function requestChanges(
  home: string,
  id: string,
  motivo: string | undefined,
  env: NodeJS.ProcessEnv,
  origen: Origen = "terminal",
) {
  if (motivo === undefined || motivo.trim() === "") {
    throw new UserError(
      "falta el motivo de los cambios",
      `flowrunner changes ${id} "<qué cambiar>"`,
    );
  }
  waitingOrExplain(home, id);
  const run = runPaths(home, id);
  appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: motivo.trim(), origen });
  return lanzamiento(
    id,
    "cambios pedidos: planificar vuelve a correr",
    "cambios pedidos",
    lanzarOEncolar(home, id, env),
  );
}
