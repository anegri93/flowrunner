// Lo que el panel muestra de `flowrunner watch --json`, sin imports de Orca: el orden de los runs,
// cuáles están terminados, la etapa actual con su detalle y las decisiones que la persona puede tomar.

export type RunStatus =
  | "en_curso"
  | "esperando_aprobacion"
  | "entregado"
  | "cerrado"
  | "detenido"
  | "pausado_por_limite"
  | "abortado";

export interface Session {
  readonly nombre: string;
  readonly modelo?: string;
  readonly esfuerzo?: string;
  readonly corriendo: boolean;
  readonly costoUsd?: number;
  readonly costoEstimado?: number;
  readonly tokens: number;
  readonly contexto: number;
  readonly ventana?: number;
  readonly segundos: number;
  readonly ultimo?: string;
}

export interface Unit {
  readonly id: string;
  readonly titulo: string;
  readonly estado: string;
  readonly dependeDe: readonly string[];
  readonly sesiones: readonly Session[];
}

export interface Phase {
  readonly fase: string;
  readonly estado: string;
  readonly segundos?: number;
  readonly costoUsd: number;
  readonly detalle?: string;
  readonly nota?: string;
  readonly sesiones: readonly Session[];
  readonly unidades: readonly Unit[];
}

export interface Run {
  readonly id: string;
  readonly clave: string;
  readonly titulo: string;
  readonly proyecto: string;
  readonly repo: string;
  readonly status: RunStatus;
  readonly costoUsd: number;
  readonly segundos: number;
  readonly motivo?: string;
  readonly siguiente?: string;
  readonly fases: readonly Phase[];
}

export type Icon = "check" | "play" | "pause" | "error" | "warning" | "refresh" | "more" | "flag";
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** La salida de `flowrunner watch --json`, o un error legible si no es eso. */
export function parseWatch(stdout: string): Run[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`flowrunner no devolvió JSON: ${stdout.slice(0, 200)}`);
  }
  const runs = (data as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) throw new Error("la salida de flowrunner no trae `runs`");
  return runs as Run[];
}

export const RUN_STATE: Record<RunStatus, { text: string; tone: Tone; icon: Icon }> = {
  esperando_aprobacion: { text: "te espera", tone: "warning", icon: "flag" },
  detenido: { text: "detenido", tone: "danger", icon: "error" },
  en_curso: { text: "en curso", tone: "accent", icon: "play" },
  pausado_por_limite: { text: "en pausa", tone: "warning", icon: "pause" },
  entregado: { text: "PR abierta", tone: "success", icon: "check" },
  cerrado: { text: "cerrado", tone: "neutral", icon: "check" },
  abortado: { text: "abortado", tone: "neutral", icon: "error" },
};

/** Terminado para la persona: ya no hay nada que mirar mientras trabaja. */
export const isFinished = (run: Run) =>
  run.status === "entregado" || run.status === "cerrado" || run.status === "abortado";

/** El momento en que arrancó, del id: `VF-3-20261109-004512`. */
const startedAt = (run: Run) => /(\d{8}-\d{6})$/.exec(run.id)?.[1] ?? "";

/** Los más recientes arriba. */
export const sortRuns = (runs: readonly Run[]): Run[] =>
  [...runs].sort((a, b) => startedAt(b).localeCompare(startedAt(a)));

const PHASE: Record<string, { mark: string; text: string; tone: Tone }> = {
  pendiente: { mark: "·", text: "pendiente", tone: "neutral" },
  corriendo: { mark: "▶", text: "trabajando", tone: "accent" },
  ok: { mark: "✓", text: "listo", tone: "success" },
  espera: { mark: "⏸", text: "espera", tone: "warning" },
  vuelve: { mark: "↺", text: "volvió", tone: "warning" },
  falla: { mark: "✗", text: "falló", tone: "danger" },
  pausa: { mark: "⏸", text: "en pausa", tone: "warning" },
};

const UNIT: Record<string, { mark: string; text: string }> = {
  pendiente: { mark: "·", text: "pendiente" },
  corriendo: { mark: "▶", text: "trabajando" },
  commiteada: { mark: "✓", text: "commiteada" },
  integrada: { mark: "✓", text: "integrada" },
  fallida: { mark: "✗", text: "falló" },
  sin_cambios: { mark: "!", text: "sin cambios" },
};

/** `12m30s`, `45s`. */
export function duration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `${String(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h${String(m % 60).padStart(2, "0")}m`;
}

/** `490k`, `1.2M`, `1M`. */
export function tokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? String(m) : m.toFixed(1)}M`;
  }
  return n >= 1_000 ? `${String(Math.round(n / 1_000))}k` : String(n);
}

/** El costo de lo que corre es un mínimo: la salida se conoce al terminar. */
function cost(ss: readonly Session[], real: number): string | undefined {
  const live = ss.filter((s) => s.corriendo).reduce((a, s) => a + (s.costoEstimado ?? 0), 0);
  const total = real + live;
  if (total === 0) return undefined;
  return `${live > 0 ? "≥ " : ""}$${total.toFixed(2)}`;
}

const join = (parts: readonly (string | undefined)[]) =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");

const sessionsOf = (p: Phase) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)];

export interface SessionLine {
  readonly nombre: string;
  readonly texto: string;
  readonly corriendo: boolean;
  /** Lo que está haciendo, si corre: la herramienta y el contexto. */
  readonly ahora?: string;
}

export interface UnitLine {
  readonly id: string;
  readonly texto: string;
  readonly meta: string;
  readonly sesiones: SessionLine[];
}

export interface PhaseLine {
  readonly fase: string;
  readonly mark: string;
  readonly estado: string;
  readonly tone: Tone;
  readonly meta: string;
  readonly detalle?: string;
}

/** Una fase con todo su detalle: la etapa actual. */
export interface CurrentPhase extends PhaseLine {
  readonly sesiones: SessionLine[];
  readonly unidades: UnitLine[];
}

export interface RunView {
  readonly listas: PhaseLine[];
  readonly actuales: CurrentPhase[];
  readonly faltan: string[];
  /** La fase actual en una palabra, para el encabezado del run. */
  readonly etapa?: string;
}

function sessionLine(s: Session): SessionLine {
  const ahora = s.corriendo
    ? join([
        s.ultimo === undefined ? undefined : `▸ ${s.ultimo}`,
        s.contexto > 0 ? `ctx ${tokenCount(s.contexto)}` : undefined,
      ])
    : undefined;
  return {
    nombre: s.nombre,
    corriendo: s.corriendo,
    texto: join([
      s.nombre,
      s.modelo?.replace(/^claude-/, ""),
      s.tokens > 0 ? tokenCount(s.tokens) : undefined,
      cost([s], s.costoUsd ?? 0),
      duration(s.segundos),
    ]),
    ...(ahora === undefined || ahora === "" ? {} : { ahora }),
  };
}

function phaseLine(p: Phase): PhaseLine {
  const state = PHASE[p.estado] ?? { mark: "·", text: p.estado, tone: "neutral" as const };
  const detalle = p.estado === "corriendo" ? undefined : (p.detalle ?? p.nota);
  return {
    fase: `${p.fase}${p.sesiones.length > 1 ? ` ×${String(p.sesiones.length)}` : ""}`,
    mark: state.mark,
    estado: state.text,
    tone: state.tone,
    meta: join([cost(sessionsOf(p), p.costoUsd), duration(p.segundos)]),
    ...(detalle === undefined ? {} : { detalle }),
  };
}

/**
 * Las fases en tres grupos: las listas, que se muestran en una línea; las actuales, con sus
 * sub-tasks y sesiones; y las que faltan, en otra línea.
 */
export function runView(run: Run): RunView {
  const listas: PhaseLine[] = [];
  const actuales: CurrentPhase[] = [];
  const faltan: string[] = [];
  for (const p of run.fases) {
    if (p.estado === "ok") listas.push(phaseLine(p));
    else if (p.estado === "pendiente") faltan.push(p.fase);
    else {
      actuales.push({
        ...phaseLine(p),
        sesiones: p.sesiones.map(sessionLine),
        unidades: p.unidades.map((u) => {
          const us = UNIT[u.estado] ?? { mark: "·", text: u.estado };
          return {
            id: u.id,
            texto: `${us.mark} ${u.id} ${u.titulo}`,
            meta: join([
              us.text,
              cost(
                u.sesiones,
                u.sesiones.reduce((a, s) => a + (s.costoUsd ?? 0), 0),
              ),
            ]),
            sesiones: u.sesiones.map(sessionLine),
          };
        }),
      });
    }
  }
  const etapa = actuales[0]?.fase ?? faltan[0];
  return { listas, actuales, faltan, ...(etapa === undefined ? {} : { etapa }) };
}

/** El encabezado de un run: estado, etapa, costo y tiempo. */
export function runSummary(run: Run): string {
  const all = run.fases.flatMap(sessionsOf);
  const etapa = isFinished(run) ? undefined : runView(run).etapa;
  return join([RUN_STATE[run.status].text, etapa, cost(all, run.costoUsd), duration(run.segundos)]);
}

export const PHASES = [
  "preparar",
  "planificar",
  "aprobar",
  "implementar",
  "verificar",
  "revisar",
  "entregar",
  "aprender",
] as const;
export type PhaseName = (typeof PHASES)[number];

/** Una decisión que la persona toma desde el panel. El worker la traduce a un comando fijo. */
export type Decision =
  | { readonly accion: "aprobar" }
  | { readonly accion: "cambios"; readonly motivo: string }
  | { readonly accion: "reanudar" }
  | { readonly accion: "rehacer"; readonly desde: PhaseName };

/** Las decisiones que tiene sentido ofrecer según el estado del run. */
export function decisionsFor(run: Run): Decision["accion"][] {
  switch (run.status) {
    case "esperando_aprobacion":
      return ["aprobar", "cambios"];
    case "detenido":
      return rerunPhase(run) === undefined ? ["reanudar"] : ["reanudar", "rehacer"];
    case "pausado_por_limite":
      return ["reanudar"];
    default:
      return [];
  }
}

/** La fase desde la que el motivo de la detención sugiere rehacer: `rerun <id> --desde verificar`. */
export function rerunPhase(run: Run): PhaseName | undefined {
  const desde = /--desde (\w+)/.exec(run.siguiente ?? "")?.[1];
  return PHASES.find((p) => p === desde);
}
