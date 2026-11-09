// Lo que el panel muestra de `flowrunner watch --json`, sin imports de Orca. Cada run se lee como el
// seguimiento de un pedido: una frase con su estado, cinco pasos y el detalle de lo que pasa ahora.

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

/** Terminado para la persona: ya no hay nada que mirar mientras trabaja. */
export const isFinished = (run: Run) =>
  run.status === "entregado" || run.status === "cerrado" || run.status === "abortado";

/** Un run que espera algo de la persona. */
export const needsYou = (run: Run) =>
  run.status === "esperando_aprobacion" || run.status === "detenido";

/** El momento en que arrancó, del id: `VF-3-20261109-004512`. */
const startedAt = (run: Run) => /(\d{8}-\d{6})$/.exec(run.id)?.[1] ?? "";

/** Los más recientes arriba. */
export const sortRuns = (runs: readonly Run[]): Run[] =>
  [...runs].sort((a, b) => startedAt(b).localeCompare(startedAt(a)));

/** `12m30s`, `45s`, `1h02m`. */
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

const join = (parts: readonly (string | undefined)[]) =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");

const sessionsOf = (p: Phase) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)];

/** El costo de lo que corre es un mínimo: la salida se conoce al terminar. */
function cost(ss: readonly Session[], real: number): string | undefined {
  const live = ss.filter((s) => s.corriendo).reduce((a, s) => a + (s.costoEstimado ?? 0), 0);
  const total = real + live;
  if (total === 0) return undefined;
  return `${live > 0 ? "≥ " : ""}$${total.toFixed(2)}`;
}

// --- Los cinco pasos -------------------------------------------------------------------------

export type StepState = "listo" | "ahora" | "espera" | "falla" | "pendiente";

export interface Step {
  readonly label: string;
  readonly estado: StepState;
}

/** Las fases de flowrunner agrupadas como las ve la persona. */
const STEPS: readonly { label: string; fases: readonly string[] }[] = [
  { label: "Plan", fases: ["preparar", "planificar"] },
  { label: "Tu OK", fases: ["aprobar"] },
  { label: "Código", fases: ["implementar"] },
  { label: "Control", fases: ["verificar", "revisar"] },
  { label: "PR", fases: ["entregar", "aprender"] },
];

export const STEP_MARK: Record<StepState, { mark: string; tone: Tone }> = {
  listo: { mark: "✓", tone: "success" },
  ahora: { mark: "●", tone: "accent" },
  espera: { mark: "●", tone: "warning" },
  falla: { mark: "✕", tone: "danger" },
  pendiente: { mark: "○", tone: "neutral" },
};

function stepState(run: Run, phases: readonly Phase[]): StepState {
  const states = phases.map((p) => p.estado);
  if (states.includes("falla")) return "falla";
  if (states.length > 0 && states.every((s) => s === "ok")) return "listo";
  if (states.some((s) => s === "espera" || s === "pausa")) return "espera";
  if (states.some((s) => s === "corriendo" || s === "vuelve")) {
    return run.status === "detenido" ? "falla" : "ahora";
  }
  return states.some((s) => s === "ok") && run.status === "detenido" ? "falla" : "pendiente";
}

/** Los cinco pasos del run, cada uno con su estado. */
export function stepsOf(run: Run): Step[] {
  const steps = STEPS.map((step) => ({
    label: step.label,
    estado: stepState(
      run,
      run.fases.filter((p) => step.fases.includes(p.fase)),
    ),
  }));
  if (run.status === "cerrado") return steps.map((s) => ({ ...s, estado: "listo" as const }));
  return steps;
}

/** Cuánto avanzó, de 0 a 100: cada paso listo suma entero y el actual, medio. */
export function progressOf(run: Run): number {
  const steps = stepsOf(run);
  const points = steps.reduce(
    (a, s) => a + (s.estado === "listo" ? 1 : s.estado === "pendiente" ? 0 : 0.5),
    0,
  );
  return Math.round((points / steps.length) * 100);
}

// --- La frase del estado --------------------------------------------------------------------

export interface Headline {
  readonly emoji: string;
  readonly texto: string;
  readonly tone: Tone;
}

const DOING: Record<string, string> = {
  preparar: "Preparando el repo",
  planificar: "Planificando",
  implementar: "Implementando",
  verificar: "Verificando los criterios",
  revisar: "Revisando el cambio",
  entregar: "Abriendo la PR",
  aprender: "Aprendiendo de tu merge",
};

const activePhase = (run: Run) =>
  run.fases.find((p) => !["ok", "pendiente"].includes(p.estado)) ??
  run.fases.find((p) => p.estado === "pendiente");

function unitsDone(p: Phase): string | undefined {
  if (p.unidades.length === 0) return undefined;
  const done = p.unidades.filter((u) => u.estado === "integrada" || u.estado === "commiteada");
  return `${String(done.length)} de ${String(p.unidades.length)} sub-tasks`;
}

/** Lo que pasa con el run, en una frase que se entiende de un vistazo. */
export function headlineOf(run: Run): Headline {
  const phase = activePhase(run);
  switch (run.status) {
    case "esperando_aprobacion":
      return { emoji: "🟡", texto: "El plan te espera", tone: "warning" };
    case "detenido":
      return {
        emoji: "🔴",
        texto: `Se detuvo en ${phase?.fase ?? "una fase"}`,
        tone: "danger",
      };
    case "pausado_por_limite":
      return { emoji: "🟡", texto: "En pausa por el límite de uso", tone: "warning" };
    case "entregado":
      return { emoji: "🟢", texto: "PR abierta: falta tu merge", tone: "success" };
    case "cerrado":
      return { emoji: "🟢", texto: "Listo y mergeado", tone: "success" };
    case "abortado":
      return { emoji: "⚪", texto: "Cancelado", tone: "neutral" };
    case "en_curso": {
      const doing = phase === undefined ? "Trabajando" : (DOING[phase.fase] ?? phase.fase);
      const units = phase === undefined ? undefined : unitsDone(phase);
      const back = phase?.estado === "vuelve" ? "corrigiendo" : undefined;
      return { emoji: "🔵", texto: join([doing, units, back]), tone: "accent" };
    }
  }
}

// --- El detalle de ahora --------------------------------------------------------------------

export interface TaskLine {
  readonly key: string;
  readonly mark: string;
  readonly tone: Tone;
  readonly texto: string;
  readonly nota?: string;
}

export interface Activity {
  readonly sesion: string;
  /** El modelo, los tokens y el costo de la sesión que corre. */
  readonly texto: string;
  /** La herramienta que está usando y el contexto que arrastra. */
  readonly ahora?: string;
}

export interface Now {
  /** Las sub-tasks de implementar, como una lista de tareas. */
  readonly tareas: TaskLine[];
  /** Las sesiones del paso actual: la que corre primero. */
  readonly actividad: Activity[];
  /** El costo total y el tiempo del run. */
  readonly meta: string;
  /** Lo que dijo la última fase que falló o volvió, si hay. */
  readonly detalle?: string;
}

const TASK: Record<string, { mark: string; tone: Tone; texto: string }> = {
  pendiente: { mark: "○", tone: "neutral", texto: "pendiente" },
  corriendo: { mark: "●", tone: "accent", texto: "trabajando" },
  commiteada: { mark: "✓", tone: "success", texto: "lista" },
  integrada: { mark: "✓", tone: "success", texto: "lista" },
  fallida: { mark: "✕", tone: "danger", texto: "falló" },
  sin_cambios: { mark: "!", tone: "warning", texto: "sin cambios" },
};

function activity(s: Session): Activity {
  const ahora = s.corriendo
    ? join([
        s.ultimo === undefined ? undefined : `▸ ${s.ultimo}`,
        s.contexto > 0 ? `ctx ${tokenCount(s.contexto)}` : undefined,
      ])
    : "";
  return {
    sesion: s.nombre,
    texto: join([
      s.nombre,
      s.modelo?.replace(/^claude-/, ""),
      s.tokens > 0 ? tokenCount(s.tokens) : undefined,
      cost([s], s.costoUsd ?? 0),
    ]),
    ...(ahora === "" ? {} : { ahora }),
  };
}

/** El detalle del paso en que está el run. */
export function nowOf(run: Run): Now {
  const phase = activePhase(run);
  const all = run.fases.flatMap(sessionsOf);
  const meta = join([cost(all, run.costoUsd), duration(run.segundos)]);
  const tareas = (phase?.unidades ?? []).map((u): TaskLine => {
    const t = TASK[u.estado] ?? { mark: "○", tone: "neutral" as const, texto: u.estado };
    const waiting = u.dependeDe.filter(
      (d) => phase?.unidades.find((x) => x.id === d)?.estado !== "integrada",
    );
    const nota =
      u.estado === "pendiente" && waiting.length > 0 ? `espera ${waiting.join(", ")}` : t.texto;
    return { key: u.id, mark: t.mark, tone: t.tone, texto: `${u.id} ${u.titulo}`, nota };
  });
  const sessions = phase === undefined ? [] : sessionsOf(phase);
  const actividad = [
    ...sessions.filter((s) => s.corriendo),
    ...sessions.filter((s) => !s.corriendo),
  ]
    .slice(0, 3)
    .map(activity);
  const failed = run.fases.findLast((p) => p.estado === "falla" || p.estado === "vuelve");
  const detalle = failed?.detalle;
  return { tareas, actividad, meta, ...(detalle === undefined ? {} : { detalle }) };
}

// --- Las decisiones -------------------------------------------------------------------------

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

// --- El plan --------------------------------------------------------------------------------

/** Lo que el panel muestra del plan: lo que hace falta para decidir, en textos que Orca dibuja. */
export interface PlanView {
  readonly subtareas: { readonly id: string; readonly titulo: string }[];
  readonly criterios: number;
  /** Qué cambió contra el plan anterior, en líneas cortas; vacío en el primer plan. */
  readonly cambios: string[];
  /** El plan en Markdown, recortado: Orca no dibuja textos de más de 16 KiB. */
  readonly texto: string;
  readonly recortado: boolean;
}

/** Orca rechaza un dibujo con un texto de más de 16 KiB, en bytes: 4000 caracteres entran aun en UTF-8 ancho. */
export const MAX_TEXT_CHARS = 4_000;

/** El final de un texto largo, para que entre en lo que Orca dibuja. */
export const tail = (text: string, max = MAX_TEXT_CHARS) =>
  text.length > max ? `…${text.slice(-max)}` : text;

/** La salida de `flowrunner plan --json`, reducida a lo que el panel muestra. */
export function planView(data: unknown): PlanView {
  const d = data as {
    plan?: string;
    subtareas?: { id: string; titulo: string }[];
    criterios?: unknown[];
    cambios?: Record<string, string[]> | null;
  };
  const LABELS: Record<string, string> = {
    subtareas_agregadas: "sub-tasks nuevas",
    subtareas_quitadas: "sub-tasks que ya no están",
    alcance_agregado: "alcance nuevo",
    alcance_quitado: "alcance que ya no está",
    tests_agregados: "tests nuevos",
    tests_quitados: "tests que ya no están",
  };
  const cambios = Object.entries(d.cambios ?? {})
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => `${LABELS[key] ?? key}: ${items.join(", ")}`);
  const plan = d.plan ?? "";
  return {
    subtareas: (d.subtareas ?? []).map((t) => ({ id: t.id, titulo: t.titulo })),
    criterios: d.criterios?.length ?? 0,
    cambios,
    texto: plan.length > MAX_TEXT_CHARS ? `${plan.slice(0, MAX_TEXT_CHARS)}…` : plan,
    recortado: plan.length > MAX_TEXT_CHARS,
  };
}
