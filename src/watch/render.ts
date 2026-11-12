// La vista de `flowrunner watch`, con el estilo de agents-tree: una cabecera con el resumen y las
// columnas, los proyectos como grupos, y por run sus fases y sub-tasks como árbol, con modelo, tokens,
// USD aproximados, tiempo y estado. Ninguna línea pasa el ancho de la terminal.
import type { Step } from "../report/transcript.ts";
import type { Paso, PasoEtapa, Vuelta } from "./recorrido.ts";
import type { PhaseNode, RunTree, SessionNode, UnitNode } from "./tree.ts";

const MAX_LABEL = 70;
const MIN_LABEL = 16;
const MAX_MODEL = 28;
const BAR = 8;
/** La barra, un espacio y la cantidad de tokens: `━━━─────  738k`. */
const TOKENS_W = BAR + 6;
const SELECTED = "30;46";

/** La clase de cada fila, con el ícono y el color de agents-tree. */
type Kind =
  | "blocked"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "back"
  | "pending"
  | "inactive"
  | "you"
  | "auto";
const KIND: Record<Kind, { icon: string; code: string }> = {
  blocked: { icon: "▲", code: "1;35" },
  running: { icon: "●", code: "1;33" },
  waiting: { icon: "○", code: "36" },
  done: { icon: "✓", code: "32" },
  failed: { icon: "✗", code: "31" },
  back: { icon: "↺", code: "33" },
  pending: { icon: "·", code: "90" },
  inactive: { icon: "–", code: "90" },
  you: { icon: "◆", code: "1;34" },
  auto: { icon: "·", code: "90" },
};

/** Texto en una línea y sin caracteres de control: lo que escribe un modelo no maneja la terminal. */
// eslint-disable-next-line no-control-regex
const oneLine = (text: string) => text.replace(/ *[\x00-\x1f\x7f]+ */g, " ");
const len = (text: string) => Array.from(text).length;
const cut = (text: string, width: number) => {
  const chars = Array.from(oneLine(text));
  return chars.length <= width
    ? chars.join("")
    : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
};
const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - len(text)));
const padStart = (text: string, width: number) => " ".repeat(Math.max(0, width - len(text))) + text;

function style(color: boolean, code: string, text: string): string {
  return color && text !== "" ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) {
    return `${String(Math.floor(s / 3600))}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  return `${String(Math.floor(s / 86400))}d${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}h`;
}

export function tokenCount(n: number): string {
  if (n === 0) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`;
  return n % 1_000_000 === 0 ? `${String(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`;
}

const usd = (n: number | undefined, partial = false) =>
  n === undefined || n === 0 ? "–" : `${partial ? "≥ " : ""}${n.toFixed(2)}`;

/** `claude-opus-5-5` y `high` como `opus-5-5 (high)`. */
export function modelTag(id: string | undefined, effort?: string): string {
  if (id === undefined) return "–";
  return `${id.replace(/^claude-/, "")}${effort === undefined ? "" : ` (${effort})`}`;
}

const RUN: Record<RunTree["status"], { kind: Kind; text: string; urgency: number }> = {
  esperando_aprobacion: { kind: "blocked", text: "te espera", urgency: 0 },
  detenido: { kind: "failed", text: "detenido", urgency: 1 },
  en_curso: { kind: "running", text: "en curso", urgency: 2 },
  en_cola: { kind: "waiting", text: "en cola", urgency: 3 },
  pausado_por_limite: { kind: "waiting", text: "en pausa", urgency: 3 },
  pausado: { kind: "waiting", text: "pausado", urgency: 3 },
  entregado: { kind: "waiting", text: "PR abierta", urgency: 4 },
  cerrado: { kind: "done", text: "cerrado", urgency: 5 },
  abortado: { kind: "inactive", text: "abortado", urgency: 6 },
};

/** Una fila: el árbol, el nombre y los números de sus sesiones, más una nota opcional debajo. */
interface Row {
  readonly key: string | undefined;
  readonly run: string;
  readonly sessions: readonly string[];
  readonly prefix: string;
  /** Lo que sigue al prefijo para la nota de abajo: la columna del árbol que continúa. */
  readonly stem: string;
  readonly kind: Kind;
  readonly label: string;
  readonly id: string;
  readonly model: string;
  readonly tokens: number;
  /** Qué parte de los tokens del run se llevó, de 0 a 1; undefined en la fila del run. */
  readonly share: number | undefined;
  readonly usd: number | undefined;
  /** El costo incluye una sesión que corre: es un mínimo, la salida se conoce al terminar. */
  readonly partial: boolean;
  readonly time: string;
  readonly status: string;
  readonly note: string | undefined;
  /** Tiene hijos: si están a la vista. */
  readonly abierto?: boolean | undefined;
  /** La fila de la que cuelga, para que `←` suba a ella. */
  readonly parent?: string | undefined;
}

/** Lo que se elige con las flechas: una fila con sesiones, y los nombres de esas sesiones. */
export interface Selectable {
  readonly key: string;
  readonly run: string;
  readonly sessions: readonly string[];
  /** Lo que dice la fila, para el título del detalle. */
  readonly titulo: string;
  /** Tiene hijos y se pliega: si están a la vista. Sin valor, es una sesión: Enter ve sus pasos. */
  readonly abierto?: boolean | undefined;
  readonly parent?: string | undefined;
}

export interface BoardOptions {
  readonly width: number;
  readonly color: boolean;
  readonly selected?: string | undefined;
  /** Lo que la persona abrió o plegó, por clave; lo demás sigue lo que dice el recorrido. */
  readonly abiertos?: ReadonlyMap<string, boolean>;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const tags = (ss: readonly SessionNode[]) =>
  [
    ...new Set(ss.flatMap((s) => (s.modelo === undefined ? [] : [modelTag(s.modelo, s.esfuerzo)]))),
  ].join(", ");
/** El contexto que arrastra una sesión en cada vuelta: `174k de 1M`, o solo los tokens. */
const contextText = (s: SessionNode) =>
  `contexto ${tokenCount(s.contexto)}${s.ventana === undefined ? "" : ` de ${tokenCount(s.ventana)}`}`;

/** Lo que hace la sesión que corre y cuánto contexto arrastra. */
const toolNote = (ss: readonly SessionNode[]) => {
  const now = ss.find((s) => s.corriendo);
  if (now === undefined) return undefined;
  const parts = [
    ...(now.ultimo === undefined ? [] : [`▸ ${now.ultimo}`]),
    ...(now.contexto > 0 ? [contextText(now)] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
};

/** Lo que todavía no tiene costo real: la estimación de las sesiones que corren. */
const runningCost = (ss: readonly SessionNode[]) =>
  sum(ss.filter((s) => s.corriendo).map((s) => s.costoEstimado ?? 0));
const times = (ss: readonly SessionNode[]) => (ss.length > 1 ? ` ×${String(ss.length)}` : "");

function phaseRow(
  p: PhaseNode,
  prMergeada: boolean,
): { kind: Kind; status: string; note: string | undefined } {
  switch (p.estado) {
    case "pendiente":
      return { kind: "pending", status: "pendiente", note: undefined };
    case "corriendo":
      return { kind: "running", status: "trabajando", note: toolNote(p.sesiones) };
    case "cortada":
      return { kind: "inactive", status: "cortada", note: undefined };
    case "salteada":
      return { kind: "inactive", status: "salteada", note: p.detalle };
    case "ok": {
      const status =
        p.fase === "aprobar" ? "aprobado" : p.fase === "entregar" ? "PR creada" : "listo";
      return { kind: "done", status, note: p.nota };
    }
    case "espera":
      return p.fase === "aprobar"
        ? { kind: "blocked", status: "te espera", note: undefined }
        : prMergeada
          ? { kind: "waiting", status: "aprende al próximo chequeo", note: undefined }
          : { kind: "waiting", status: "espera merge", note: undefined };
    case "vuelve":
      return { kind: "back", status: "volvió", note: p.detalle };
    case "falla":
      return { kind: "failed", status: "falló", note: p.detalle };
    case "pausa":
      return { kind: "waiting", status: "en pausa", note: "límite de la suscripción" };
  }
}

function unitRow(
  u: UnitNode,
  all: readonly UnitNode[],
): { kind: Kind; status: string; note: string | undefined } {
  switch (u.estado) {
    case "corriendo":
      return { kind: "running", status: "trabajando", note: toolNote(u.sesiones) };
    case "cortada":
      return { kind: "inactive", status: "cortada", note: undefined };
    case "integrada":
    case "commiteada":
      return { kind: "done", status: u.estado, note: undefined };
    case "fallida":
      return { kind: "failed", status: "falló", note: undefined };
    case "sin_cambios":
      return { kind: "done", status: "sin cambios", note: undefined };
    case "pendiente": {
      const waiting = u.dependeDe.filter(
        (d) => all.find((x) => x.id === d)?.estado !== "integrada",
      );
      return {
        kind: "pending",
        status: waiting.length > 0 ? `espera ${waiting.join(", ")}` : "pendiente",
        note: undefined,
      };
    }
  }
}

/** La fila del run: su título, sus tokens y su costo, cuánto lleva y en qué está. */
function runHeader(tree: RunTree, all: readonly SessionNode[]): Row {
  const run = RUN[tree.status];
  return {
    key: undefined,
    run: tree.id,
    sessions: [],
    prefix: " ",
    stem: " ",
    kind: run.kind,
    label: tree.titulo === "" ? tree.clave : tree.titulo,
    id: tree.clave,
    model: "",
    tokens: sum(all.map((s) => s.tokens)),
    share: undefined,
    usd: tree.costoUsd + runningCost(all),
    partial: all.some((s) => s.corriendo),
    time:
      tree.haceSegundos === undefined
        ? duration(tree.segundos)
        : `hace ${duration(tree.haceSegundos)}`,
    status:
      tree.status === "entregado" && tree.prMergeada
        ? "PR mergeada"
        : tree.status === "en_curso" && tree.pausaPedida
          ? "se pausa al terminar"
          : run.text,
    note: runNote(tree),
  };
}

/** Las filas de un run: su recorrido, o sus fases si el árbol no trae recorrido. */
function runRows(tree: RunTree, abiertos: ReadonlyMap<string, boolean>): Row[] {
  return tree.recorrido.length === 0 ? phaseRows(tree) : timelineRows(tree, abiertos);
}

function phaseRows(tree: RunTree): Row[] {
  const all = tree.fases.flatMap((p) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)]);
  const total = sum(all.map((s) => s.tokens));
  const share = (n: number) => (total === 0 ? 0 : n / total);
  const rows: Row[] = [runHeader(tree, all)];
  tree.fases.forEach((p, i) => {
    const last = i === tree.fases.length - 1;
    const own = [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)];
    const tokens = sum(own.map((s) => s.tokens));
    const progress =
      p.fase === "implementar" && p.unidades.length > 0
        ? ` ${String(p.unidades.filter((u) => u.estado === "integrada").length)}/${String(p.unidades.length)}`
        : "";
    rows.push({
      key: p.sesiones.length > 0 ? `${tree.id}:${p.fase}` : undefined,
      run: tree.id,
      sessions: p.sesiones.map((s) => s.nombre),
      prefix: `   ${last ? "└─ " : "├─ "}`,
      stem: `   ${last ? "   " : "│  "}`,
      ...phaseRow(p, tree.prMergeada),
      label: `${p.fase}${progress}${times(p.sesiones)}`,
      id: "",
      model: tags(own),
      tokens,
      share: share(tokens),
      usd: p.costoUsd + runningCost(own),
      partial: own.some((s) => s.corriendo),
      time: p.segundos === undefined ? "" : duration(p.segundos),
    });
    p.unidades.forEach((u, j) => {
      const lastUnit = j === p.unidades.length - 1;
      const stem = `   ${last ? "   " : "│  "}`;
      const unitTokens = sum(u.sesiones.map((s) => s.tokens));
      const done = u.sesiones.filter((s) => s.costoUsd !== undefined);
      rows.push({
        key: u.sesiones.length > 0 ? `${tree.id}:${u.id}` : undefined,
        run: tree.id,
        sessions: u.sesiones.map((s) => s.nombre),
        prefix: `${stem}${lastUnit ? "└─ " : "├─ "}`,
        stem: `${stem}${lastUnit ? "   " : "│  "}`,
        ...unitRow(u, p.unidades),
        label: `${u.id} ${u.titulo}${times(u.sesiones)}`,
        id: "",
        model: tags(u.sesiones),
        tokens: unitTokens,
        share: share(unitTokens),
        usd:
          u.sesiones.length === 0
            ? undefined
            : sum(done.map((s) => s.costoUsd ?? 0)) + runningCost(u.sesiones),
        partial: u.sesiones.some((s) => s.corriendo),
        time: u.sesiones.length === 0 ? "" : duration(sum(u.sesiones.map((s) => s.segundos))),
      });
    });
  });
  return rows;
}

/** `11:12`: la hora local en que pasó algo. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Las sesiones de una corrida, con las de sus sub-tasks. */
const sessionsOf = (p: PasoEtapa) => [...p.sesiones, ...p.subtareas.flatMap((u) => u.sesiones)];

/** Un run plegado, entregado o cerrado no te necesita: arranca plegado, como su tarjeta en Orca. */
const runOpenByDefault = (tree: RunTree) =>
  !["entregado", "cerrado", "abortado"].includes(tree.status);

/** A quién devolvió y por qué, para la nota de una corrida en rojo. */
const redNote = (p: PasoEtapa) =>
  [p.unidades.length > 0 ? `→ ${p.unidades.join(", ")}` : undefined, p.motivo]
    .filter((x) => x !== undefined)
    .join(" · ");

function etapaRow(
  p: PasoEtapa,
  prMergeada: boolean,
): { kind: Kind; status: string; note: string | undefined } {
  switch (p.resultado) {
    case "ok": {
      const status =
        p.fase === "aprobar"
          ? "aprobado"
          : p.fase === "entregar"
            ? p.pr === undefined
              ? "PR creada"
              : `PR #${String(p.pr)}`
            : "listo";
      return { kind: "done", status, note: undefined };
    }
    case "salteada":
      return { kind: "inactive", status: "salteada", note: p.motivo };
    case "vuelve":
      return { kind: "back", status: "volvió", note: redNote(p) };
    case "falla":
      return { kind: "failed", status: "falló", note: redNote(p) };
    case "pregunta":
      return { kind: "failed", status: "se detuvo", note: redNote(p) };
    case "pausa":
      return { kind: "waiting", status: "en pausa", note: "límite de la suscripción" };
    case "espera":
      return p.fase === "aprobar"
        ? { kind: "blocked", status: "te espera", note: undefined }
        : prMergeada
          ? { kind: "waiting", status: "aprende al próximo chequeo", note: undefined }
          : { kind: "waiting", status: "espera merge", note: undefined };
    case "corriendo":
      return { kind: "running", status: "trabajando", note: toolNote(sessionsOf(p)) };
    case "cortada":
      return { kind: "inactive", status: "cortada", note: undefined };
  }
}

const VERBO: Record<Vuelta["resultado"], string> = {
  vuelve: "volvió",
  falla: "falló",
  pregunta: "se detuvo",
};

/** Una vuelta en una línea: `verificar volvió 2 veces → ST-1 · 5 pasos`. */
export const vueltaLabel = (v: Vuelta) =>
  `${v.fase} ${VERBO[v.resultado]}${v.veces > 1 ? ` ${String(v.veces)} veces` : ""}${v.unidades.length > 0 ? ` → ${v.unidades.join(", ")}` : ""} · ${String(v.pasos)} pasos`;

/** Lo de primer nivel del recorrido: un paso, o una vuelta con los pasos que caen adentro. */
type Nodo = { readonly paso: Paso } | { readonly vuelta: Vuelta; readonly pasos: Paso[] };

function nodosOf(tree: RunTree): Nodo[] {
  const nodos: Nodo[] = [];
  for (const p of tree.recorrido) {
    const n = p.tipo === "pendiente" ? undefined : p.vuelta;
    const prev = nodos.at(-1);
    const vuelta = tree.vueltas.find((v) => v.numero === n);
    if (vuelta === undefined) nodos.push({ paso: p });
    else if (prev !== undefined && "vuelta" in prev && prev.vuelta.numero === n) prev.pasos.push(p);
    else nodos.push({ vuelta, pasos: [p] });
  }
  return nodos;
}

/** Plegado, un nodo con hijos dice `▸`; abierto, `▾`. */
const mark = (abierto: boolean | undefined) => (abierto === undefined ? "" : abierto ? " ▾" : " ▸");

/** El recorrido de un run como árbol: cada paso con su hora, y las vueltas marcadas con `┃`. */
function timelineRows(tree: RunTree, abiertos: ReadonlyMap<string, boolean>): Row[] {
  const all = tree.recorrido.flatMap((p) => (p.tipo === "etapa" ? sessionsOf(p) : []));
  const total = sum(all.map((s) => s.tokens));
  const share = (n: number) => (total === 0 ? 0 : n / total);
  const open = (key: string, byDefault: boolean) => abiertos.get(key) ?? byDefault;
  const base = { run: tree.id, id: "", model: "", sessions: [] as string[] };
  const rows: Row[] = [];

  const header = runHeader(tree, all);
  const runOpen = open(tree.id, runOpenByDefault(tree));
  rows.push({ ...header, key: tree.id, abierto: runOpen, label: header.label + mark(runOpen) });

  const branch = (stem: string, last: boolean) => `${stem}${last ? "└─ " : "├─ "}`;
  const trunk = (stem: string, last: boolean) => `${stem}${last ? "   " : "│  "}`;
  /** Una sesión: una hoja, que con Enter muestra sus pasos. */
  const sessionRow = (s: SessionNode, stem: string, last: boolean, parent: string): Row => ({
    ...base,
    key: `${tree.id}:s/${s.nombre}`,
    parent,
    sessions: [s.nombre],
    prefix: branch(stem, last),
    stem: trunk(stem, last),
    kind: s.corriendo ? "running" : "done",
    label: s.nombre,
    model: modelTag(s.modelo, s.esfuerzo),
    tokens: s.tokens,
    share: share(s.tokens),
    usd: s.costoUsd ?? (s.corriendo ? (s.costoEstimado ?? 0) : undefined),
    partial: s.corriendo,
    time: duration(s.segundos),
    status: s.corriendo ? "trabajando" : "listo",
    note: toolNote([s]),
  });

  const emit = (p: Paso, prefix: string, stem: string, parent: string) => {
    if (p.tipo === "pendiente") {
      const status =
        tree.status === "entregado"
          ? tree.prMergeada
            ? "aprende al próximo chequeo"
            : "espera merge"
          : "pendiente";
      rows.push({
        ...base,
        key: undefined,
        prefix,
        stem,
        // Entregado, aprender no está pendiente: espera tu merge.
        kind: tree.status === "entregado" ? "waiting" : "pending",
        label: p.fases.join(" · "),
        tokens: 0,
        share: undefined,
        usd: undefined,
        partial: false,
        time: "",
        status,
        note: undefined,
      });
      return;
    }
    if (p.tipo !== "etapa") {
      // Un sha va en la línea; un motivo o una instrucción, debajo.
      const detalle = p.tipo === "tuyo" ? p.detalle : undefined;
      const inline = p.tipo === "tuyo" && p.que === "arreglaste a mano" && detalle !== undefined;
      rows.push({
        ...base,
        key: undefined,
        prefix,
        stem,
        kind: p.tipo === "tuyo" ? "you" : "auto",
        label: `${hhmm(p.at)} ${p.que}${inline ? ` (${detalle})` : ""}`,
        tokens: 0,
        share: undefined,
        usd: undefined,
        partial: false,
        time: "",
        status: "",
        note: inline ? undefined : detalle,
      });
      return;
    }
    const ss = sessionsOf(p);
    const tokens = sum(ss.map((s) => s.tokens));
    const key = `${tree.id}:${p.clave}`;
    const kids = p.fase === "implementar" ? p.subtareas : p.sesiones;
    const abierto = kids.length === 0 ? undefined : open(key, p.abierto);
    const progress =
      p.subtareas.length > 0
        ? ` ${String(p.subtareas.filter((u) => u.estado === "integrada").length)}/${String(p.subtareas.length)}`
        : "";
    rows.push({
      ...base,
      key: abierto === undefined ? undefined : key,
      parent,
      abierto,
      prefix,
      stem,
      ...etapaRow(p, tree.prMergeada),
      label: `${hhmm(p.inicio)} ${p.fase}${progress}${p.chequeos > 1 ? ` · ${String(p.chequeos)} chequeos` : ""}${mark(abierto)}`,
      model: tags(ss),
      tokens,
      share: share(tokens),
      usd: p.costoUsd + runningCost(ss),
      partial: ss.some((s) => s.corriendo),
      time: p.segundos === undefined ? "" : duration(p.segundos),
    });
    if (abierto !== true) return;
    if (p.fase !== "implementar") {
      p.sesiones.forEach((s, j) =>
        rows.push(sessionRow(s, stem, j === p.sesiones.length - 1, key)),
      );
      return;
    }
    p.subtareas.forEach((u, j) => {
      const last = j === p.subtareas.length - 1;
      const uKey = `${key}/${u.id}`;
      const uOpen = u.sesiones.length === 0 ? undefined : open(uKey, u.estado === "corriendo");
      const uTokens = sum(u.sesiones.map((s) => s.tokens));
      const done = u.sesiones.filter((s) => s.costoUsd !== undefined);
      rows.push({
        ...base,
        key: uOpen === undefined ? undefined : uKey,
        parent: key,
        abierto: uOpen,
        prefix: branch(stem, last),
        stem: trunk(stem, last),
        ...unitRow(u, p.subtareas),
        label: `${u.id} ${u.titulo}${times(u.sesiones)}${mark(uOpen)}`,
        model: tags(u.sesiones),
        tokens: uTokens,
        share: share(uTokens),
        usd: sum(done.map((s) => s.costoUsd ?? 0)) + runningCost(u.sesiones),
        partial: u.sesiones.some((s) => s.corriendo),
        time: u.sesiones.length === 0 ? "" : duration(sum(u.sesiones.map((s) => s.segundos))),
      });
      if (uOpen === true) {
        u.sesiones.forEach((s, k) =>
          rows.push(sessionRow(s, trunk(stem, last), k === u.sesiones.length - 1, uKey)),
        );
      }
    });
  };

  const nodos = nodosOf(tree);
  // Plegado, el run muestra dónde quedó: su último paso, o la vuelta en la que está.
  const shown = runOpen
    ? nodos
    : nodos.filter((n) => !("paso" in n && n.paso.tipo === "pendiente")).slice(-1);
  shown.forEach((n, i) => {
    const last = i === shown.length - 1;
    const prefix = branch("   ", last);
    const stem = trunk("   ", last);
    if ("paso" in n) {
      emit(n.paso, prefix, stem, tree.id);
      return;
    }
    const v = n.vuelta;
    const key = `${tree.id}:v${String(v.numero)}`;
    const abierto = open(key, v.abierto);
    const ss = n.pasos.flatMap((p) => (p.tipo === "etapa" ? sessionsOf(p) : []));
    const tokens = sum(ss.map((s) => s.tokens));
    rows.push({
      ...base,
      key,
      parent: tree.id,
      abierto,
      prefix,
      stem,
      kind: "back",
      label: `${vueltaLabel(v)}${mark(abierto)}`,
      model: tags(ss),
      tokens,
      share: share(tokens),
      usd: v.costoUsd + runningCost(ss),
      partial: ss.some((s) => s.corriendo),
      time: duration(v.segundos),
      status: v.abierta ? "abierta" : "resuelta",
      note: undefined,
    });
    if (abierto) for (const p of n.pasos) emit(p, `${stem}┃  `, `${stem}┃  `, key);
  });
  return rows;
}

/** Una barra fina de `BAR` celdas y los tokens, coloreada por la parte del run que se llevó. */
function tokensCell(row: Row, color: boolean): string {
  const amount = padStart(tokenCount(row.tokens), 5);
  if (row.share === undefined) return padStart(amount, TOKENS_W);
  if (row.tokens === 0) return style(color, "90", padStart(amount, TOKENS_W));
  const filled = Math.max(1, Math.min(BAR, Math.round(row.share * BAR)));
  const code = row.share < 0.3 ? "32" : row.share < 0.6 ? "33" : "31";
  return (
    style(color, code, "━".repeat(filled)) +
    style(color, "90", "─".repeat(BAR - filled)) +
    " " +
    style(color, code, amount)
  );
}

function summaryOf(trees: readonly RunTree[]): string {
  const counts = new Map<RunTree["status"], number>();
  for (const t of trees) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => RUN[a].urgency - RUN[b].urgency)
    .map(([status, n]) => `${KIND[RUN[status].kind].icon} ${String(n)} ${RUN[status].text}`)
    .join("  ");
}

/**
 * La nota de un run: con una pregunta, la primera respuesta y cuántas más hay (ADR 0023); si no, el
 * motivo o el comando para seguir.
 */
function runNote(tree: RunTree): string | undefined {
  const [first, ...rest] = tree.opciones ?? [];
  if (first !== undefined) {
    const more =
      rest.length === 0 ? "" : ` (+${String(rest.length)} opciones: flowrunner status ${tree.id})`;
    return `para seguir: ${first.comando}${more}`;
  }
  return (
    tree.motivo ?? (tree.siguiente === undefined ? undefined : `para seguir: ${tree.siguiente}`)
  );
}

export function renderBoard(
  trees: readonly RunTree[],
  opts: BoardOptions,
): { lines: string[]; selectable: Selectable[] } {
  const { width, color } = opts;
  if (trees.length === 0) return { lines: ["no hay runs activos"], selectable: [] };
  // Los que te necesitan primero; dentro de cada urgencia, los más nuevos.
  const ordered = [...trees].sort(
    (a, b) => RUN[a.status].urgency - RUN[b.status].urgency || b.id.localeCompare(a.id),
  );
  const projects = [...new Set(ordered.map((t) => t.proyecto))];
  const groups = projects.map((p) => ({
    project: p,
    rows: ordered
      .filter((t) => t.proyecto === p)
      .flatMap((t) => runRows(t, opts.abiertos ?? new Map())),
  }));
  const rows = groups.flatMap((g) => g.rows);

  const models = new Set(rows.filter((r) => r.model !== "").map((r) => r.model));
  let showModel = models.size > 1;
  const summary =
    summaryOf(trees) + (showModel || models.size === 0 ? "" : `  · ${[...models][0] ?? ""}`);
  const idW = Math.max(8, ...rows.map((r) => len(r.id)));
  const modelW = Math.min(
    Math.max(len("MODELO (ESFUERZO)"), ...rows.map((r) => len(r.model))),
    MAX_MODEL,
  );
  const usdW = Math.max(len("≈ USD"), ...rows.map((r) => len(usd(r.usd, r.partial))));
  const timeW = Math.max(len("TIEMPO"), ...rows.map((r) => len(r.time)));
  const statusW = Math.max(len("ESTADO"), ...rows.map((r) => len(r.status)));
  let columnsW = idW + TOKENS_W + usdW + timeW + statusW + 5 * 2;
  let labelW = Math.min(
    Math.max(len(summary), ...rows.map((r) => len(r.prefix) + 2 + len(r.label))),
    MAX_LABEL,
  );
  // Con poco lugar, los nombres importan más que los modelos: el detalle los sigue mostrando.
  if (showModel && labelW + modelW + 2 + columnsW > width) showModel = false;
  if (showModel) columnsW += modelW + 2;
  labelW = Math.max(Math.min(labelW, width - columnsW - 2), MIN_LABEL);

  const line = (r: Row, colored: boolean) => {
    const k = KIND[r.kind];
    const room = Math.max(labelW - len(r.prefix) - 2, 4);
    const label = cut(r.label, room);
    const bold = r.kind === "blocked" || r.kind === "running" ? style(colored, "1", label) : label;
    const dim = r.kind === "pending" || r.kind === "auto" ? style(colored, "90", label) : bold;
    const cells = [
      `${r.prefix.replaceAll("┃", style(colored, "33", "┃"))}${style(colored, k.code, k.icon)} ${dim}${" ".repeat(room - len(label))}`,
      style(colored, "90", padEnd(r.id, idW)),
      ...(showModel ? [padEnd(cut(r.model, modelW), modelW)] : []),
      // Tus pasos y el autofix no gastan: sin números, no un «–» que parezca un costo.
      ...(r.kind === "you" || r.kind === "auto"
        ? [" ".repeat(TOKENS_W), " ".repeat(usdW)]
        : [tokensCell(r, colored), padStart(usd(r.usd, r.partial), usdW)]),
      padStart(r.time, timeW),
      style(colored, k.code, padEnd(r.status, statusW)),
    ];
    return cells.join("  ");
  };

  const head = [
    padEnd(cut(summary, labelW), labelW),
    padEnd("ID", idW),
    ...(showModel ? [padEnd("MODELO (ESFUERZO)", modelW)] : []),
    padEnd("TOKENS", TOKENS_W),
    padStart("≈ USD", usdW),
    padStart("TIEMPO", timeW),
    "ESTADO",
  ].join("  ");
  // En video inverso la cabecera ocupa todo el ancho, como en agents-tree; sin color, sin relleno.
  const out = [
    color ? style(color, "7", padEnd(cut(head, width), width)) : cut(head, width).trimEnd(),
  ];
  const selectable: Selectable[] = [];

  for (const g of groups) {
    out.push(style(color, "1;34", cut(g.project, width)));
    for (const r of g.rows) {
      if (r.key !== undefined) {
        selectable.push({
          key: r.key,
          run: r.run,
          sessions: r.sessions,
          titulo: r.label,
          abierto: r.abierto,
          parent: r.parent,
        });
      }
      if (r.key !== undefined && r.key === opts.selected) {
        out.push(style(color, SELECTED, padEnd(cut(line(r, false), width), width)));
      } else {
        out.push(fitColored(line(r, color), width).trimEnd());
      }
      if (r.note !== undefined) {
        const indent = `${r.stem}  `;
        out.push(style(color, "90", cut(`${indent}${r.note}`, width)));
      }
    }
  }
  return { lines: out, selectable };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Corta una línea con color a `width` columnas visibles sin partir sus códigos. */
function fitColored(text: string, width: number): string {
  if (len(text.replace(ANSI, "")) <= width) return text;
  let left = width - 1;
  let out = "";
  // eslint-disable-next-line no-control-regex
  for (const piece of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (piece.startsWith("\x1b[")) {
      out += piece;
      continue;
    }
    const chars = Array.from(piece);
    out += chars.slice(0, Math.max(0, left)).join("");
    left -= chars.length;
    if (left <= 0) break;
  }
  return `${out}…\x1b[0m`;
}

const STEP_MARK = { texto: "·", herramienta: "▸", resultado: "←", final: "■" } as const;

/** El detalle de una fila: cada sesión con su cabecera y los últimos pasos que entran en `height`. */
export function renderDetail(
  title: string,
  sessions: readonly { node: SessionNode; steps: readonly Step[] }[],
  opts: { width: number; height: number; color: boolean },
): string[] {
  const { width, color } = opts;
  const body = sessions.flatMap(({ node: s, steps }) => [
    cut(
      `${s.nombre} · ${modelTag(s.modelo, s.esfuerzo)} · ${tokenCount(s.tokens)} tokens nuevos · ${contextText(s)} · ≈ USD ${usd(s.costoUsd ?? s.costoEstimado, s.costoUsd === undefined)} · ${duration(s.segundos)}`,
      width,
    ),
    ...steps.map((st) => {
      const text = cut(`  ${STEP_MARK[st.tipo]} ${st.texto}`, width);
      return st.tipo === "herramienta"
        ? style(color, "36", text)
        : st.tipo === "texto"
          ? text
          : style(color, "90", text);
    }),
  ]);
  const room = Math.max(1, opts.height - 2);
  const shown = body.slice(-room);
  const hidden = body.length - shown.length;
  return [
    style(color, "1", cut(title, width)),
    hidden > 0 ? style(color, "90", `  … ${String(hidden)} líneas antes`) : "",
    ...shown,
  ];
}
