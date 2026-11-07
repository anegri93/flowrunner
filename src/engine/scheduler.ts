// Qué sub-tasks arrancan ahora: las que tienen sus dependencias integradas, hasta `maxParallel`.
// Pura: recibe el estado de las unidades y devuelve ids.

export interface UnitPlan {
  readonly id: string;
  readonly depende_de: readonly string[];
}

export interface UnitsState {
  /** Las sub-tasks que hay que hacer en esta entrada a implementar, en el orden del plan. */
  readonly todo: readonly UnitPlan[];
  readonly integrated: ReadonlySet<string>;
  readonly running: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
}

/** Una dependencia está lista si ya se integró, o si no es parte de esta ronda: se integró antes. */
const depReady = (state: UnitsState, dep: string) =>
  state.integrated.has(dep) || !state.todo.some((u) => u.id === dep);

export function readyToStart(state: UnitsState, maxParallel: number): string[] {
  const slots = maxParallel - state.running.size;
  if (slots <= 0) return [];
  return state.todo
    .filter(
      (u) => !state.integrated.has(u.id) && !state.running.has(u.id) && !state.failed.has(u.id),
    )
    .filter((u) => u.depende_de.every((dep) => depReady(state, dep)))
    .slice(0, slots)
    .map((u) => u.id);
}

/** Las que nunca van a poder arrancar porque una de sus dependencias falló, directa o indirectamente. */
export function blockedByFailure(state: UnitsState): string[] {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of state.todo) {
      if (blocked.has(unit.id) || state.integrated.has(unit.id)) continue;
      if (unit.depende_de.some((dep) => state.failed.has(dep) || blocked.has(dep))) {
        blocked.add(unit.id);
        changed = true;
      }
    }
  }
  return [...blocked];
}
