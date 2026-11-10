// El plan anterior de un run: lo que una nueva vuelta de planificar tiene que conservar. Sin él, cada
// pedido de cambios rehacía el diseño entero y perdía lo que habían corregido los pedidos de antes.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateOf } from "../engine/engine.ts";
import type { Plan } from "../gates/plan.ts";
import type { RunPaths } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";

const ARTIFACTS = ["plan.md", "tasks.json", "ac-map.json", "locked.json"] as const;
/** Los que un run planificado antes de que existieran no tiene. */
const OPTIONAL_ARTIFACTS = ["cambios-existentes.json"] as const;

export const previousDir = (run: RunPaths) => join(run.dir, "anterior");

/** Guarda el plan vigente en `anterior/` antes de que una nueva vuelta lo reemplace. */
export function archivePlan(run: RunPaths): boolean {
  if (!existsSync(join(run.dir, "plan.md"))) return false;
  mkdirSync(previousDir(run), { recursive: true });
  for (const name of ARTIFACTS) copyFileSync(join(run.dir, name), join(previousDir(run), name));
  for (const name of OPTIONAL_ARTIFACTS) {
    const from = join(run.dir, name);
    if (existsSync(from)) copyFileSync(from, join(previousDir(run), name));
    else rmSync(join(previousDir(run), name), { force: true });
  }
  return true;
}

export interface PlanSnapshot {
  readonly plan: string;
  readonly subtareas: Plan["subtareas"];
  readonly criterios: Plan["criterios"];
  readonly locked: Record<string, string>;
}

/** Lo que tiene que volver a pensar planificar: los pedidos de la persona y el motivo de este intento. */
export interface Replan {
  readonly pedidos: readonly string[];
  readonly motivo: string | undefined;
}

/**
 * Los pedidos de cambios del run, en orden, y el motivo de este intento: el del gate, el último pedido,
 * o, en un `rerun --desde planificar`, el motivo con que se había detenido el run.
 */
export function replanOf(events: readonly RunEvent[], instruccion: string | undefined): Replan {
  const pedidos = events.flatMap((e) => (e.tipo === "cambios_pedidos" ? [e.motivo] : []));
  if (instruccion !== undefined) return { pedidos, motivo: instruccion };
  const rerun = events.findLastIndex((e) => e.tipo === "rehacer" && e.desde === "planificar");
  const lastStart = events.findLastIndex(
    (e) => e.tipo === "accion_iniciada" && e.fase === "planificar",
  );
  const previousStart = events
    .slice(0, lastStart)
    .findLastIndex((e) => e.tipo === "accion_iniciada" && e.fase === "planificar");
  const isRerun = rerun > previousStart;
  return {
    pedidos,
    motivo: isRerun ? stateOf(events.slice(0, rerun)).halt?.motivo : undefined,
  };
}

/** Una sub-task del plan anterior con su código en el worktree, para el prompt del replan. */
export interface Implementada {
  readonly id: string;
  readonly titulo: string;
  readonly alcance: readonly string[];
  readonly commits: number;
}

/** La sección del prompt con el plan anterior y la historia, o la instrucción sola si no hay plan anterior. */
export function replanText(
  previous: PlanSnapshot | undefined,
  replan: Replan,
  implementadas: readonly Implementada[] = [],
): string {
  if (previous === undefined) {
    return replan.motivo === undefined
      ? ""
      : `# Atención: este es un nuevo intento\n\n${replan.motivo}\n\nCorregilo en este plan.`;
  }
  const last = replan.pedidos.at(-1);
  return [
    "# Atención: este es un nuevo intento sobre un plan que ya existe",
    "",
    "Abajo está el plan anterior. Sus tests ya están escritos en el repo, tal como quedaron bloqueados. Partí de ese plan y cambiá solo lo que piden los pedidos y el motivo de este intento: mantené todo lo demás, con los mismos nombres, sub-tasks, alcances y tests. Explorá solo el código que toca lo que hay que corregir. Un test del plan anterior que no declares en `tests` se borra.",
    ...(replan.pedidos.length === 0
      ? []
      : [
          "",
          "## Lo que pidió la persona, en orden",
          "",
          "Todos siguen vigentes: corregir el último no deshace los anteriores.",
          "",
          ...replan.pedidos.map((p, i) => `${String(i + 1)}. ${p}`),
        ]),
    ...(replan.motivo === undefined || replan.motivo === last
      ? []
      : ["", "## El motivo de este intento", "", replan.motivo]),
    "",
    "## El plan anterior",
    "",
    previous.plan.trim(),
    "",
    "Sub-tasks:",
    "",
    "```json",
    JSON.stringify(previous.subtareas, null, 2),
    "```",
    "",
    "Criterios:",
    "",
    "```json",
    JSON.stringify(previous.criterios, null, 2),
    "```",
    ...(implementadas.length === 0
      ? []
      : [
          "",
          "## Ya implementado en el worktree",
          "",
          "Estas sub-tasks del plan anterior están implementadas y su código está en el worktree que ves. Si una sigue igual (mismo id, mismo alcance, y ni los pedidos ni el motivo de este intento la tocan), devolvela con `conserva: true`: su código queda y no se vuelve a implementar. Si cambia, devolvela con `conserva: false` o sin el campo: su código se saca antes de implementar.",
          "",
          ...implementadas.map(
            (t) =>
              `- ${t.id} · ${t.titulo} · ${t.alcance.join(", ")} · ${String(t.commits)} commits`,
          ),
        ]),
  ].join("\n");
}

export interface PlanChanges {
  readonly subtareas_agregadas: string[];
  readonly subtareas_quitadas: string[];
  readonly alcance_agregado: string[];
  readonly alcance_quitado: string[];
  readonly tests_agregados: string[];
  readonly tests_quitados: string[];
}

/** Qué cambió contra el plan anterior, para que la persona vea enseguida si se perdió algo. */
export function planChanges(
  before: Pick<PlanSnapshot, "subtareas" | "locked">,
  after: Pick<PlanSnapshot, "subtareas" | "locked">,
): PlanChanges {
  const minus = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));
  const names = (p: typeof before) => p.subtareas.map((t) => `${t.id} ${t.titulo}`);
  const scope = (p: typeof before) => [...new Set(p.subtareas.flatMap((t) => t.alcance))];
  const tests = (p: typeof before) => Object.keys(p.locked);
  return {
    subtareas_agregadas: minus(names(after), names(before)),
    subtareas_quitadas: minus(names(before), names(after)),
    alcance_agregado: minus(scope(after), scope(before)),
    alcance_quitado: minus(scope(before), scope(after)),
    tests_agregados: minus(tests(after), tests(before)),
    tests_quitados: minus(tests(before), tests(after)),
  };
}
