// Lo que el panel muestra de `flowrunner watch --json`: el árbol de cada run, en el formato del Tree
// de Orca, y el resumen de la barra de estado. Sin imports de Orca: lo prueban panel y worker.

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

export type Icon = "check" | "play" | "pause" | "error" | "warning" | "refresh" | "more" | "agent";
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Una fila del panel: una fase, una sub-task o una sesión, con su nivel en el árbol. */
export interface Row {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly icon: Icon;
  /** Si es una sesión: su nombre, para pedir sus pasos. */
  readonly sesion?: string;
}

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

export const RUN_TEXT: Record<RunStatus, { text: string; tone: Tone }> = {
  esperando_aprobacion: { text: "te espera", tone: "warning" },
  detenido: { text: "detenido", tone: "danger" },
  en_curso: { text: "en curso", tone: "accent" },
  pausado_por_limite: { text: "en pausa", tone: "warning" },
  entregado: { text: "PR abierta", tone: "success" },
  cerrado: { text: "cerrado", tone: "neutral" },
  abortado: { text: "abortado", tone: "neutral" },
};

const PHASE: Record<string, { icon: Icon; text: string }> = {
  pendiente: { icon: "more", text: "pendiente" },
  corriendo: { icon: "play", text: "trabajando" },
  ok: { icon: "check", text: "listo" },
  espera: { icon: "pause", text: "espera" },
  vuelve: { icon: "refresh", text: "volvió" },
  falla: { icon: "error", text: "falló" },
  pausa: { icon: "pause", text: "en pausa" },
};

const UNIT: Record<string, { icon: Icon; text: string }> = {
  pendiente: { icon: "more", text: "pendiente" },
  corriendo: { icon: "play", text: "trabajando" },
  commiteada: { icon: "check", text: "commiteada" },
  integrada: { icon: "check", text: "integrada" },
  fallida: { icon: "error", text: "falló" },
  sin_cambios: { icon: "warning", text: "sin cambios" },
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
  return `${live > 0 ? "≥ " : ""}USD ${total.toFixed(2)}`;
}

const join = (parts: readonly (string | undefined)[]) =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");

/** Sangría de un nivel del árbol: espacios que no se colapsan. */
const indent = (depth: number) => `${"\u00a0\u00a0".repeat(depth - 1)}└ `;

function sessionRow(run: string, s: Session, depth: number): Row {
  const now = s.corriendo
    ? join([
        s.ultimo === undefined ? undefined : `▸ ${s.ultimo}`,
        s.contexto > 0 ? `contexto ${tokenCount(s.contexto)}` : undefined,
      ])
    : undefined;
  return {
    key: `${run}/${s.nombre}`,
    title: `${indent(depth)}${s.nombre}`,
    icon: s.corriendo ? "play" : "agent",
    sesion: s.nombre,
    description: join([
      s.modelo?.replace(/^claude-/, ""),
      s.tokens > 0 ? `${tokenCount(s.tokens)} tokens` : undefined,
      cost([s], s.costoUsd ?? 0),
      duration(s.segundos),
      now,
    ]),
  };
}

const sumCost = (ss: readonly Session[]) => ss.reduce((a, s) => a + (s.costoUsd ?? 0), 0);

/** Las fases del run en orden, cada una seguida de sus sesiones y sub-tasks. */
export function runRows(run: Run): Row[] {
  return run.fases.flatMap((p) => {
    const state = PHASE[p.estado] ?? { icon: "more" as const, text: p.estado };
    const sessions = [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)];
    const phase: Row = {
      key: `${run.id}/${p.fase}`,
      title: `${p.fase}${p.sesiones.length > 1 ? ` ×${String(p.sesiones.length)}` : ""}`,
      icon: state.icon,
      description: join([
        state.text,
        cost(sessions, p.costoUsd),
        duration(p.segundos),
        p.estado === "corriendo" ? undefined : (p.detalle ?? p.nota),
      ]),
    };
    return [
      phase,
      ...p.sesiones.map((s) => sessionRow(run.id, s, 1)),
      ...p.unidades.flatMap((u) => {
        const us = UNIT[u.estado] ?? { icon: "more" as const, text: u.estado };
        return [
          {
            key: `${run.id}/${p.fase}/${u.id}`,
            title: `${indent(1)}${u.id} ${u.titulo}`,
            icon: us.icon,
            description: join([us.text, cost(u.sesiones, sumCost(u.sesiones))]),
          },
          ...u.sesiones.map((s) => sessionRow(run.id, s, 2)),
        ];
      }),
    ];
  });
}

/** El costo y el tiempo del run, en una línea. */
export function runSummary(run: Run): string {
  const all = run.fases.flatMap((p) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)]);
  return join([RUN_TEXT[run.status].text, cost(all, run.costoUsd), duration(run.segundos)]);
}
