// El loop del run: lee el log, pide la siguiente acción al engine y la ejecuta con su fase.
// Cada acción queda entre `accion_iniciada` y `accion_terminada`; una iniciada sin terminar se rehace.
import { nextAction, stateOf, type RunState } from "../engine/engine.ts";
import { outcomeSchema, type Outcome } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { TurnoAgotadoError } from "../store/turno.ts";
import type { Deps, PhaseRegistry, RunPaths } from "./types.ts";

/** Espera antes de reintentar una falla de infraestructura: 5 s, 20 s. */
export function infraBackoffMs(retry: number): number {
  return 5_000 * 4 ** Math.max(0, retry - 1);
}

async function runPhase(
  registry: PhaseRegistry,
  ctx: Parameters<PhaseRegistry[keyof PhaseRegistry]>[0],
): Promise<Outcome> {
  try {
    const outcome = await registry[ctx.action.fase](ctx);
    const checked = outcomeSchema.safeParse(outcome);
    if (checked.success) return checked.data;
    return { tipo: "falla", clase: "infra", motivo: `la fase devolvió un resultado inválido` };
  } catch (error) {
    // Esperar más el turno de otro run no lo libera: se detiene y la persona retoma (ADR 0019).
    if (error instanceof TurnoAgotadoError)
      return { tipo: "falla", clase: "entorno", motivo: error.message };
    const motivo = error instanceof Error ? error.message : String(error);
    return { tipo: "falla", clase: "infra", motivo: motivo === "" ? "error sin mensaje" : motivo };
  }
}

export async function runUntilStop(
  run: RunPaths,
  registry: PhaseRegistry,
  deps: Deps,
  opts: { readonly tick?: boolean } = {},
): Promise<RunState> {
  for (;;) {
    const { events } = readLog(run.dir);
    const state = stateOf(events);
    const action = nextAction(state, opts);
    if (action.tipo === "fin") {
      if (state.status === "detenido" && state.halt !== undefined) {
        deps.notify(`${state.clave}: el run se detuvo`, state.halt.motivo);
      }
      return state;
    }
    const emit = (event: Parameters<typeof appendEvent>[1]) =>
      appendEvent(run.dir, event, deps.now);
    // La fase recibe el log con su propia `accion_iniciada`: así encuentra su entrada actual.
    const current = state.interrumpida
      ? events
      : [...events, emit({ tipo: "accion_iniciada", fase: action.fase })];
    const outcome = await runPhase(registry, { run, state, action, events: current, emit, deps });
    emit({ tipo: "accion_terminada", fase: action.fase, resultado: outcome });
    // En un tick, aprender corre una sola vez: con la PR abierta vuelve a probar en el próximo tick.
    if (opts.tick === true && action.fase === "aprender") return stateOf(readLog(run.dir).events);
    if (outcome.tipo === "falla" && outcome.clase === "infra") {
      await deps.sleep(infraBackoffMs(state.infra + 1));
    }
  }
}
