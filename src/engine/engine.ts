// La máquina de estados del run: una función pura sobre el log. El código decide qué fase toca;
// la fase solo informa cómo le fue.
import { PHASES, type Arreglo, type Outcome, type Phase, type RunEvent } from "../store/events.ts";
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
  /** La persona lo pausó: sin proceso ni lugar, y no vuelve solo. */
  | "pausado"
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
 * Esta falla espera como un corte de red. Un run creado antes de distinguirlos, sin `reintentos_red`
 * en `run_creado`, la trata como cualquier otra infraestructura: su log se reduce como antes (C8).
 */
export const esEsperaDeRed = (state: RunState, motivo: string): boolean =>
  state.reintentosRed !== undefined && esFallaDeRed(motivo);
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
  /** Un `fix --unidad` con la instrucción ya escrita: la sub-task y el texto, sin comillas (ADR 0028). */
  readonly arreglo?: Arreglo;
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
  /** Reintentos de un corte de red; undefined en un run creado antes de distinguirlos (ADR 0023). */
  readonly reintentosRed: number | undefined;
  /** Lo que la fase anterior o tu pedido le dicen a la próxima ejecución de esta fase. */
  readonly instruccion: string | undefined;
  /** Las sub-tasks que verificar, revisar o probar devolvieron a implementar. */
  readonly unidades: readonly string[] | undefined;
  readonly costoUsd: number;
  readonly halt: Halt | undefined;
  readonly pausaHasta: number | undefined;
  /** Hay una acción iniciada sin terminar: el proceso se cortó en el medio. */
  readonly interrumpida: boolean;
  /** La persona pidió pausar: el run termina la etapa (o las sub-tasks que corren) y para. */
  readonly pausaPedida: boolean;
  /**
   * Detenido porque probar dejó criterios sin probar: la persona puede aceptarlo y seguir a
   * entregar. Fuera de esa detención un `sin_probar_aceptado` no hace nada.
   */
  readonly sinProbar: boolean;
  /** Detenido esperando que la persona arregle el worktree a mano y lo retome (`fix --yo`). */
  readonly aMano: boolean;
  /**
   * La persona pidió saltear probar, con este motivo (ADR 0036): cuando el run llega a probar, el
   * runner no la corre. Sobrevive a un replan; `rehacer` desde probar la borra.
   */
  readonly probarSalteado: string | undefined;
  /**
   * Autofix en curso (ADR 0026): el próximo rojo con sub-tasks vuelve a implementar con su motivo en
   * vez de detenerse. Se gasta una vez; cualquier detención lo apaga.
   */
  readonly autofix: boolean;
  /**
   * Autofix ya corrió desde la última respuesta de la persona que mandó el run a trabajar: flowrunner
   * no lo vuelve a correr solo en la próxima detención (ADR 0028).
   */
  readonly autofixCorrio: boolean;
  /**
   * Un bloqueante de revisar o probar ya fue directo a su sub-task desde la última respuesta de la
   * persona: el próximo pregunta (ADR 0030). Aparte de `autofixCorrio`, así uno no le quita el otro.
   */
  readonly directaCorrio: boolean;
  /**
   * Un bloqueante de revisar o probar vuelve directo a su sub-task, sin Autofix, que no lo arregla
   * (ADR 0030). Lo congela `run_creado`: un run anterior sigue como antes.
   */
  readonly vueltaDirecta: boolean;
  /**
   * El feedback de la persona sobre la PR abierta que aprender tiene que evaluar (ADR 0038). Se gasta
   * cuando el run vuelve a trabajar, o cuando aprender ve que la PR ya no está abierta.
   */
  readonly feedback: string | undefined;
  /** La PR se mergeó o se cerró: ya no se puede rehacer con feedback. */
  readonly prCerrada: boolean;
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

/**
 * Un texto entre comillas simples de shell: el arreglo lo escribe el revisor, y en comillas dobles un
 * `` `engines.node` `` se ejecutaría al copiar el comando.
 */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** La respuesta a las preguntas del planificador (ADR 0043). */
const responderComando = (runId: string) => `flowrunner responder ${runId} "<tu respuesta>"`;

/** Qué hace un comando de la fila «cualquier otro» de `opcionesDe`, en palabras. */
function queHace(comando: string, runId: string, fase: Phase): string {
  if (comando === `flowrunner resume ${runId}`) return `retomar en ${fase}`;
  if (comando === responderComando(runId))
    return "contestar lo que preguntó; se suma a la feature y el plan sigue";
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
 * `arreglo_manual_iniciado`, `autofix` y `aceptado` valen comparando con ellos (`offers`), y se
 * recalculan en cada replay. Cambiar su texto, o sacar uno de una fila, cambia cómo se reduce un log
 * ya escrito. Los `arreglos` solo suman opciones con el mismo prefijo que el `fix --unidad` genérico,
 * que se queda: un log sin ellos se reduce igual (ADR 0028).
 */
export function opcionesDe(
  state: RunState,
  fase: Phase,
  unidades: readonly string[] | undefined,
  arreglos: readonly Arreglo[] = [],
): Opcion[] {
  const R = state.runId;
  const abort: Opcion = { comando: `flowrunner abort ${R}`, que: "cortar el run; la rama queda" };
  const byHand: Opcion = {
    comando: `flowrunner fix ${R} --yo`,
    que: "lo arreglás vos en el worktree; `resume` lo commitea y vuelve a verificar",
  };
  // Sin texto de la persona: lo que pide es justamente no escribir nada (ADR 0026).
  const autofix: Opcion = {
    comando: `flowrunner fix ${R} --auto`,
    que: "formateador y lint del repo, y volver a verificar; si sigue en rojo, las sub-tasks lo corrigen solas",
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
  // La solución ya escrita, para elegirla sin escribir nada; el genérico queda para escribir otra.
  const suggested = arreglos
    .filter((a) => (unidades ?? []).includes(a.unidad))
    .map((a): Opcion => ({
      comando: `flowrunner fix ${R} --unidad ${a.unidad} ${shellQuote(a.instruccion)}`,
      que: `que ${a.unidad} lo corrija así: ${a.instruccion}`,
      arreglo: a,
    }));
  if (state.aMano) {
    return [
      {
        comando: `flowrunner resume ${R}`,
        que: "commitear tu cambio a mano y volver a verificar",
      },
      // Si la persona no llegó a tocar nada: el CLI lo comprueba antes de escribir el evento.
      autofix,
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
      ...suggested,
      ...fixes,
      ...(autofixSirve(state, fase) ? [autofix] : []),
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
  if (siguiente === responderComando(R)) return [first, replan, abort];
  // doctor no retoma nada: después de revisar la credencial, la persona retoma el run.
  if (siguiente === DOCTOR)
    return [first, { comando: resume, que: queHace(resume, R, fase) }, abort];
  return [first, abort];
}

/**
 * Una respuesta de la persona que manda el run a trabajar: flowrunner puede volver a responder solo,
 * con Autofix (ADR 0028) o con la vuelta directa de un bloqueante (ADR 0030).
 */
const RESPONDIO_LA_PERSONA = { autofixCorrio: false, directaCorrio: false } as const;

/**
 * Autofix corre el formateador y el lint y vuelve a verificar: sirve para un rojo de verificar. Para
 * un bloqueante de revisar o probar solo repetía la revisión sobre el mismo código (PIZ-9, PIZ-13),
 * así que en un run con `vueltaDirecta` no se ofrece ahí (ADR 0030).
 */
const autofixSirve = (state: RunState, fase: Phase): boolean =>
  !state.vueltaDirecta || fase === "verificar";

/** La única forma de dejar un run detenido: con su motivo y sus opciones, que nunca faltan. */
function halt(
  state: RunState,
  motivo: string,
  siguiente?: string,
  unidades?: readonly string[],
  arreglos?: readonly Arreglo[],
): RunState {
  const base: Halt = {
    motivo,
    siguiente: siguiente ?? `flowrunner resume ${state.runId}`,
    opciones: [],
    ...(unidades === undefined ? {} : { unidades }),
  };
  const opciones = opcionesDe({ ...state, halt: base }, state.fase, unidades, arreglos);
  const first = opciones[0];
  if (first === undefined) throw new Error("opcionesDe devolvió una lista vacía");
  return {
    ...state,
    status: "detenido",
    halt: { ...base, siguiente: first.comando, opciones },
    autofix: false,
    pausaPedida: false,
  };
}

/** Lo que recibe planificar cuando se replanifica con el feedback de la persona sobre la PR. */
export const feedbackInstruction = (feedback: string): string =>
  `La persona vio la PR y no la mergea. Su feedback:\n\n${feedback}`;

/**
 * La instrucción de una vuelta que nadie eligió (las automáticas y la que sigue a Autofix): el motivo y,
 * si la fase los propuso, sus arreglos. Sin arreglos es el motivo, como antes (ADR 0028).
 */
function roundInstruction(outcome: Extract<Outcome, { tipo: "vuelve" }>): string {
  const arreglos = (outcome.arreglos ?? []).filter((a) => outcome.unidades.includes(a.unidad));
  if (arreglos.length === 0) return outcome.motivo;
  const lines = arreglos.map((a) => `- ${a.unidad}: ${a.instruccion}`);
  return `${outcome.motivo}\n\nArreglos propuestos:\n${lines.join("\n")}`;
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
    pausaPedida: false,
    ...extra,
  };
}

function onOutcome(state: RunState, fase: Phase, outcome: Outcome): RunState {
  switch (outcome.tipo) {
    case "ok": {
      if (fase === "entregar") return { ...enter(state, "aprender"), status: "entregado" };
      if (fase === "aprender") return { ...state, status: "cerrado", feedback: undefined };
      const next = NEXT[fase];
      return next === undefined ? { ...state, status: "cerrado" } : enter(state, next);
    }
    case "espera":
      return fase === "aprobar"
        ? { ...state, status: "esperando_aprobacion" }
        : { ...state, status: "entregado", feedback: undefined };
    case "reentrar": {
      // Un choque con la base resuelto con un merge (ADR 0041): el código cambió y vuelve a verificar.
      if (outcome.desde === "verificar")
        return fase === "entregar" || fase === "aprender"
          ? enter(state, "verificar")
          : halt(state, `${fase} pidió volver a verificar, y solo entregar y aprender pueden`);
      if (fase !== "aprender" || state.feedback === undefined)
        return halt(state, `${fase} pidió rehacer el run, y solo aprender puede, con tu feedback`);
      if (outcome.desde === "planificar")
        return enter(state, "planificar", {
          instruccion: outcome.instruccion,
          feedback: undefined,
        });
      // Implementar sin sub-tasks correría el plan entero sobre lo que ya está: eso es replanificar.
      if (outcome.unidades === undefined)
        return halt(state, "aprender pidió rehacer implementar sin decir qué sub-tasks");
      return enter(state, "implementar", {
        unidades: outcome.unidades,
        instruccion: outcome.instruccion,
        feedback: undefined,
      });
    }
    case "limite":
      return { ...state, status: "pausado_por_limite", pausaHasta: outcome.hasta };
    case "pausa":
      return { ...state, status: "pausado" };
    case "vuelve": {
      if (!isRoundPhase(fase)) {
        return halt(
          state,
          `${fase} devolvió trabajo, y solo ${ROUND_PHASES.join(", ")} pueden hacerlo`,
        );
      }
      const vueltas = { ...state.vueltas, [fase]: state.vueltas[fase] + 1 };
      // Las vueltas que nadie eligió van a las sub-tasks sin preguntar: la que sigue a Autofix, que ya
      // pasó las herramientas y sigue en rojo (ADR 0026), y la de un bloqueante de revisar o probar,
      // que el formateador no arregla, una vez por respuesta de la persona (ADR 0030). Sin sub-tasks a
      // quién dárselo, pregunta.
      const directa = !autofixSirve(state, fase) && !state.directaCorrio;
      if (
        vueltas[fase] > state.vueltasMax &&
        outcome.unidades.length > 0 &&
        (state.autofix || directa)
      ) {
        return enter({ ...state, vueltas }, "implementar", {
          unidades: outcome.unidades,
          instruccion: roundInstruction(outcome),
          autofix: false,
          directaCorrio: state.directaCorrio || directa,
        });
      }
      if (vueltas[fase] > state.vueltasMax) {
        return halt(
          { ...state, vueltas },
          state.vueltasMax === 0
            ? `${fase}: ${outcome.motivo}`
            : `${fase} devolvió trabajo ${vueltas[fase]} veces; el máximo es ${state.vueltasMax}. Último motivo: ${outcome.motivo}`,
          undefined,
          outcome.unidades,
          outcome.arreglos,
        );
      }
      return enter({ ...state, vueltas }, "implementar", {
        unidades: outcome.unidades,
        instruccion: roundInstruction(outcome),
      });
    }
    // La fase sabe que reintentar solo no sirve: pregunta sin gastar intentos ni vueltas.
    case "pregunta":
      // El feedback cambia lo que pide la feature: replanificar lo lleva como instrucción (`rehacer`).
      if (fase === "aprender" && state.feedback !== undefined)
        return halt(
          state,
          `${fase}: ${outcome.motivo}`,
          `flowrunner rerun ${state.runId} --desde planificar`,
        );
      // Lo que pregunta el planificador lo contesta la persona: la respuesta lo retoma (ADR 0043).
      if (fase === "planificar")
        return halt(state, `${fase}: ${outcome.motivo}`, responderComando(state.runId));
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
        const maxRed = esEsperaDeRed(state, outcome.motivo) ? state.reintentosRed : undefined;
        const red = maxRed !== undefined;
        const max = maxRed ?? MAX_INFRA_RETRIES;
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
    reintentosRed: undefined,
    instruccion: undefined,
    unidades: undefined,
    costoUsd: 0,
    halt: undefined,
    pausaHasta: undefined,
    interrumpida: false,
    pausaPedida: false,
    sinProbar: false,
    aMano: false,
    probarSalteado: undefined,
    autofix: false,
    autofixCorrio: false,
    directaCorrio: false,
    vueltaDirecta: false,
    feedback: undefined,
    prCerrada: false,
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

/** Cómo empieza el motivo de una probar salteada a pedido de la persona (ADR 0036). */
export const SALTEADA_POR_LA_PERSONA = "la salteó la persona: ";

/**
 * Probar todavía no arrancó: el run está en una fase anterior, o en probar en cola o pausado, que
 * todavía no la corrieron. Es cuando la persona puede pedir saltearla o deshacerlo (ADR 0036). En
 * probar con un proceso andando, o detenido ahí, ya arrancó.
 */
export const probarNoArranco = (state: RunState): boolean =>
  !TERMINAL.has(state.status) &&
  state.status !== "entregado" &&
  (PHASES.indexOf(state.fase) < PHASES.indexOf("probar") ||
    (state.fase === "probar" &&
      !state.interrumpida &&
      (state.status === "en_cola" || state.status === "pausado")));

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
        reintentosRed: event.reintentos_red,
        vueltaDirecta: event.vuelta_directa === true,
      };
    case "accion_iniciada":
      return { ...state, interrumpida: true };
    case "accion_terminada": {
      const settled = { ...state, interrumpida: false };
      // Un run detenido a mitad de una fase, por ejemplo por presupuesto, no revive cuando la fase termina.
      const applies =
        settled.status === "en_curso" ||
        (settled.status === "entregado" && event.fase === "aprender");
      if (!applies) return settled;
      const next = onOutcome(settled, event.fase, event.resultado);
      // La pausa pedida espera a que termine la etapa. Si quedó algo que te necesita, gana eso: esos
      // estados ya sueltan el lugar.
      if (!settled.pausaPedida) return next;
      return {
        ...next,
        pausaPedida: false,
        status: next.status === "en_curso" ? "pausado" : next.status,
      };
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
      if (state.status !== "en_curso") return state;
      return state.pausaPedida
        ? { ...state, status: "pausado", pausaPedida: false }
        : { ...state, status: "en_cola" };
    case "pausa_pedida":
      // En curso, termina lo que hace y para (`accion_terminada`); en cola no hay nada que esperar.
      if (state.status === "en_curso") return { ...state, pausaPedida: true };
      return state.status === "en_cola" ? { ...state, status: "pausado" } : state;
    case "priorizado":
      return state;
    case "reanudado":
      // Sale de la cola o de la pausa tal como entró: misma fase, intentos e instrucción.
      if (state.status === "en_cola" || state.status === "pausado")
        return { ...state, status: "en_curso", pausaPedida: false };
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
        ? enter(state, "entregar", RESPONDIO_LA_PERSONA)
        : state;
    case "arreglo_pedido": {
      if (!offersFix(state, event.unidades)) return state;
      // Desde una pregunta de implementar entran también las que quedaron bloqueadas por la que se
      // arregla: si no, no arrancarían nunca. Las de verificar, revisar o probar ya están integradas.
      if (state.fase === "implementar") {
        return enter(state, "implementar", {
          unidades: [...new Set([...event.unidades, ...(state.halt?.unidades ?? [])])],
          instruccion: `Para ${event.unidades.join(", ")}: ${event.instruccion}`,
          ...RESPONDIO_LA_PERSONA,
        });
      }
      return enter(state, "implementar", {
        unidades: event.unidades,
        instruccion: event.instruccion,
        ...RESPONDIO_LA_PERSONA,
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
      return state.status === "detenido" && state.aMano
        ? enter(state, "verificar", RESPONDIO_LA_PERSONA)
        : state;
    // Lo de las herramientas ya está commiteado (el CLI o el proceso del run lo hizo antes de escribir
    // el evento): se verifica, y el próximo rojo con sub-tasks vuelve a implementar sin preguntar. Lo
    // haya elegido la persona o no, el origen no cambia cómo se reduce.
    case "autofix":
      return offers(state, `flowrunner fix ${state.runId} --auto`)
        ? enter(state, "verificar", { autofix: true, autofixCorrio: true })
        : state;
    case "respondido":
      return offers(state, responderComando(state.runId)) && state.fase === "planificar"
        ? enter(state, "planificar", { instruccion: event.respuesta, ...RESPONDIO_LA_PERSONA })
        : state;
    case "aceptado": {
      const next = NEXT[event.fase];
      const applies =
        offers(state, `flowrunner accept ${state.runId} `) &&
        event.fase === state.fase &&
        isRoundPhase(event.fase) &&
        next !== undefined;
      return applies ? enter(state, next, RESPONDIO_LA_PERSONA) : state;
    }
    case "probar_salteado":
      return probarNoArranco(state) ? { ...state, probarSalteado: event.motivo } : state;
    case "probar_restaurado":
      return probarNoArranco(state) ? { ...state, probarSalteado: undefined } : state;
    // Rehacer probar es pedir probar: la marca de saltearla no sobrevive (ADR 0036).
    case "rehacer": {
      // Un feedback pendiente va como instrucción si se replanifica, se vuelve a evaluar si se rehace
      // aprender, y se pierde desde cualquier otra fase: la persona eligió no usarlo (ADR 0038).
      const feedback = event.desde === "aprender" ? state.feedback : undefined;
      const instruccion =
        event.desde === "planificar" && state.feedback !== undefined
          ? feedbackInstruction(state.feedback)
          : undefined;
      return enter(
        {
          ...state,
          vueltas: NO_ROUNDS,
          autofix: false,
          ...RESPONDIO_LA_PERSONA,
          ...(event.desde === "probar" ? { probarSalteado: undefined } : {}),
        },
        event.desde,
        { feedback, ...(instruccion === undefined ? {} : { instruccion }) },
      );
    }
    case "feedback_pedido":
      // Solo con la PR abierta: un run que todavía trabaja tiene otras respuestas, y una PR mergeada
      // o cerrada ya no se actualiza. Vuelve a empezar la cuenta de vueltas, como una respuesta tuya.
      return state.status === "entregado" && !state.prCerrada
        ? enter(
            { ...state, vueltas: NO_ROUNDS, autofix: false, ...RESPONDIO_LA_PERSONA },
            "aprender",
            {
              feedback: event.texto,
            },
          )
        : state;
    case "abortado":
      return { ...state, status: "abortado" };
    case "pr_cerrada":
      return event.mergeada
        ? { ...state, prCerrada: true }
        : { ...state, status: "cerrado", prCerrada: true };
    case "rechazo":
    case "decision":
    case "aviso":
    case "unidad":
    case "preparado":
    case "lecciones":
    case "lecciones_propuestas":
    case "pr":
    case "explicacion":
      return state;
  }
}

/**
 * La detención actual del run, como la posición en el log del evento que la dejó: la clave de su
 * explicación (ADR 0037). Una detención que sigue igual (eventos que no la cambian, como el uso de una
 * explicación) conserva su número; una nueva, aunque diga lo mismo, tiene otro. Undefined si el run no
 * está detenido.
 */
export function detencionDe(events: readonly RunEvent[]): number | undefined {
  let state = initialState();
  let at: number | undefined;
  events.forEach((event, index) => {
    const next = reduce(state, event);
    if (next.halt !== state.halt) at = next.halt === undefined ? undefined : index;
    state = next;
  });
  return state.status === "detenido" ? at : undefined;
}

/**
 * flowrunner corre Autofix solo en esta detención (ADR 0028): una de verificar, revisar o probar con
 * sub-tasks, donde la persona lo podría elegir, y sin un Autofix desde su última respuesta. Si después
 * sigue en rojo, la detención siguiente pregunta como siempre. Los efectos (las herramientas y el
 * commit) los hace el proceso del run; esto solo decide.
 */
export const correAutofixSolo = (state: RunState): boolean =>
  state.status === "detenido" &&
  autofixSirve(state, state.fase) &&
  !state.aMano &&
  !state.sinProbar &&
  !state.autofixCorrio &&
  isRoundPhase(state.fase) &&
  offers(state, `flowrunner fix ${state.runId} --auto`);

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
