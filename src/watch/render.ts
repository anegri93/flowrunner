// El árbol de un run y el detalle de una sesión, como líneas de terminal que nunca pasan el ancho.
import type { Step } from "../report/transcript.ts";
import type { PhaseNode, PhaseState, RunTree, SessionNode, UnitNode, UnitState } from "./tree.ts";

/** Un pedazo de línea con su color ANSI, si tiene. */
type Part = readonly [text: string, color?: string | undefined];

const C = {
  dim: "90",
  green: "32",
  yellow: "33",
  red: "31",
  cyan: "36",
  bold: "1",
  invert: "7",
} as const;

export interface RenderOptions {
  readonly width: number;
  readonly color: boolean;
  /** El nombre de la sesión elegida, que se resalta. */
  readonly selected?: string | undefined;
}

/** Texto en una línea y sin caracteres de control: lo que escribe un modelo no maneja la terminal. */
// eslint-disable-next-line no-control-regex
const oneLine = (text: string) => text.replace(/ *[\x00-\x1f\x7f]+ */g, " ");

/** Corta las partes al ancho visible y les pone color. */
function fit(parts: readonly Part[], width: number, color: boolean, invert = false): string {
  let left = width;
  let out = "";
  for (const [text, code] of parts) {
    if (left <= 0) break;
    const chars = Array.from(oneLine(text));
    const piece =
      chars.length > left ? `${chars.slice(0, Math.max(0, left - 1)).join("")}…` : chars.join("");
    left -= Math.min(chars.length, left);
    out += color && code !== undefined ? `\x1b[${code}m${piece}\x1b[0m` : piece;
  }
  return color && invert ? `\x1b[${C.invert}m${out}\x1b[0m` : out;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

const usd = (n: number) => `USD ${n.toFixed(2)}`;

/** `claude-opus-5-5` como `Opus 5.5`. */
export function modelName(id: string): string {
  const [family = id, ...version] = id.replace(/^claude-/, "").split("-");
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
}

const PHASE_MARK: Record<PhaseState, Part> = {
  pendiente: ["○", C.dim],
  corriendo: ["●", C.cyan],
  ok: ["✓", C.green],
  espera: ["⏸", C.yellow],
  falla: ["✗", C.red],
  vuelve: ["↺", C.yellow],
  pausa: ["⏸", C.yellow],
};

const UNIT_MARK: Record<UnitState, Part> = {
  pendiente: ["○", C.dim],
  corriendo: ["●", C.cyan],
  commiteada: ["✓", C.green],
  integrada: ["✓", C.green],
  fallida: ["✗", C.red],
};

const STATUS: Record<RunTree["status"], Part> = {
  en_curso: ["en curso", C.cyan],
  esperando_aprobacion: ["esperando tu aprobación", C.yellow],
  entregado: ["PR abierta", C.green],
  cerrado: ["cerrado", C.dim],
  detenido: ["detenido", C.red],
  pausado_por_limite: ["pausado por el límite", C.yellow],
  abortado: ["abortado", C.dim],
};

const sep: Part = [" · ", C.dim];

function sessionParts(s: SessionNode): Part[] {
  const parts: Part[] = [[s.nombre]];
  if (s.modelo !== undefined) parts.push(["  "], [modelName(s.modelo), C.dim]);
  parts.push(sep, [`${String(s.pasos)} pasos`, C.dim]);
  if (s.costoUsd !== undefined) parts.push(sep, [usd(s.costoUsd), C.dim]);
  parts.push(sep, [duration(s.segundos), C.dim]);
  if (s.corriendo && s.ultimo !== undefined) parts.push(["  ▸ "], [s.ultimo, C.cyan]);
  return parts;
}

function phaseParts(p: PhaseNode, tree: RunTree): Part[] {
  const parts: Part[] = [
    PHASE_MARK[p.estado],
    [" "],
    [p.fase.padEnd(13), p.estado === "pendiente" ? C.dim : undefined],
  ];
  const info: Part[] = [];
  if (p.estado === "espera" && p.fase === "aprobar")
    info.push(["esperando tu aprobación", C.yellow]);
  else if (p.estado === "espera") info.push(["esperando el merge de la PR", C.yellow]);
  else if (p.detalle !== undefined) info.push([p.detalle, p.estado === "falla" ? C.red : C.yellow]);
  if (p.costoUsd > 0) info.push([usd(p.costoUsd), C.dim]);
  if (p.segundos !== undefined && p.estado !== "espera") info.push([duration(p.segundos), C.dim]);
  if (p.fase === "implementar" && p.unidades.length > 0) {
    const done = p.unidades.filter((u) => u.estado === "integrada").length;
    info.unshift([`${String(done)}/${String(p.unidades.length)} sub-tasks`, C.dim]);
  }
  if (p.estado === "pausa" && tree.status === "pausado_por_limite")
    info.unshift(["límite de la suscripción", C.yellow]);
  if (info.length === 0) return [PHASE_MARK[p.estado], [" "], [p.fase, C.dim]];
  info.forEach((part, i) => {
    if (i > 0) parts.push(sep);
    parts.push(part);
  });
  return parts;
}

function unitParts(u: UnitNode, all: readonly UnitNode[]): Part[] {
  const parts: Part[] = [UNIT_MARK[u.estado], [" "], [u.id.padEnd(6), C.bold], [u.titulo]];
  const waiting = u.dependeDe.filter((d) => all.find((x) => x.id === d)?.estado !== "integrada");
  if (u.estado === "pendiente" && waiting.length > 0)
    parts.push(["  espera a ", C.dim], [waiting.join(", "), C.dim]);
  return parts;
}

/** Las sesiones en el orden en que aparecen en el árbol: lo que se elige con las flechas. */
export function sessionOrder(tree: RunTree): string[] {
  return tree.fases.flatMap((p) => [
    ...p.sesiones.map((s) => s.nombre),
    ...p.unidades.flatMap((u) => u.sesiones.map((s) => s.nombre)),
  ]);
}

export function renderTree(tree: RunTree, opts: RenderOptions): string[] {
  const { width, color } = opts;
  const line = (parts: Part[], invert = false) => fit(parts, width, color, invert);
  const lines = [
    line([
      [tree.clave, C.bold],
      sep,
      [tree.titulo],
      sep,
      [tree.proyecto, C.dim],
      ["   "],
      STATUS[tree.status],
      sep,
      [`${usd(tree.costoUsd)} de ${String(tree.budgetUsd)}`, C.dim],
      sep,
      [duration(tree.segundos), C.dim],
    ]),
  ];
  const session = (prefix: string, s: SessionNode) => {
    const selected = s.nombre === opts.selected;
    lines.push(line([[selected ? "› " : "  "], [prefix, C.dim], ...sessionParts(s)], selected));
  };
  tree.fases.forEach((p, i) => {
    const last = i === tree.fases.length - 1;
    const stem = last ? "   " : "│  ";
    lines.push(line([["  "], [last ? "└─ " : "├─ ", C.dim], ...phaseParts(p, tree)]));
    p.sesiones.forEach((s, j) =>
      session(`${stem}${j === p.sesiones.length - 1 ? "└─ " : "├─ "}`, s),
    );
    p.unidades.forEach((u, j) => {
      const lastUnit = j === p.unidades.length - 1;
      lines.push(
        line([["  "], [`${stem}${lastUnit ? "└─ " : "├─ "}`, C.dim], ...unitParts(u, p.unidades)]),
      );
      u.sesiones.forEach((s, k) =>
        session(
          `${stem}${lastUnit ? "   " : "│  "}${k === u.sesiones.length - 1 ? "└─ " : "├─ "}`,
          s,
        ),
      );
    });
  });
  if (tree.motivo !== undefined) lines.push("", line([["  Motivo: ", C.red], [tree.motivo]]));
  if (tree.siguiente !== undefined)
    lines.push(
      "",
      line([
        ["  Para seguir: ", C.yellow],
        [tree.siguiente, C.bold],
      ]),
    );
  return lines;
}

const STEP_MARK = { texto: "·", herramienta: "▸", resultado: "←", final: "■" } as const;

/** El detalle de una sesión: su cabecera y los últimos pasos que entran en `height` líneas. */
export function renderSession(
  s: SessionNode,
  steps: readonly Step[],
  opts: { width: number; height: number; color: boolean },
): string[] {
  const { width, color } = opts;
  const head = fit([[s.nombre, C.bold], ["  "], ...sessionParts(s).slice(1)], width, color);
  const body = steps.flatMap((st) => {
    const text = st.texto.replace(/\s+/g, " ").trim();
    const code = st.tipo === "herramienta" ? C.cyan : st.tipo === "texto" ? undefined : C.dim;
    return [
      fit(
        [
          [`${STEP_MARK[st.tipo]} `, C.dim],
          [text, code],
        ],
        width,
        color,
      ),
    ];
  });
  const room = Math.max(1, opts.height - 2);
  const shown = body.slice(-room);
  const hidden = body.length - shown.length;
  return [
    head,
    hidden > 0 ? fit([[`  … ${String(hidden)} pasos antes`, C.dim]], width, color) : "",
    ...shown,
  ];
}
