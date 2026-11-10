// El loop del run: lee el log, pide la siguiente acción al engine y la ejecuta con su fase.
// Cada acción queda entre `accion_iniciada` y `accion_terminada`; una iniciada sin terminar se rehace.
import {
  esEsperaDeRed,
  nextAction,
  stateOf,
  type RunState,
  type RunStatus,
} from "../engine/engine.ts";
import { avisoDeEstado, cambiosDelPlan } from "../notify/estado.ts";
import { outcomeSchema, type Outcome } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { TurnoAgotadoError } from "../store/turno.ts";
import type { Deps, PhaseRegistry, RunPaths } from "./types.ts";

/** Espera antes de reintentar: una falla de red, 30 s, 2 min y 5 min; otra infraestructura, 5 s y 20 s. */
export function infraBackoffMs(retry: number, red = false): number {
  if (red) return [30_000, 120_000, 300_000][Math.min(Math.max(retry, 1), 3) - 1] ?? 300_000;
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
  let inicial: RunStatus | undefined;
  for (;;) {
    const { events } = readLog(run.dir);
    const state = stateOf(events);
    inicial ??= state.status;
    const action = nextAction(state, opts);
    if (action.tipo === "fin") {
      // El proceso avanza solo: cada estado al que llega es algo que la persona no pidió recién.
      const aviso = avisoDeEstado(inicial, state, {
        events,
        cambiosExistentes: cambiosDelPlan(run),
      });
      if (aviso !== undefined) deps.notify(aviso.title, aviso.body);
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
    if (opts.tick === true && action.fase === "aprender") {
      const after = readLog(run.dir).events;
      const final = stateOf(after);
      const aviso = avisoDeEstado(inicial, final, {
        events: after,
        cambiosExistentes: cambiosDelPlan(run),
      });
      if (aviso !== undefined) deps.notify(aviso.title, aviso.body);
      return final;
    }
    // Solo si el engine la reintenta: la falla que agotó los reintentos no espera para detenerse, y el
    // run no retiene su lugar durante una espera que no lleva a nada.
    if (outcome.tipo === "falla" && outcome.clase === "infra") {
      const after = stateOf(readLog(run.dir).events);
      if (nextAction(after, opts).tipo === "fase")
        await deps.sleep(infraBackoffMs(state.infra + 1, esEsperaDeRed(after, outcome.motivo)));
    }
  }
}
