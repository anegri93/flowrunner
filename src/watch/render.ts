// La vista de `flowrunner watch` como tabla: un resumen de los runs, y por proyecto cada run con sus
// fases y sub-tasks en filas, con modelo, tokens, USD aproximados, tiempo y estado en columnas. Ninguna
// línea pasa el ancho de la terminal.
import type { Step } from "../report/transcript.ts";
import type { PhaseNode, RunTree, SessionNode, UnitNode } from "./tree.ts";

/** Un pedazo de texto con su color ANSI, si tiene. */
type Part = readonly [text: string, color?: string | undefined];

const C = { dim: "90", green: "32", yellow: "33", red: "31", cyan: "36", bold: "1" } as const;

/** Texto en una línea y sin caracteres de control: lo que escribe un modelo no maneja la terminal. */
// eslint-disable-next-line no-control-regex
const oneLine = (text: string) => text.replace(/ *[\x00-\x1f\x7f]+ */g, " ");

const visible = (text: string) => Array.from(oneLine(text));

/** Corta las partes a `width` columnas visibles y, si se pide, completa con espacios. */
function cell(parts: readonly Part[], width: number, color: boolean, pad = false): string {
  let left = width;
  let out = "";
  for (const [text, code] of parts) {
    if (left <= 0) break;
    const chars = visible(text);
    const piece =
      chars.length > left ? `${chars.slice(0, Math.max(0, left - 1)).join("")}…` : chars.join("");
    left -= Math.min(chars.length, left);
    out += color && code !== undefined ? `\x1b[${code}m${piece}\x1b[0m` : piece;
  }
  return pad ? out + " ".repeat(left) : out;
}

const right = (text: string, width: number) => text.padStart(width).slice(-width);

export function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

export function tokenCount(n: number): string {
  if (n === 0) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const usd = (n: number | undefined) => (n === undefined || n === 0 ? "–" : n.toFixed(2));

/** `claude-opus-5-5` como `Opus 5.5`. */
export function modelName(id: string): string {
  const [family = id, ...version] = id.replace(/^claude-/, "").split("-");
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
}

const RUN_STATUS: Record<RunTree["status"], { mark: Part; text: string }> = {
  en_curso: { mark: ["●", C.cyan], text: "en curso" },
  esperando_aprobacion: { mark: ["⏸", C.yellow], text: "te espera" },
  pausado_por_limite: { mark: ["⏸", C.yellow], text: "en pausa" },
  detenido: { mark: ["✗", C.red], text: "detenido" },
  entregado: { mark: ["✓", C.green], text: "PR abierta" },
  cerrado: { mark: ["✓", C.dim], text: "cerrado" },
  abortado: { mark: ["–", C.dim], text: "abortado" },
};

/** Una fila de la tabla: el nombre con su árbol y los números de sus sesiones. */
interface Line {
  readonly key: string | undefined;
  readonly run: string;
  readonly sessions: readonly string[];
  readonly name: Part[];
  readonly model: string;
  readonly tokens: number;
  readonly usd: number | undefined;
  readonly seconds: number | undefined;
  readonly state: Part;
  readonly dim: boolean;
}

/** Lo que se elige con las flechas: una fila con sesiones, y los nombres de esas sesiones. */
export interface Selectable {
  readonly key: string;
  readonly run: string;
  readonly sessions: readonly string[];
}

export interface BoardOptions {
  readonly width: number;
  readonly color: boolean;
  readonly selected?: string | undefined;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const models = (ss: readonly SessionNode[]) =>
  [...new Set(ss.flatMap((s) => (s.modelo === undefined ? [] : [modelName(s.modelo)])))].join(", ");
const tool = (ss: readonly SessionNode[]): Part => {
  const now = ss.find((s) => s.corriendo);
  return [now?.ultimo === undefined ? "trabajando" : `▸ ${now.ultimo}`, C.cyan];
};
const repeat = (ss: readonly SessionNode[]): Part[] =>
  ss.length > 1 ? [[` ×${String(ss.length)}`, C.dim]] : [];

function phaseState(p: PhaseNode): Part {
  switch (p.estado) {
    case "pendiente":
      return ["", undefined];
    case "corriendo":
      return p.fase === "implementar" ? ["trabajando", C.cyan] : tool(p.sesiones);
    case "ok":
      return [
        p.fase === "aprobar" ? "aprobado" : p.fase === "entregar" ? "PR creada" : "listo",
        C.green,
      ];
    case "espera":
      return p.fase === "aprobar"
        ? ["esperando tu aprobación", C.yellow]
        : ["esperando el merge de la PR", C.yellow];
    case "vuelve":
      return [`volvió: ${p.detalle ?? ""}`, C.yellow];
    case "falla":
      return [`falló: ${p.detalle ?? ""}`, C.red];
    case "pausa":
      return ["límite de la suscripción", C.yellow];
  }
}

function unitState(u: UnitNode, all: readonly UnitNode[]): Part {
  switch (u.estado) {
    case "corriendo":
      return tool(u.sesiones);
    case "integrada":
    case "commiteada":
      return [u.estado, C.green];
    case "fallida":
      return ["falló", C.red];
    case "pendiente": {
      const waiting = u.dependeDe.filter(
        (d) => all.find((x) => x.id === d)?.estado !== "integrada",
      );
      return waiting.length > 0 ? [`espera a ${waiting.join(", ")}`, C.dim] : ["pendiente", C.dim];
    }
  }
}

const PHASE_MARK: Record<PhaseNode["estado"], Part> = {
  pendiente: ["○", C.dim],
  corriendo: ["●", C.cyan],
  ok: ["✓", C.green],
  espera: ["⏸", C.yellow],
  falla: ["✗", C.red],
  vuelve: ["↺", C.yellow],
  pausa: ["⏸", C.yellow],
};

const UNIT_MARK: Record<UnitNode["estado"], Part> = {
  pendiente: ["○", C.dim],
  corriendo: ["●", C.cyan],
  commiteada: ["✓", C.green],
  integrada: ["✓", C.green],
  fallida: ["✗", C.red],
};

function runLines(tree: RunTree): Line[] {
  const all = tree.fases.flatMap((p) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)]);
  const status = RUN_STATUS[tree.status];
  const lines: Line[] = [
    {
      key: undefined,
      run: tree.id,
      sessions: [],
      name: [[" "], status.mark, [" "], [tree.clave, C.bold], ["  "], [tree.titulo]],
      model: "",
      tokens: sum(all.map((s) => s.tokens)),
      usd: tree.costoUsd,
      seconds: tree.segundos,
      state: [status.text, status.mark[1]],
      dim: false,
    },
  ];
  tree.fases.forEach((p, i) => {
    const last = i === tree.fases.length - 1;
    const own = [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)];
    const name: Part[] = [
      ["   "],
      [last ? "└─ " : "├─ ", C.dim],
      PHASE_MARK[p.estado],
      [" "],
      [p.fase],
    ];
    if (p.fase === "implementar" && p.unidades.length > 0) {
      const done = p.unidades.filter((u) => u.estado === "integrada").length;
      name.push([`  ${String(done)}/${String(p.unidades.length)}`, C.dim]);
    }
    lines.push({
      key: p.sesiones.length > 0 ? `${tree.id}:${p.fase}` : undefined,
      run: tree.id,
      sessions: p.sesiones.map((s) => s.nombre),
      name: [...name, ...repeat(p.sesiones)],
      model: models(own),
      tokens: sum(own.map((s) => s.tokens)),
      usd: p.costoUsd,
      seconds: p.segundos,
      state: phaseState(p),
      dim: p.estado === "pendiente",
    });
    p.unidades.forEach((u, j) => {
      const lastUnit = j === p.unidades.length - 1;
      const stem = last ? "      " : "   │  ";
      const done = u.sesiones.filter((s) => s.costoUsd !== undefined);
      lines.push({
        key: u.sesiones.length > 0 ? `${tree.id}:${u.id}` : undefined,
        run: tree.id,
        sessions: u.sesiones.map((s) => s.nombre),
        name: [
          [stem, C.dim],
          [lastUnit ? "└─ " : "├─ ", C.dim],
          UNIT_MARK[u.estado],
          [" "],
          [u.id, C.bold],
          [" "],
          [u.titulo],
          ...repeat(u.sesiones),
        ],
        model: models(u.sesiones),
        tokens: sum(u.sesiones.map((s) => s.tokens)),
        usd: done.length === 0 ? undefined : sum(done.map((s) => s.costoUsd ?? 0)),
        seconds: u.sesiones.length === 0 ? undefined : sum(u.sesiones.map((s) => s.segundos)),
        state: unitState(u, p.unidades),
        dim: u.estado === "pendiente",
      });
    });
  });
  return lines;
}

/** Qué columnas entran: con poco ancho se pierden primero el modelo y después los tokens. La de
 * nombres toma lo que ocupa el más largo, sin quitarle al estado sus 26 columnas. */
function layout(width: number, longestName: number) {
  const withModel = width >= 100;
  const withTokens = width >= 76;
  const fixed = (withModel ? 13 : 0) + (withTokens ? 8 : 0) + 8 + 8 + 2;
  const name = Math.max(20, Math.min(longestName + 2, 56, width - fixed - 26));
  const state = Math.max(8, width - name - fixed);
  return { withModel, withTokens, name, state };
}

export function renderBoard(
  trees: readonly RunTree[],
  opts: BoardOptions,
): { lines: string[]; selectable: Selectable[] } {
  const { width, color } = opts;
  if (trees.length === 0) return { lines: ["no hay runs activos"], selectable: [] };
  const rows = trees.map((tree) => ({ tree, lines: runLines(tree) }));
  const longest = Math.max(
    ...rows.flatMap((r) => r.lines.map((l) => visible(l.name.map(([t]) => t).join("")).length)),
  );
  const col = layout(width, longest);
  const counts = new Map<RunTree["status"], number>();
  for (const t of trees) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const summary: Part[] = [];
  for (const [status, n] of counts) {
    if (summary.length > 0) summary.push(["  "]);
    summary.push(RUN_STATUS[status].mark, [` ${String(n)} ${RUN_STATUS[status].text}`]);
  }
  const header = [
    " ".repeat(col.name),
    col.withModel ? "  MODELO     " : "",
    col.withTokens ? right("TOKENS", 8) : "",
    right("≈ USD", 8),
    right("TIEMPO", 8),
    "  ESTADO",
  ].join("");
  const out = [cell(summary, width, color), cell([[header, C.dim]], width, color)];
  const selectable: Selectable[] = [];

  const projects = [...new Set(trees.map((t) => t.proyecto))];
  for (const project of projects) {
    out.push(cell([[project, C.bold]], width, color));
    for (const { tree, lines } of rows.filter((r) => r.tree.proyecto === project)) {
      for (const l of lines) {
        const selected = l.key !== undefined && l.key === opts.selected;
        if (l.key !== undefined) selectable.push({ key: l.key, run: l.run, sessions: l.sessions });
        const tone = l.dim ? C.dim : undefined;
        const numbers = [
          col.withModel ? `  ${cell([[l.model]], 11, false, true)}` : "",
          col.withTokens ? right(l.dim ? "" : tokenCount(l.tokens), 8) : "",
          right(l.dim ? "" : usd(l.usd), 8),
          right(l.seconds === undefined || l.dim ? "" : duration(l.seconds), 8),
          "  ",
        ].join("");
        // El marcador reemplaza solo el primer espacio, para no correr el árbol.
        const [first = [""], ...rest] = l.name;
        const name: Part[] = selected
          ? [["›", C.cyan], [first[0].slice(1), first[1]], ...rest]
          : l.name.map(([t, c]) => [t, c ?? tone] as Part);
        out.push(
          cell(name, col.name, color, true) +
            cell([[numbers, C.dim]], width - col.name, color) +
            cell([l.state], col.state, color),
        );
      }
      if (tree.motivo !== undefined) {
        out.push(cell([["   Motivo: ", C.red], [tree.motivo]], width, color));
      }
      if (tree.siguiente !== undefined) {
        out.push(
          cell(
            [
              ["   Para seguir: ", C.yellow],
              [tree.siguiente, C.bold],
            ],
            width,
            color,
          ),
        );
      }
    }
  }
  return { lines: out, selectable };
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
    cell(
      [
        [s.nombre, C.bold],
        [`  ${s.modelo === undefined ? "" : modelName(s.modelo)}`, C.dim],
        [
          ` · ${tokenCount(s.tokens)} tokens · ≈ USD ${usd(s.costoUsd)} · ${duration(s.segundos)}`,
          C.dim,
        ],
      ],
      width,
      color,
    ),
    ...steps.map((st) =>
      cell(
        [
          [`  ${STEP_MARK[st.tipo]} `, C.dim],
          [st.texto, st.tipo === "herramienta" ? C.cyan : st.tipo === "texto" ? undefined : C.dim],
        ],
        width,
        color,
      ),
    ),
  ]);
  const room = Math.max(1, opts.height - 2);
  const shown = body.slice(-room);
  const hidden = body.length - shown.length;
  return [
    cell([[title, C.bold]], width, color),
    hidden > 0 ? cell([[`  … ${String(hidden)} líneas antes`, C.dim]], width, color) : "",
    ...shown,
  ];
}
