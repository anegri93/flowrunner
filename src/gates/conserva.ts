// Qué código conserva un replan (ADR 0024). El plan marca `conserva: true` en lo que no cambia; esto
// decide si se puede, sin git ni graft: lo que se conserva no se vuelve a implementar ni a mirar, así
// que ante la duda no se conserva.
import { ancestors, normalize, overlaps, type Plan, type Subtask } from "./plan.ts";

/** Una sub-task implementada en la rama antes del replan. */
export interface Candidata {
  readonly id: string;
  /** Los commits de la rama vieja con su trailer, en orden. */
  readonly shas: readonly string[];
}

export interface ConservaInput {
  readonly plan: Pick<Plan, "subtareas" | "cambia_lo_existente">;
  /** Las sub-tasks del plan anterior, para comparar alcances. */
  readonly anteriores: readonly Subtask[];
  readonly candidatas: readonly Candidata[];
  /** Los pedidos de cambios y el motivo de este replan (`replanOf`), en texto. */
  readonly pedidos: readonly string[];
  /** Por cada `simbolo` de cambia_lo_existente, los archivos que lo llaman (de `llamadoresDe`). */
  readonly llamadores: ReadonlyMap<string, readonly string[]>;
  /**
   * Los `simbolo` cuyos llamadores no se pudieron saber, con el porqué: graft falló, o un nombre
   * repetido cortó el grep (ADR 0022). Sin saber quién lo llama, ninguna sub-task se puede conservar.
   */
  readonly sinLlamadores?: ReadonlyMap<string, string>;
}

const sameScope = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a.map(normalize));
  const sb = new Set(b.map(normalize));
  return sa.size === sb.size && [...sa].every((p) => sb.has(p));
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Los problemas de las reglas (a) a (d), que no dependen de las demás sub-tasks. */
function ownProblems(input: ConservaInput, task: Subtask): string[] {
  const { id } = task;
  const problems: string[] = [];
  if (!input.candidatas.some((c) => c.id === id))
    problems.push(
      `${id} tiene conserva: true pero no estaba implementada: sacale conserva o dejala como nueva`,
    );
  const before = input.anteriores.find((t) => t.id === id);
  if (before === undefined || !sameScope(before.alcance, task.alcance)) {
    const antes = before === undefined ? "(no estaba)" : before.alcance.map(normalize).join(", ");
    problems.push(
      `${id} cambió su alcance (antes: ${antes}; ahora: ${task.alcance.map(normalize).join(", ")}): no se puede conservar`,
    );
  }
  const named = new RegExp(`\\b${escape(id)}\\b`);
  if (input.pedidos.some((p) => named.test(p)))
    problems.push(
      `${id} la nombran los pedidos de cambios o el motivo del replan: no se puede conservar`,
    );
  const scope = task.alcance.map(normalize);
  for (const [simbolo, files] of input.llamadores) {
    const hit = files.find((f) => scope.some((s) => overlaps(normalize(f), s)));
    if (hit !== undefined)
      problems.push(`${id} llama a ${simbolo}, que el plan cambia (${hit}): no se puede conservar`);
  }
  for (const [simbolo, why] of input.sinLlamadores ?? new Map<string, string>())
    problems.push(
      `${id} no se puede conservar: no se pudo comprobar quién llama a ${simbolo}, que el plan cambia (${why})`,
    );
  return problems;
}

/** Por cada sub-task con `conserva: true`, en el orden del plan, sus problemas. */
function problemsById(input: ConservaInput): Map<string, string[]> {
  const marked = input.plan.subtareas.filter((t) => t.conserva === true);
  const own = new Map(marked.map((t) => [t.id, ownProblems(input, t)]));
  const ok = new Set(marked.filter((t) => own.get(t.id)?.length === 0).map((t) => t.id));
  for (const task of marked) {
    // `ancestors` es transitivo: si ST-1 no se conserva, ST-3 → ST-2 → ST-1 lo ve directamente.
    const deps = ancestors(input.plan.subtareas, task.id);
    for (const other of input.plan.subtareas.map((t) => t.id).filter((d) => deps.has(d))) {
      if (!ok.has(other))
        own
          .get(task.id)
          ?.push(`${task.id} depende de ${other}, que no se conserva: no se puede conservar`);
    }
    // Una dependencia que no está en el plan la rechaza checkPlanShape; acá tampoco se conserva.
    for (const missing of [...deps].filter((d) => !input.plan.subtareas.some((t) => t.id === d)))
      own
        .get(task.id)
        ?.push(`${task.id} depende de ${missing}, que no se conserva: no se puede conservar`);
  }
  return own;
}

/** Los problemas de cada `conserva: true`, como líneas del gate. Vacío si todo se puede conservar. */
export function checkConserva(input: ConservaInput): string[] {
  return [...problemsById(input).values()].flat();
}

/** Las sub-tasks que se conservan: `conserva: true` y sin problemas. */
export function conservadas(input: ConservaInput): string[] {
  return [...problemsById(input)].flatMap(([id, problems]) => (problems.length === 0 ? [id] : []));
}
