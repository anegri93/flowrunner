// El árbol de un run para `flowrunner watch`: fases, sub-tasks y sesiones, armado del log de eventos,
// del plan y de los transcripts que cada sesión escribe mientras corre. Función pura: el disco lo lee
// `load.ts`.
import { stateOf, TERMINAL, type RunStatus } from "../engine/engine.ts";
import type { Step } from "../report/transcript.ts";
import { contextWindow, estimateCost, promptTokens, type Usage } from "./pricing.ts";
import { PHASES, type Phase, type RunEvent } from "../store/events.ts";

export interface SessionFile {
  readonly jsonl: string;
  readonly birthMs: number;
  readonly mtimeMs: number;
}

export interface SessionNode {
  readonly nombre: string;
  readonly modelo: string | undefined;
  /** El esfuerzo configurado para la fase de la sesión, si se conoce. */
  readonly esfuerzo?: string | undefined;
  readonly corriendo: boolean;
  readonly costoUsd: number | undefined;
  /** Tokens nuevos: lo que leyó o escribió por primera vez, sin las relecturas de caché. */
  readonly tokens: number;
  /** El tamaño de su contexto en el último pedido: cuánto arrastra en cada vuelta. */
  readonly contexto: number;
  readonly ventana: number | undefined;
  /** El costo estimado con los precios de cada modelo, mientras no llega el real. */
  readonly costoEstimado: number | undefined;
  readonly segundos: number;
  /** Herramientas que usó. */
  readonly pasos: number;
  /** La última herramienta, en una línea: lo que está haciendo si corre. */
  readonly ultimo: string | undefined;
}

export type UnitState =
  "pendiente" | "corriendo" | "commiteada" | "integrada" | "fallida" | "sin_cambios";

export interface UnitNode {
  readonly id: string;
  readonly titulo: string;
  readonly estado: UnitState;
  readonly dependeDe: readonly string[];
  readonly sesiones: SessionNode[];
}

export type PhaseState = "pendiente" | "corriendo" | "ok" | "espera" | "falla" | "vuelve" | "pausa";

export interface PhaseNode {
  readonly fase: Phase;
  readonly estado: PhaseState;
  readonly segundos: number | undefined;
  readonly costoUsd: number;
  readonly detalle: string | undefined;
  /** Por qué se ve resuelta una fase que falló: el run la dejó atrás. */
  readonly nota?: string | undefined;
  readonly sesiones: SessionNode[];
  readonly unidades: UnitNode[];
}

export interface RunTree {
  readonly id: string;
  readonly clave: string;
  readonly titulo: string;
  readonly proyecto: string;
  readonly status: RunStatus;
  readonly costoUsd: number;
  readonly segundos: number;
  /** Hace cuánto terminó, si ya terminó. */
  readonly haceSegundos: number | undefined;
  readonly motivo: string | undefined;
  /** El comando que la persona corre para seguir, si el run la espera. */
  readonly siguiente: string | undefined;
  readonly fases: PhaseNode[];
}

export interface TreeInput {
  readonly events: readonly RunEvent[];
  readonly tasks: readonly { id: string; titulo: string; depende_de: readonly string[] }[];
  readonly titulo: string;
  readonly sessions: ReadonlyMap<string, SessionFile>;
  /** El esfuerzo de cada fase según la config del repo. */
  readonly esfuerzos?: Partial<Record<Phase, string>>;
  readonly now: number;
}

const short = (text: string, max = 70) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Una herramienta en una línea: el comando, el patrón o las dos últimas partes de la ruta. */
function toolLine(
  name: string,
  input: Record<string, unknown>,
  max = 70,
  fullPath = false,
): string {
  const str = (k: string) => (typeof input[k] === "string" ? input[k] : undefined);
  const path = str("file_path") ?? str("path");
  const shown = path === undefined || fullPath ? path : path.split("/").slice(-2).join("/");
  const target = str("command") ?? str("pattern") ?? shown;
  return short(target === undefined ? name : `${name} ${target}`, max);
}

/** Un paso del transcript para leerlo en la terminal: la herramienta en una línea, como en el árbol,
 * y las rutas del worktree relativas al repo. */
export function tidyStep(step: Step, worktrees: string): Step {
  const prefix = new RegExp(`${worktrees.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/\\s]+/`, "g");
  const texto = step.texto.replace(prefix, "");
  if (step.tipo !== "herramienta") return { ...step, texto };
  const m = /^(\S+) (\{[\s\S]*\})$/.exec(texto);
  if (m === null) return { ...step, texto };
  try {
    const input = JSON.parse(m[2] ?? "") as unknown;
    if (typeof input !== "object" || input === null) return { ...step, texto };
    return { ...step, texto: toolLine(m[1] ?? "", input as Record<string, unknown>, 400, true) };
  } catch {
    return { ...step, texto };
  }
}

/** Lo nuevo de un pedido: entrada sin caché, escrituras de caché y salida. */
const fresh = (u: Usage) =>
  (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);

export function sessionNode(nombre: string, file: SessionFile, now: number): SessionNode {
  let modelo: string | undefined;
  let costoUsd: number | undefined;
  let pasos = 0;
  let ultimo: string | undefined;
  // Mientras corre, la suma por mensaje; el SDK repite el mismo mensaje por cada bloque, así que va
  // por id. Al terminar, el total del resultado. Los subagentes cuentan con su propio modelo.
  const perMessage = new Map<string, { model: string; usage: Usage }>();
  let last: Usage | undefined;
  let final: number | undefined;
  for (const raw of file.jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    let m: {
      type?: string;
      model?: string;
      total_cost_usd?: number;
      usage?: Usage;
      modelUsage?: Record<
        string,
        { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number }
      >;
      parent_tool_use_id?: string | null;
      message?: { id?: string; model?: string; content?: unknown; usage?: Usage };
    };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      continue; // la última línea puede estar a medio escribir
    }
    // El modelo de la sesión es el del arranque, no el del último mensaje, que puede ser de un subagente.
    if (m.type === "system" && m.model !== undefined) modelo = m.model;
    modelo ??= m.message?.model;
    if (m.type === "result") {
      costoUsd = m.total_cost_usd ?? 0;
      // `usage` es solo de la sesión principal; `modelUsage` suma también a sus subagentes.
      final =
        m.modelUsage === undefined
          ? m.usage === undefined
            ? undefined
            : fresh(m.usage)
          : Object.values(m.modelUsage).reduce(
              (a, u) =>
                a +
                (u.inputTokens ?? 0) +
                (u.cacheCreationInputTokens ?? 0) +
                (u.outputTokens ?? 0),
              0,
            );
    }
    if (m.type === "assistant" && m.message?.usage !== undefined) {
      const model = m.message.model ?? modelo ?? "";
      perMessage.set(m.message.id ?? String(perMessage.size), { model, usage: m.message.usage });
      // El contexto es el de la sesión principal, no el de sus subagentes.
      if (m.parent_tool_use_id == null) last = m.message.usage;
    }
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const b of m.message.content as Record<string, unknown>[]) {
      if (b.type !== "tool_use") continue;
      pasos += 1;
      const input =
        typeof b.input === "object" && b.input !== null ? (b.input as Record<string, unknown>) : {};
      ultimo = toolLine(String(b.name), input);
    }
  }
  const corriendo = costoUsd === undefined;
  const end = corriendo ? now : file.mtimeMs;
  const messages = [...perMessage.values()];
  const costs = messages.map((x) => estimateCost(x.model, x.usage));
  return {
    nombre,
    modelo,
    corriendo,
    costoUsd,
    tokens: final ?? messages.reduce((a, x) => a + fresh(x.usage), 0),
    contexto: last === undefined ? 0 : promptTokens(last),
    ventana: modelo === undefined ? undefined : contextWindow(modelo),
    costoEstimado: costs.some((c) => c === undefined)
      ? undefined
      : costs.reduce<number>((a, c) => a + (c ?? 0), 0),
    segundos: Math.max(0, Math.round((end - file.birthMs) / 1000)),
    pasos,
    ultimo,
  };
}

/** `implementar-ST-2-1` es de la sub-task ST-2; `planificar-1`, de la fase planificar. */
function sessionOwner(nombre: string): { fase: Phase; unidad: string | undefined } | undefined {
  const base = nombre.replace(/-\d+$/, "");
  if (base.startsWith("implementar-")) return { fase: "implementar", unidad: base.slice(12) };
  const fase = PHASES.find((p) => base === p || base.startsWith(`${p}-`));
  return fase === undefined ? undefined : { fase, unidad: undefined };
}

const UNIT_STATE = {
  iniciada: "corriendo",
  commiteada: "commiteada",
  integrada: "integrada",
  fallida: "fallida",
  sin_cambios: "sin_cambios",
} as const;

export function runTree(input: TreeInput): RunTree {
  const { events, now } = input;
  const state = stateOf(events);
  const created = events.find((e) => e.tipo === "run_creado");

  const sessions = [...input.sessions.entries()]
    .sort(([, a], [, b]) => a.birthMs - b.birthMs)
    .map(([nombre, file]) => {
      const owner = sessionOwner(nombre);
      const esfuerzo = owner === undefined ? undefined : input.esfuerzos?.[owner.fase];
      return { owner, node: { ...sessionNode(nombre, file, now), esfuerzo } };
    });

  const unitStates = new Map<string, UnitState>();
  for (const e of events) if (e.tipo === "unidad") unitStates.set(e.unidad, UNIT_STATE[e.estado]);

  /** Cuándo empezó por última vez cada fase: lo que dice si el run dejó atrás una falla. */
  const lastStart = new Map<Phase, number>();
  for (const e of events) if (e.tipo === "accion_iniciada") lastStart.set(e.fase, Date.parse(e.at));
  const everIntegrated = new Set(
    events.flatMap((e) => (e.tipo === "unidad" && e.estado === "integrada" ? [e.unidad] : [])),
  );

  const fases = PHASES.map((fase, index): PhaseNode => {
    let started: number | undefined;
    let ended:
      | { at: number; resultado: Extract<RunEvent, { tipo: "accion_terminada" }>["resultado"] }
      | undefined;
    let costoUsd = 0;
    for (const e of events) {
      if (e.tipo === "accion_iniciada" && e.fase === fase) {
        started = Date.parse(e.at);
        ended = undefined;
      } else if (e.tipo === "accion_terminada" && e.fase === fase) {
        ended = { at: Date.parse(e.at), resultado: e.resultado };
      } else if (e.tipo === "uso" && e.fase === fase) costoUsd += e.costo_usd;
      // Tu respuesta al plan cierra la espera de aprobar sin que la fase vuelva a correr.
      else if (fase === "aprobar" && ended?.resultado.tipo === "espera") {
        if (e.tipo === "aprobado") ended = { at: Date.parse(e.at), resultado: { tipo: "ok" } };
        if (e.tipo === "cambios_pedidos") {
          ended = {
            at: Date.parse(e.at),
            resultado: {
              tipo: "vuelve",
              unidades: ["plan"],
              motivo: `pediste cambios: ${e.motivo}`,
            },
          };
        }
      }
    }
    const r = ended?.resultado;
    // Una falla o una vuelta que el run dejó atrás: una fase posterior corrió después.
    const overtaken =
      ended !== undefined && (r?.tipo === "falla" || r?.tipo === "vuelve")
        ? PHASES.slice(index + 1).find((q) => (lastStart.get(q) ?? -1) >= ended.at)
        : undefined;
    const raw: PhaseState =
      started === undefined
        ? // Entregado, aprender corre recién cuando el tick ve la PR mergeada.
          fase === "aprender" && state.status === "entregado"
          ? "espera"
          : "pendiente"
        : r === undefined
          ? "corriendo"
          : r.tipo === "limite"
            ? "pausa"
            : r.tipo;
    const estado: PhaseState = overtaken === undefined ? raw : "ok";
    const nota =
      overtaken === undefined
        ? undefined
        : `${r?.tipo === "falla" ? "falló" : "volvió"} en una corrida anterior; el run siguió desde ${overtaken}`;
    const detalle =
      overtaken === undefined && (r?.tipo === "falla" || r?.tipo === "vuelve")
        ? r.motivo
        : undefined;
    const mine = sessions.filter((s) => s.owner?.fase === fase);
    const unidades =
      fase === "implementar"
        ? input.tasks.map((t): UnitNode => {
            const own = mine.filter((s) => s.owner?.unidad === t.id).map((s) => s.node);
            const running = own.some((s) => s.corriendo);
            return {
              id: t.id,
              titulo: t.titulo,
              estado: running
                ? "corriendo"
                : overtaken !== undefined && everIntegrated.has(t.id)
                  ? "integrada"
                  : (unitStates.get(t.id) ?? "pendiente"),
              dependeDe: t.depende_de,
              sesiones: own,
            };
          })
        : [];
    return {
      fase,
      estado,
      segundos:
        started === undefined ? undefined : Math.round(((ended?.at ?? now) - started) / 1000),
      costoUsd,
      detalle,
      nota,
      sesiones: fase === "implementar" ? [] : mine.map((s) => s.node),
      unidades,
    };
  });

  const id = state.runId;
  // Un run terminado no sigue sumando tiempo: cuenta hasta su último evento.
  const lastAt = events.at(-1)?.at;
  const end = TERMINAL.has(state.status) && lastAt !== undefined ? Date.parse(lastAt) : now;
  const pr = events.findLast((e) => e.tipo === "pr");
  const siguiente =
    state.status === "esperando_aprobacion"
      ? `flowrunner plan ${id}`
      : state.status === "detenido"
        ? state.halt?.siguiente
        : state.status === "entregado"
          ? pr?.url
          : undefined;
  return {
    id,
    clave: state.clave,
    titulo: input.titulo,
    proyecto: state.proyecto,
    status: state.status,
    costoUsd: state.costoUsd,
    segundos: created === undefined ? 0 : Math.round((end - Date.parse(created.at)) / 1000),
    haceSegundos: end === now ? undefined : Math.round((now - end) / 1000),
    motivo: state.halt?.motivo,
    siguiente,
    fases,
  };
}
