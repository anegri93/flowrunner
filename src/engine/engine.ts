// La máquina de estados del run: una función pura sobre el log. El código decide qué fase toca;
// la fase solo informa cómo le fue.
import type { Outcome, Phase, RunEvent } from "../store/events.ts";
import { esCredencial, esFallaDeRed } from "./motivos.ts";

export type RunStatus =
  | "en_curso"
  /** Lista para avanzar, esperando un lugar del repo; no tiene proceso (ADR 0019). */
  | "en_cola"
  | "esperando_aprobacion"
  | "entregado"
  | "cerrado"
  | "detenido"
  | "pausado_por_limite"
  | "abortado";

/** Estados en los que el run ya no avanza. */
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
/** Un corte de red dura más que un error de otra infraestructura: 30 s, 2 min y 5 min. */
export const MAX_NETWORK_RETRIES = 3;
/**
 * Las vueltas automáticas de un run creado antes de que existiera `vueltas` en `run_creado`: era el
 * máximo fijo de entonces, y un run en curso no cambia a mitad de camino (ADR 0023).
 */
const LEGACY_ROUNDS = 2;

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

/** Una respuesta posible a un run detenido. */
export interface Opcion {
  /** El comando tal cual, con <placeholders> para lo que escribe la persona. */
  readonly comando: string;
  /** Qué hace, en una frase, para el aviso, Orca y la skill. */
  readonly que: string;
}

export interface Halt {
  readonly motivo: string;
  /** El primer comando de `opciones`: lo que ya leían el aviso, el informe y watch. */
  readonly siguiente: string;
  /** Las respuestas posibles, en orden de preferencia. Nunca vacía. */
  readonly opciones: readonly Opcion[];
  /** Las sub-tasks a las que se atribuye el problema, si hay. */
  readonly unidades?: readonly string[];
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
  /** Vueltas automáticas por fase antes de preguntar; la config del repo al crear el run (ADR 0023). */
  readonly vueltasMax: number;
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
  /** Detenido esperando que la persona arregle el worktree a mano y lo retome (`fix --yo`). */
  readonly aMano: boolean;
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

/** El primer paso ante una credencial rechazada: retomar sin arreglarla vuelve a fallar (VF-3, VF-4). */
const DOCTOR = "flowrunner doctor";

/** Qué hace un comando de la fila «cualquier otro» de `opcionesDe`, en palabras. */
function queHace(comando: string, runId: string, fase: Phase): string {
  if (comando === `flowrunner resume ${runId}`) return `retomar en ${fase}`;
  if (comando === DOCTOR) return "revisá la credencial; después retomá el run";
  const desde = /^flowrunner rerun \S+ --desde (\S+)$/.exec(comando)?.[1];
  if (desde !== undefined) return `rehacer desde ${desde}`;
  return "seguir";
}

/**
 * Las respuestas a un run detenido, en orden de preferencia. Solo el engine arma comandos: el CLI
 * acepta `fix` y `accept` solo si el halt actual los ofrece (ADR 0023). Nunca devuelve una lista vacía.
 *
 * Los comandos son parte del contrato del log: el reductor decide si `arreglo_pedido`,
 * `arreglo_manual_iniciado` y `aceptado` valen comparando con ellos (`offers`), y se recalculan en
 * cada replay. Cambiar su texto, o sacar uno de una fila, cambia cómo se reduce un log ya escrito.
 */
export function opcionesDe(
  state: RunState,
  fase: Phase,
  unidades: readonly string[] | undefined,
): Opcion[] {
  const R = state.runId;
  const abort: Opcion = { comando: `flowrunner abort ${R}`, que: "cortar el run; la rama queda" };
  const byHand: Opcion = {
    comando: `flowrunner fix ${R} --yo`,
    que: "lo arreglás vos en el worktree; `resume` lo commitea y vuelve a verificar",
  };
  const accept = (que: string): Opcion => ({ comando: `flowrunner accept ${R} "<por qué>"`, que });
  const replan: Opcion = {
    comando: `flowrunner rerun ${R} --desde planificar`,
    que: "replanificar",
  };
  const fixes = (unidades ?? []).map((u): Opcion => ({
    comando: `flowrunner fix ${R} --unidad ${u} "<qué cambiar>"`,
    que: `que ${u} lo corrija con tu instrucción, sobre el código que ya está`,
  }));
  if (state.aMano) {
    return [
      {
        comando: `flowrunner resume ${R}`,
        que: "commitear tu cambio a mano y volver a verificar",
      },
      abort,
    ];
  }
  if (state.sinProbar) {
    return [
      {
        comando: `flowrunner rerun ${R} --desde probar`,
        que: "rehacer probar después de arreglar lo que faltó",
      },
      accept("entregar igual; tu motivo queda en la PR"),
      byHand,
      abort,
    ];
  }
  const next = NEXT[fase];
  if (isRoundPhase(fase) && fixes.length > 0 && next !== undefined) {
    return [
      ...fixes,
      byHand,
      accept(`seguir a ${next} igual; tu motivo queda en la PR`),
      replan,
      abort,
    ];
  }
  // Sin accept: no se entrega una sub-task sin hacer.
  if (fase === "implementar" && fixes.length > 0) return [...fixes, byHand, replan, abort];
  const resume = `flowrunner resume ${R}`;
  const siguiente = state.halt?.siguiente ?? resume;
  const first: Opcion = { comando: siguiente, que: queHace(siguiente, R, fase) };
  // doctor no retoma nada: después de revisar la credencial, la persona retoma el run.
  if (siguiente === DOCTOR)
    return [first, { comando: resume, que: queHace(resume, R, fase) }, abort];
  return [first, abort];
}

/** La única forma de dejar un run detenido: con su motivo y sus opciones, que nunca faltan. */
function halt(
  state: RunState,
  motivo: string,
  siguiente?: string,
  unidades?: readonly string[],
): RunState {
  const base: Halt = {
    motivo,
    siguiente: siguiente ?? `flowrunner resume ${state.runId}`,
    opciones: [],
    ...(unidades === undefined ? {} : { unidades }),
  };
  const opciones = opcionesDe({ ...state, halt: base }, state.fase, unidades);
  const first = opciones[0];
  if (first === undefined) throw new Error("opcionesDe devolvió una lista vacía");
  return {
    ...state,
    status: "detenido",
    halt: { ...base, siguiente: first.comando, opciones },
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
    aMano: false,
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
      if (vueltas[fase] > state.vueltasMax) {
        return halt(
          { ...state, vueltas },
          state.vueltasMax === 0
            ? `${fase}: ${outcome.motivo}`
            : `${fase} devolvió trabajo ${vueltas[fase]} veces; el máximo es ${state.vueltasMax}. Último motivo: ${outcome.motivo}`,
          undefined,
          outcome.unidades,
        );
      }
      return enter({ ...state, vueltas }, "implementar", {
        unidades: outcome.unidades,
        instruccion: outcome.motivo,
      });
    }
    // La fase sabe que reintentar solo no sirve: pregunta sin gastar intentos ni vueltas.
    case "pregunta":
      return halt(state, `${fase}: ${outcome.motivo}`, undefined, outcome.unidades);
    case "falla": {
      // Reintentar no ayuda: lo que faltó para probar (una falla que simular, un dato) no lo arregla
      // el modelo. Entregar con criterios que nadie probó lo decide la persona, no flowrunner. Se marca
      // antes del halt para que sus opciones sean las de esta detención.
      if (outcome.clase === "sin_probar") {
        return halt(
          { ...state, sinProbar: true },
          `${fase}: ${outcome.motivo}\nArreglá lo que faltó y rehacé probar con el comando de abajo; para entregar igual, decilo con: flowrunner accept-untested ${state.runId} "<por qué>"`,
          `flowrunner rerun ${state.runId} --desde ${fase}`,
        );
      }
      if (outcome.clase === "entorno" || outcome.clase === "invariante") {
        return halt(
          state,
          `${fase}: ${outcome.motivo}`,
          esCredencial(outcome.motivo) ? DOCTOR : undefined,
        );
      }
      if (outcome.clase === "infra") {
        const infra = state.infra + 1;
        const red = esFallaDeRed(outcome.motivo);
        const max = red ? MAX_NETWORK_RETRIES : MAX_INFRA_RETRIES;
        if (infra > max) {
          return halt(
            { ...state, infra },
            red
              ? `${fase}: sin conexión después de ${String(max)} reintentos (30 s, 2 min y 5 min): ${outcome.motivo}. Cuando vuelva la red, retomá el run`
              : `${fase}: falla de infraestructura repetida: ${outcome.motivo}`,
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
    vueltasMax: LEGACY_ROUNDS,
    instruccion: undefined,
    unidades: undefined,
    costoUsd: 0,
    halt: undefined,
    pausaHasta: undefined,
    interrumpida: false,
    sinProbar: false,
    aMano: false,
  };
}

/**
 * El halt actual ofrece una respuesta que empieza con `prefix`. El CLI lo valida antes de escribir el
 * evento, y el reductor otra vez: un evento que no se ofreció no hace nada (ADR 0023).
 */
export const offers = (state: RunState, prefix: string): boolean =>
  state.status === "detenido" &&
  (state.halt?.opciones ?? []).some((o) => o.comando.startsWith(prefix));

/**
 * El halt ofrece que cada una de esas sub-tasks lo arregle. Cada una se compara entera con las del
 * halt: por prefijo del comando, `ST-1 "<qué` también pasaba.
 */
export const offersFix = (state: RunState, unidades: readonly string[]): boolean =>
  unidades.length > 0 &&
  unidades.every(
    (u) =>
      (state.halt?.unidades ?? []).includes(u) &&
      offers(state, `flowrunner fix ${state.runId} --unidad ${u} `),
  );

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
        vueltasMax: event.vueltas ?? LEGACY_ROUNDS,
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
    case "encolado":
      return state.status === "en_curso" ? { ...state, status: "en_cola" } : state;
    case "reanudado":
      // Sale de la cola tal como entró: misma fase, intentos e instrucción.
      if (state.status === "en_cola") return { ...state, status: "en_curso" };
      if (state.status === "detenido" || state.status === "pausado_por_limite") {
        return {
          ...enter(state, state.fase),
          unidades: state.unidades,
          instruccion: state.instruccion,
        };
      }
      return state;
    case "sin_probar_aceptado":
      // Durante un arreglo a mano no: la PR saldría sin el cambio, que queda sin commitear.
      return state.status === "detenido" && state.sinProbar && !state.aMano
        ? enter(state, "entregar")
        : state;
    case "arreglo_pedido": {
      if (!offersFix(state, event.unidades)) return state;
      // Desde una pregunta de implementar entran también las que quedaron bloqueadas por la que se
      // arregla: si no, no arrancarían nunca. Las de verificar, revisar o probar ya están integradas.
      if (state.fase === "implementar") {
        return enter(state, "implementar", {
          unidades: [...new Set([...event.unidades, ...(state.halt?.unidades ?? [])])],
          instruccion: `Para ${event.unidades.join(", ")}: ${event.instruccion}`,
        });
      }
      return enter(state, "implementar", {
        unidades: event.unidades,
        instruccion: event.instruccion,
      });
    }
    case "arreglo_manual_iniciado":
      return offers(state, `flowrunner fix ${state.runId} --yo`)
        ? halt(
            { ...state, aMano: true },
            "Esperando tu arreglo a mano en el worktree de la feature. Cuando termines, retomá el run: flowrunner commitea tu cambio y vuelve a verificar.",
          )
        : state;
    case "arreglo_manual":
      return state.status === "detenido" && state.aMano ? enter(state, "verificar") : state;
    case "aceptado": {
      const next = NEXT[event.fase];
      const applies =
        offers(state, `flowrunner accept ${state.runId} `) &&
        event.fase === state.fase &&
        isRoundPhase(event.fase) &&
        next !== undefined;
      return applies ? enter(state, next) : state;
    }
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
