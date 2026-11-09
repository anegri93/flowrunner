// La máquina de estados del run: una función pura sobre el log. El código decide qué fase toca;
// la fase solo informa cómo le fue.
import type { Outcome, Phase, RunEvent } from "../store/events.ts";

export type RunStatus =
  | "en_curso"
  | "esperando_aprobacion"
  | "entregado"
  | "cerrado"
  | "detenido"
  | "pausado_por_limite"
  | "abortado";

/** Estados en los que el run ya no avanza: el lock se puede tomar. */
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["cerrado", "abortado"]);

/** Intentos por entrada a cada fase ante una falla de gate. */
export const MAX_ATTEMPTS: Record<Phase, number> = {
  preparar: 1,
  planificar: 3,
  aprobar: 1,
  implementar: 1, // los reintentos por sub-task viven dentro de implementar
  verificar: 1,
  revisar: 2,
  probar: 2,
  entregar: 1,
  aprender: 2,
};
export const MAX_INFRA_RETRIES = 2;
/** Vueltas máximas a implementar desde verificar, desde revisar y desde probar. */
export const MAX_ROUNDS = 2;

const NEXT: Partial<Record<Phase, Phase>> = {
  preparar: "planificar",
  planificar: "aprobar",
  aprobar: "implementar",
  implementar: "verificar",
  verificar: "revisar",
  revisar: "probar",
  probar: "entregar",
  entregar: "aprender",
};

/** Las fases que pueden devolver trabajo a implementar. */
export const ROUND_PHASES = ["verificar", "revisar", "probar"] as const;
export type RoundPhase = (typeof ROUND_PHASES)[number];
const NO_ROUNDS: Record<RoundPhase, number> = { verificar: 0, revisar: 0, probar: 0 };
const isRoundPhase = (fase: Phase): fase is RoundPhase =>
  (ROUND_PHASES as readonly Phase[]).includes(fase);

export interface Halt {
  readonly motivo: string;
  readonly siguiente: string;
}

export interface RunState {
  readonly runId: string;
  readonly clave: string;
  readonly proyecto: string;
  readonly repo: string;
  /** Undefined si el repo no configuró un tope. */
  readonly budgetUsd: number | undefined;
  readonly status: RunStatus;
  readonly fase: Phase;
  readonly intentos: number;
  readonly infra: number;
  readonly ultimoMotivo: string | undefined;
  readonly vueltas: Record<RoundPhase, number>;
  /** Lo que la fase anterior o tu pedido le dicen a la próxima ejecución de esta fase. */
  readonly instruccion: string | undefined;
  /** Las sub-tasks que verificar, revisar o probar devolvieron a implementar. */
  readonly unidades: readonly string[] | undefined;
  readonly costoUsd: number;
  readonly halt: Halt | undefined;
  readonly pausaHasta: number | undefined;
  /** Hay una acción iniciada sin terminar: el proceso se cortó en el medio. */
  readonly interrumpida: boolean;
  /**
   * Detenido porque probar dejó criterios sin probar: la persona puede aceptarlo y seguir a
   * entregar. Fuera de esa detención un `sin_probar_aceptado` no hace nada.
   */
  readonly sinProbar: boolean;
}

export type Action =
  | {
      readonly tipo: "fase";
      readonly fase: Phase;
      readonly intento: number;
      readonly instruccion: string | undefined;
      readonly unidades: readonly string[] | undefined;
    }
  | { readonly tipo: "fin"; readonly status: RunStatus };

function halt(state: RunState, motivo: string, siguiente?: string): RunState {
  return {
    ...state,
    status: "detenido",
    halt: { motivo, siguiente: siguiente ?? `flowrunner resume ${state.runId}` },
  };
}

function enter(state: RunState, fase: Phase, extra: Partial<RunState> = {}): RunState {
  return {
    ...state,
    status: "en_curso",
    fase,
    intentos: 0,
    infra: 0,
    ultimoMotivo: undefined,
    instruccion: undefined,
    unidades: undefined,
    halt: undefined,
    pausaHasta: undefined,
    sinProbar: false,
    ...extra,
  };
}

function onOutcome(state: RunState, fase: Phase, outcome: Outcome): RunState {
  switch (outcome.tipo) {
    case "ok": {
      if (fase === "entregar") return { ...enter(state, "aprender"), status: "entregado" };
      if (fase === "aprender") return { ...state, status: "cerrado" };
      const next = NEXT[fase];
      return next === undefined ? { ...state, status: "cerrado" } : enter(state, next);
    }
    case "espera":
      return fase === "aprobar"
        ? { ...state, status: "esperando_aprobacion" }
        : { ...state, status: "entregado" };
    case "limite":
      return { ...state, status: "pausado_por_limite", pausaHasta: outcome.hasta };
    case "vuelve": {
      if (!isRoundPhase(fase)) {
        return halt(
          state,
          `${fase} devolvió trabajo, y solo ${ROUND_PHASES.join(", ")} pueden hacerlo`,
        );
      }
      const vueltas = { ...state.vueltas, [fase]: state.vueltas[fase] + 1 };
      if (vueltas[fase] > MAX_ROUNDS) {
        return halt(
          { ...state, vueltas },
          `${fase} devolvió trabajo ${vueltas[fase]} veces; el máximo es ${MAX_ROUNDS}. Último motivo: ${outcome.motivo}`,
        );
      }
      return enter({ ...state, vueltas }, "implementar", {
        unidades: outcome.unidades,
        instruccion: outcome.motivo,
      });
    }
    case "falla": {
      // Reintentar no ayuda: lo que faltó para probar (una falla que simular, un dato) no lo arregla
      // el modelo. Entregar con criterios que nadie probó lo decide la persona, no flowrunner.
      if (outcome.clase === "sin_probar") {
        return {
          ...halt(
            state,
            `${fase}: ${outcome.motivo}\nArreglá lo que faltó y rehacé probar con el comando de abajo; para entregar igual, decilo con: flowrunner accept-untested ${state.runId} "<por qué>"`,
            `flowrunner rerun ${state.runId} --desde ${fase}`,
          ),
          sinProbar: true,
        };
      }
      if (outcome.clase === "entorno" || outcome.clase === "invariante") {
        return halt(state, `${fase}: ${outcome.motivo}`);
      }
      if (outcome.clase === "infra") {
        const infra = state.infra + 1;
        if (infra > MAX_INFRA_RETRIES) {
          return halt(
            { ...state, infra },
            `${fase}: falla de infraestructura repetida: ${outcome.motivo}`,
          );
        }
        return { ...state, infra };
      }
      if (state.ultimoMotivo === outcome.motivo) {
        return halt(
          state,
          `${fase}: el mismo fallo se repitió dos veces seguidas: ${outcome.motivo}`,
          `flowrunner rerun ${state.runId} --desde ${fase}`,
        );
      }
      const intentos = state.intentos + 1;
      if (intentos >= MAX_ATTEMPTS[fase]) {
        return halt(
          { ...state, intentos },
          `${fase}: ${intentos} intentos sin pasar el gate. Último motivo: ${outcome.motivo}`,
          `flowrunner rerun ${state.runId} --desde ${fase}`,
        );
      }
      return { ...state, intentos, ultimoMotivo: outcome.motivo, instruccion: outcome.motivo };
    }
  }
}

export function initialState(): RunState {
  return {
    runId: "",
    clave: "",
    proyecto: "",
    repo: "",
    budgetUsd: undefined,
    status: "en_curso",
    fase: "preparar",
    intentos: 0,
    infra: 0,
    ultimoMotivo: undefined,
    vueltas: NO_ROUNDS,
    instruccion: undefined,
    unidades: undefined,
    costoUsd: 0,
    halt: undefined,
    pausaHasta: undefined,
    interrumpida: false,
    sinProbar: false,
  };
}

export function reduce(state: RunState, event: RunEvent): RunState {
  if (state.status === "abortado") return state;
  switch (event.tipo) {
    case "run_creado":
      return {
        ...state,
        runId: event.run_id,
        clave: event.clave,
        proyecto: event.proyecto,
        repo: event.repo,
        budgetUsd: event.budget_usd,
      };
    case "accion_iniciada":
      return { ...state, interrumpida: true };
    case "accion_terminada": {
      const settled = { ...state, interrumpida: false };
      // Un run detenido a mitad de una fase, por ejemplo por presupuesto, no revive cuando la fase termina.
      const applies =
        settled.status === "en_curso" ||
        (settled.status === "entregado" && event.fase === "aprender");
      return applies ? onOutcome(settled, event.fase, event.resultado) : settled;
    }
    case "uso": {
      const costoUsd = state.costoUsd + event.costo_usd;
      const next = { ...state, costoUsd };
      if (
        state.budgetUsd !== undefined &&
        costoUsd > state.budgetUsd &&
        state.status === "en_curso"
      ) {
        return halt(
          next,
          `el run gastó USD ${costoUsd.toFixed(2)} y su tope es USD ${state.budgetUsd.toFixed(2)}`,
        );
      }
      return next;
    }
    case "aprobado":
      return state.status === "esperando_aprobacion" ? enter(state, "implementar") : state;
    case "cambios_pedidos":
      return state.status === "esperando_aprobacion"
        ? enter(state, "planificar", { instruccion: event.motivo })
        : state;
    case "reanudado":
      if (state.status === "detenido" || state.status === "pausado_por_limite") {
        return {
          ...enter(state, state.fase),
          unidades: state.unidades,
          instruccion: state.instruccion,
        };
      }
      return state;
    case "sin_probar_aceptado":
      return state.status === "detenido" && state.sinProbar ? enter(state, "entregar") : state;
    case "rehacer":
      return enter({ ...state, vueltas: NO_ROUNDS }, event.desde);
    case "abortado":
      return { ...state, status: "abortado" };
    case "pr_cerrada":
      return event.mergeada ? state : { ...state, status: "cerrado" };
    case "rechazo":
    case "decision":
    case "aviso":
    case "unidad":
    case "preparado":
    case "lecciones":
    case "lecciones_propuestas":
    case "pr":
      return state;
  }
}

export function stateOf(events: readonly RunEvent[]): RunState {
  return events.reduce(reduce, initialState());
}

/** `tick` es el job de launchd: es el único que corre aprender sobre un run entregado. */
export function nextAction(state: RunState, opts: { readonly tick?: boolean } = {}): Action {
  const runnable =
    state.status === "en_curso" || (opts.tick === true && state.status === "entregado");
  if (!runnable) return { tipo: "fin", status: state.status };
  return {
    tipo: "fase",
    fase: state.fase,
    intento: state.intentos + 1,
    instruccion: state.instruccion,
    unidades: state.unidades,
  };
}
