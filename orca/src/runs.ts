// Lo que el panel muestra de `flowrunner watch --json`, sin imports de Orca. Cada run se lee como el
// seguimiento de un pedido: una frase con su estado, cinco pasos y el detalle de lo que pasa ahora.

export type RunStatus =
  | "en_curso"
  | "en_cola"
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
  /** La PR ya se mergeó: un run entregado espera aprender, no tu merge. */
  readonly prMergeada?: boolean;
  readonly costoUsd: number;
  readonly segundos: number;
  readonly motivo?: string;
  readonly siguiente?: string;
  /** Las respuestas de un run detenido; un flowrunner anterior no las informa. */
  readonly opciones?: readonly Opcion[];
  /** Las sub-tasks a las que un run detenido atribuye el problema. */
  readonly unidades?: readonly string[];
  /** Lo que hoy existe y el plan cambia. Con algo acá, aprobar pide aceptarlo. */
  readonly cambiaLoExistente?: readonly ExistingChange[];
  readonly fases: readonly Phase[];
}

/** Una respuesta a un run detenido, como la arma flowrunner: el comando y qué hace (ADR 0023). */
export interface Opcion {
  readonly comando: string;
  readonly que: string;
  /** Un arreglo con la instrucción ya escrita: se elige con un toque (ADR 0028). */
  readonly arreglo?: Arreglo;
}

/** Lo que una sub-task haría con un arreglo propuesto: la instrucción de `fix --unidad`. */
export interface Arreglo {
  readonly unidad: string;
  readonly instruccion: string;
}

/** Un comportamiento de hoy que el plan cambia: qué, dónde lo fija el código y qué criterio lo pide. */
export interface ExistingChange {
  readonly que: string;
  readonly donde: string;
  readonly criterio: string;
}

/** Lo que el plan cambia de lo existente; vacío con un flowrunner anterior que no lo informa. */
export const existingChanges = (run: Run): readonly ExistingChange[] => run.cambiaLoExistente ?? [];

export const describeExisting = (c: ExistingChange) => `${c.que} (${c.donde}) ← ${c.criterio}`;

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

/** Cerrado del todo: no avanza más. Los muestra el panel aparte, colapsados. */
export const isClosed = (run: Run) => run.status === "cerrado" || run.status === "abortado";

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

/** El tiempo como un reloj: `0:12`, `13:01`, `1:02:05`. */
export function clock(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

/** El estado del run en una etiqueta: con la PR mergeada, ya no está abierta. */
export const runChip = (run: Run): { texto: string; tone: Tone } =>
  run.status === "entregado" && run.prMergeada === true
    ? { texto: "PR MERGEADA", tone: "success" }
    : RUN_CHIP[run.status];

/** El estado del run en una etiqueta, con las palabras de `flowrunner watch`. */
export const RUN_CHIP: Record<RunStatus, { texto: string; tone: Tone }> = {
  en_curso: { texto: "EN CURSO", tone: "accent" },
  en_cola: { texto: "EN COLA", tone: "neutral" },
  esperando_aprobacion: { texto: "TE ESPERA", tone: "warning" },
  detenido: { texto: "DETENIDO", tone: "danger" },
  pausado_por_limite: { texto: "EN PAUSA", tone: "warning" },
  entregado: { texto: "PR ABIERTA", tone: "success" },
  cerrado: { texto: "CERRADO", tone: "neutral" },
  abortado: { texto: "ABORTADO", tone: "neutral" },
};

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

// --- Las nueve etapas ------------------------------------------------------------------------

/** Las etapas del flujo, en orden, como en el diagrama. */
export const STATIONS = [
  "preparar",
  "planificar",
  "aprobar",
  "implementar",
  "verificar",
  "revisar",
  "probar",
  "entregar",
  "aprender",
] as const;

export interface Station {
  /** El nombre de la etapa, como en el diagrama: `Implementar`. */
  readonly nombre: string;
  readonly fase: string;
  /** El estado de la fase en flowrunner: pendiente, corriendo, ok, salteada, espera, vuelve, falla, pausa. */
  readonly estado: string;
}

/** Cómo se muestra cada estado de una fase: el mismo texto que `flowrunner watch`. */
export function phaseLabel(
  fase: string,
  estado: string,
  prMergeada = false,
): { mark: string; texto: string; tone: Tone } {
  switch (estado) {
    case "ok":
      return {
        mark: "✓",
        texto: fase === "aprobar" ? "aprobado" : fase === "entregar" ? "PR creada" : "listo",
        tone: "success",
      };
    case "corriendo":
      return { mark: "●", texto: "trabajando", tone: "accent" };
    case "cortada":
      return { mark: "–", texto: "cortada", tone: "neutral" };
    case "salteada":
      return { mark: "–", texto: "salteada", tone: "warning" };
    case "espera":
      return fase === "aprobar"
        ? { mark: "●", texto: "te espera", tone: "warning" }
        : prMergeada
          ? { mark: "●", texto: "aprende al próximo chequeo", tone: "accent" }
          : { mark: "●", texto: "espera merge", tone: "warning" };
    case "vuelve":
      return { mark: "↺", texto: "volvió", tone: "warning" };
    case "falla":
      return { mark: "✕", texto: "falló", tone: "danger" };
    case "pausa":
      return { mark: "●", texto: "en pausa", tone: "warning" };
    default:
      return { mark: "○", texto: "pendiente", tone: "neutral" };
  }
}

/**
 * Las nueve etapas del run, con el estado de cada uno. En un run cerrado nada trabaja: una etapa que
 * quedó corriendo se muestra cortada, aunque el árbol que llegó diga otra cosa.
 */
export function stationsOf(run: Run): Station[] {
  return STATIONS.map((fase) => {
    const estado = run.fases.find((p) => p.fase === fase)?.estado ?? "pendiente";
    return {
      nombre: capitalize(fase),
      fase,
      estado: isClosed(run) && estado === "corriendo" ? "cortada" : estado,
    };
  });
}

/**
 * Un run cerrado en un renglón: cómo terminó, cuándo arrancó, cuánto tardó y cuánto costó, como
 * `abortado · 09/11 10:25 · 2:16:07 · $5.22`.
 */
export function closedSummary(run: Run): string {
  const at = /^\d{4}(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(startedAt(run));
  return join([
    run.status,
    at === null ? undefined : `${at[2] ?? ""}/${at[1] ?? ""} ${at[3] ?? ""}:${at[4] ?? ""}`,
    clock(run.segundos),
    `$${run.costoUsd.toFixed(2)}`,
  ]);
}

export interface StageRow {
  readonly fase: string;
  readonly nombre: string;
  /** El estado de la fase en flowrunner. */
  readonly estado: string;
  readonly mark: string;
  readonly tone: Tone;
  /** El estado en palabras de `flowrunner watch`: trabajando, te espera, falló. */
  readonly texto: string;
  /** Los intentos, si hubo más de uno, y el tiempo: `4 intentos · 13:01`. */
  readonly meta: string;
  /**
   * La etapa en la que está el run: la primera que trabaja, espera, falló o volvió. Una sola: si
   * implementar rehace lo que verificar devolvió, verificar sigue en «volvió» pero no es la actual.
   */
  readonly actual: boolean;
}

/** Lo que no es la etapa actual: lo terminado, lo salteado y lo que todavía no empezó. */
const RESUELTA: readonly string[] = ["ok", "salteada", "pendiente"];

/** Las nueve etapas como filas de una lista, con su tiempo y sus intentos. */
export function stageRows(run: Run): StageRow[] {
  const stations = stationsOf(run);
  const current = stations.findIndex((s) => !RESUELTA.includes(s.estado));
  return stations.map((station, index) => {
    const p = run.fases.find((x) => x.fase === station.fase);
    const label = phaseLabel(station.fase, station.estado, run.prMergeada === true);
    const tries =
      p !== undefined && p.sesiones.length > 1
        ? `${String(p.sesiones.length)} intentos`
        : undefined;
    const time = p?.segundos !== undefined && p.segundos > 0 ? clock(p.segundos) : undefined;
    return {
      fase: station.fase,
      nombre: station.nombre,
      estado: station.estado,
      mark: label.mark,
      tone: label.tone,
      texto: label.texto,
      meta: join([tries, time]),
      actual: index === current,
    };
  });
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// --- La frase del estado --------------------------------------------------------------------

export interface Headline {
  readonly emoji: string;
  readonly texto: string;
  readonly tone: Tone;
}

/** La fase en la que está el run: la primera que no está lista ni pendiente, o la próxima. */
const activePhase = (run: Run) =>
  run.fases.find((p) => !RESUELTA.includes(p.estado)) ??
  run.fases.find((p) => p.estado === "pendiente");

const EMOJI: Record<Tone, string> = {
  accent: "🔵",
  warning: "🟡",
  danger: "🔴",
  success: "🟢",
  neutral: "⚪",
};

/** La etapa en la que está el run y su estado, como en el diagrama: `Aprobar — te espera`. */
export function headlineOf(run: Run): Headline {
  if (run.status === "cerrado") return { emoji: EMOJI.success, texto: "cerrado", tone: "success" };
  if (run.status === "abortado")
    return { emoji: EMOJI.neutral, texto: "abortado", tone: "neutral" };
  const phase = activePhase(run);
  if (phase === undefined) return { emoji: EMOJI.neutral, texto: run.status, tone: "neutral" };
  // Sin proceso hasta que se libere un lugar del repo: no está trabajando ni te espera (ADR 0019).
  if (run.status === "en_cola")
    return { emoji: EMOJI.neutral, texto: `${capitalize(phase.fase)} — en cola`, tone: "neutral" };
  const label = phaseLabel(phase.fase, phase.estado, run.prMergeada === true);
  const integradas =
    phase.unidades.length === 0
      ? undefined
      : `${String(phase.unidades.filter((u) => u.estado === "integrada").length)} de ${String(phase.unidades.length)} integradas`;
  return {
    emoji: EMOJI[label.tone],
    texto: `${capitalize(phase.fase)} — ${join([label.texto, integradas])}`,
    tone: label.tone,
  };
}

// --- El detalle de ahora --------------------------------------------------------------------

export interface TaskLine {
  readonly key: string;
  /** El estado de la sub-task en flowrunner: pendiente, corriendo, integrada, fallida… */
  readonly estado: string;
  readonly mark: string;
  readonly tone: Tone;
  /** `ST-4 Pantallas · espera ST-1`: una línea que se recorta en el ancho angosto. */
  readonly texto: string;
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
  /** El costo total del run: chico, al pie. */
  readonly meta: string;
  /** Lo que dijo la última fase que falló o volvió, si hay. */
  readonly detalle?: string;
}

/** Cómo se muestra cada estado de una sub-task: el mismo texto que `flowrunner watch`. */
const TASK: Record<string, { mark: string; tone: Tone; texto: string }> = {
  pendiente: { mark: "○", tone: "neutral", texto: "pendiente" },
  corriendo: { mark: "●", tone: "accent", texto: "trabajando" },
  cortada: { mark: "–", tone: "neutral", texto: "cortada" },
  commiteada: { mark: "✓", tone: "success", texto: "commiteada" },
  integrada: { mark: "✓", tone: "success", texto: "integrada" },
  fallida: { mark: "✕", tone: "danger", texto: "falló" },
  sin_cambios: { mark: "✓", tone: "success", texto: "sin cambios" },
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
  const meta = cost(all, run.costoUsd) ?? "";
  // Las sub-tasks son lo que más dice de un run: las del paso actual, o las de implementar.
  const withUnits =
    phase !== undefined && phase.unidades.length > 0
      ? phase
      : run.fases.find((p) => p.unidades.length > 0);
  const tareas = (withUnits?.unidades ?? []).map((u): TaskLine => {
    const t = TASK[u.estado] ?? { mark: "○", tone: "neutral" as const, texto: u.estado };
    const waiting = u.dependeDe.filter(
      (d) => withUnits?.unidades.find((x) => x.id === d)?.estado !== "integrada",
    );
    const nota =
      u.estado === "pendiente" && waiting.length > 0 ? `espera ${waiting.join(", ")}` : t.texto;
    return {
      key: u.id,
      estado: u.estado,
      mark: t.mark,
      tone: t.tone,
      texto: join([`${u.id} ${u.titulo}`, nota]),
    };
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
  return {
    tareas,
    actividad,
    meta,
    ...(detalle === undefined ? {} : { detalle }),
  };
}

// --- Las decisiones -------------------------------------------------------------------------

export const PHASES = STATIONS;
export type PhaseName = (typeof STATIONS)[number];

/** Una decisión que la persona toma desde el panel. El worker la traduce a un comando fijo. */
export type Decision =
  /**
   * `plan`: la versión del plan que la persona abrió (`planVersion`); el worker no aprueba si cambió.
   * `aceptoCambios`: la persona vio lo que el plan cambia de lo existente y lo acepta.
   */
  | { readonly accion: "aprobar"; readonly plan: string; readonly aceptoCambios?: true }
  | { readonly accion: "cambios"; readonly motivo: string }
  | { readonly accion: "reanudar" }
  | { readonly accion: "rehacer"; readonly desde: PhaseName }
  | { readonly accion: "aprender" }
  | { readonly accion: "abortar" }
  /** Que esa sub-task corrija lo que la persona escribe, sobre el código que ya está. */
  | { readonly accion: "arreglar"; readonly unidad: string; readonly instruccion: string }
  /**
   * Autofix (ADR 0026): formateador y lint del repo y a verificar; si sigue en rojo, las sub-tasks lo
   * corrigen solas. Reemplaza en el panel a «Lo arreglo yo», que sigue en el CLI (`fix --yo`).
   */
  | { readonly accion: "autofix" }
  /** Seguir a la fase siguiente igual; el motivo queda en la PR. */
  | { readonly accion: "aceptar"; readonly motivo: string };

/** Un run vivo se puede abortar, en cualquier etapa: todos menos los cerrados y los abortados. */
export const canAbort = (run: Run) => run.status !== "cerrado" && run.status !== "abortado";

/**
 * Las sub-tasks que el run detenido ofrece arreglar con tu instrucción, de sus opciones
 * `fix <run> --unidad ST-n`. Las que traen el arreglo escrito van aparte, en `suggestedFixes`.
 */
export const fixUnits = (run: Run): string[] =>
  (run.opciones ?? []).flatMap((o) => {
    const unidad = /--unidad (ST-\d+)/.exec(o.comando)?.[1];
    return unidad === undefined || o.arreglo !== undefined ? [] : [unidad];
  });

/** Los arreglos que el run detenido propone, ya escritos, en el orden en que los ofrece. */
export const suggestedFixes = (run: Run): Arreglo[] =>
  (run.opciones ?? []).flatMap((o) => (o.arreglo === undefined ? [] : [o.arreglo]));

/** El run detenido ofrece ese comando entre sus opciones. */
export function offers(run: Run, comando: "fix --auto" | "accept" | "resume"): boolean {
  const matches: Record<typeof comando, RegExp> = {
    "fix --auto": /^flowrunner fix \S+ --auto$/,
    accept: /^flowrunner accept \S+ /,
    resume: /^flowrunner resume \S+$/,
  };
  return (run.opciones ?? []).some((o) => matches[comando].test(o.comando));
}

/** Las respuestas de un run detenido, de las opciones que arma flowrunner. */
function stoppedDecisions(run: Run): Decision["accion"][] {
  if (run.opciones === undefined)
    return rerunPhase(run) === undefined ? ["reanudar"] : ["reanudar", "rehacer"];
  const out: Decision["accion"][] = [];
  if (fixUnits(run).length > 0 || suggestedFixes(run).length > 0) out.push("arreglar");
  if (offers(run, "fix --auto")) out.push("autofix");
  if (offers(run, "accept")) out.push("aceptar");
  if (offers(run, "resume")) out.push("reanudar");
  if (rerunPhase(run) !== undefined) out.push("rehacer");
  return out;
}

/** Las decisiones de la etapa actual que tiene sentido ofrecer según el estado del run. */
export function decisionsFor(run: Run): Decision["accion"][] {
  switch (run.status) {
    case "esperando_aprobacion":
      return ["aprobar", "cambios"];
    case "detenido":
      return stoppedDecisions(run);
    case "pausado_por_limite":
      return ["reanudar"];
    // Aprender corre en el chequeo cada 10 minutos; con la PR recién mergeada, no hace falta esperarlo.
    case "entregado":
      return ["aprender"];
    default:
      return [];
  }
}

/** La versión del plan de un run: cambia cada vez que planificar vuelve a correr. */
export const planVersion = (run: Run): string =>
  `${run.id}#${String(run.fases.find((p) => p.fase === "planificar")?.sesiones.length ?? 0)}`;

/**
 * La fase desde la que la detención ofrece rehacer: `rerun <id> --desde verificar`, en sus opciones o,
 * con un flowrunner anterior, en `siguiente`.
 */
export function rerunPhase(run: Run): PhaseName | undefined {
  const commands = run.opciones?.map((o) => o.comando) ?? [run.siguiente ?? ""];
  for (const comando of commands) {
    const desde = /--desde (\w+)/.exec(comando)?.[1];
    const phase = PHASES.find((p) => p === desde);
    if (phase !== undefined) return phase;
  }
  return undefined;
}

// --- Lo que se abre en una pestaña ---------------------------------------------------------

/** Orca rechaza un dibujo con un texto de más de 16 KiB, en bytes: 4000 caracteres entran aun en UTF-8 ancho. */
export const MAX_TEXT_CHARS = 4_000;

/** El final de un texto largo, para que entre en lo que Orca dibuja. */
export const tail = (text: string, max = MAX_TEXT_CHARS) =>
  text.length > max ? `…${text.slice(-max)}` : text;

/** Un nombre de sesión de flowrunner: `planificar-1`, `implementar-ST-2-1`. */
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Los pasos de una sesión como Markdown, para abrirlos en una pestaña. */
export function stepsMarkdown(clave: string, sesion: string, texto: string): string {
  return `# ${clave} · pasos de ${sesion}\n\n\`\`\`text\n${texto.trim() || "(sin pasos todavía)"}\n\`\`\`\n`;
}

const CHANGE_LABELS: Record<string, string> = {
  subtareas_agregadas: "Sub-tasks nuevas",
  subtareas_quitadas: "Sub-tasks que ya no están",
  alcance_agregado: "Alcance nuevo",
  alcance_quitado: "Alcance que ya no está",
  tests_agregados: "Tests nuevos",
  tests_quitados: "Tests que ya no están",
};

/** La salida de `flowrunner plan --json` como Markdown, para abrirla en una pestaña. */
export function planMarkdown(clave: string, data: unknown): string {
  const d = data as {
    plan?: string;
    subtareas?: { id: string; titulo: string; alcance?: string[]; depende_de?: string[] }[];
    criterios?: { id: string; comando: string; subtarea: string }[];
    cambios?: Record<string, string[]> | null;
    cambia_lo_existente?: ExistingChange[];
    se_pisa_con?: { run: string; status: string; pr: number | null; archivos: string[] }[];
  };
  const existing = (d.cambia_lo_existente ?? []).map((c) => `- ${describeExisting(c)}`);
  const overlaps = (d.se_pisa_con ?? []).map(
    (p) =>
      `- **${p.run}** (${p.status}${p.pr === null ? "" : `, PR #${String(p.pr)}`}): \`${p.archivos.join("`, `")}\``,
  );
  const tasks = (d.subtareas ?? []).map(
    (t) =>
      `- **${t.id}** ${t.titulo}${t.alcance === undefined || t.alcance.length === 0 ? "" : ` — \`${t.alcance.join("`, `")}\``}${t.depende_de === undefined || t.depende_de.length === 0 ? "" : ` · depende de ${t.depende_de.join(", ")}`}`,
  );
  const criteria = (d.criterios ?? []).map(
    // El criterio de verify es del run (CRITERIO_DEL_RUN en src/gates/plan.ts): Orca no importa de src/.
    (c) =>
      `- **${c.id}** → ${c.subtarea === "run" ? "del run (lo comprueba verificar)" : c.subtarea}: \`${c.comando}\``,
  );
  const changes = Object.entries(d.cambios ?? {})
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => `- ${CHANGE_LABELS[key] ?? key}: ${items.join(", ")}`);
  return [
    `# ${clave} · plan`,
    "",
    ...(existing.length === 0
      ? []
      : [
          `## ⚠ Cambia lo que ya existe (${String(existing.length)})`,
          "",
          "Aprobar el plan es aceptar estos cambios. Si alguno no va, pedí cambios.",
          "",
          ...existing,
          "",
        ]),
    ...(overlaps.length === 0
      ? []
      : [
          `## ⚠ Se pisa con otros runs del proyecto (${String(overlaps.length)})`,
          "",
          "No bloquea: aprobá igual, esperá a que el otro se mergee o abortá uno.",
          "",
          ...overlaps,
          "",
        ]),
    ...(changes.length === 0 ? [] : ["## Contra el plan anterior", "", ...changes, ""]),
    "## Sub-tasks",
    "",
    ...tasks,
    "",
    "## Criterios",
    "",
    ...criteria,
    "",
    "---",
    "",
    (d.plan ?? "").trim(),
    "",
  ].join("\n");
}
