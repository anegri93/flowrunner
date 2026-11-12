// `flowrunner watch [run]`: el recorrido de un run, o de todos los activos, en vivo como `top`. Con
// las flechas se elige una fila: → la abre, ← la pliega o sube a su padre, y en una sesión Enter muestra
// sus pasos. Fuera de una terminal, o con --once, se dibuja una vez y sale.
import { renderBoard, renderDetail, type Selectable } from "../watch/render.ts";
import { activeRuns, loadSteps, loadTree, resolveRun } from "../watch/load.ts";
import { UserError } from "./output.ts";

const REFRESH_MS = 2_000;

/** Los runs a mirar: el pedido por id o clave, o todos los activos en cada refresco. */
export function watchTargets(home: string, arg: string | undefined): () => string[] {
  if (arg === undefined) return () => activeRuns(home);
  const id = resolveRun(home, arg);
  if (id === undefined) throw new UserError(`no existe el run ${arg}`, "flowrunner status");
  return () => [id];
}

export function renderRuns(
  home: string,
  ids: readonly string[],
  opts: {
    width: number;
    color: boolean;
    selected?: string | undefined;
    abiertos?: ReadonlyMap<string, boolean>;
    now: number;
  },
): { lines: string[]; selectable: Selectable[] } {
  return renderBoard(
    ids.map((id) => loadTree(home, id, opts.now)),
    opts,
  );
}

const KEYS_BOARD = "↑↓ elegir · → abrir · ← plegar · Enter abrir o ver los pasos · q salir";
const KEYS_DETAIL = "Esc volver · q salir";

/** El detalle de una fila: los pasos de cada una de sus sesiones, leídos de nuevo en cada refresco. */
function detailLines(home: string, row: Selectable, width: number, height: number): string[] {
  const tree = loadTree(home, row.run, Date.now());
  const nodes = tree.fases.flatMap((p) => [
    ...p.sesiones,
    ...p.unidades.flatMap((u) => u.sesiones),
  ]);
  const sessions = row.sessions.flatMap((name) => {
    const node = nodes.find((n) => n.nombre === name);
    return node === undefined ? [] : [{ node, steps: loadSteps(home, row.run, name) }];
  });
  return renderDetail(`${tree.clave} › ${row.titulo}`, sessions, {
    width,
    height,
    color: true,
  });
}

export interface BoardState {
  readonly selected: string | undefined;
  /** Lo que la persona abrió o plegó; lo demás sigue lo que dice el recorrido. */
  readonly abiertos: ReadonlyMap<string, boolean>;
}

/**
 * Una tecla en el tablero: moverse, abrir, plegar o subir al padre. En una sesión, Enter o → piden
 * ver sus pasos (`detail`).
 */
export function boardKey(
  state: BoardState,
  key: string,
  selectable: readonly Selectable[],
): BoardState & { detail?: Selectable } {
  const row = selectable.find((x) => x.key === state.selected);
  const set = (abierto: boolean) =>
    row === undefined
      ? state
      : { ...state, abiertos: new Map(state.abiertos).set(row.key, abierto) };
  const move = (delta: number) => {
    if (selectable.length === 0) return state;
    const at = selectable.findIndex((x) => x.key === state.selected);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : selectable.length - 1
        : Math.min(selectable.length - 1, Math.max(0, at + delta));
    return { ...state, selected: selectable[next]?.key };
  };
  if (key === "\x1b[A" || key === "k") return move(-1);
  if (key === "\x1b[B" || key === "j") return move(1);
  if (key === "\x1b") return { ...state, selected: undefined };
  if (row === undefined) return state;
  if (key === "\x1b[D") {
    return row.abierto === true ? set(false) : { ...state, selected: row.parent ?? row.key };
  }
  if (key === "\x1b[C" || key === "\r") {
    if (row.abierto === undefined) return { ...state, detail: row };
    return set(key === "\r" ? !row.abierto : true);
  }
  return state;
}

/** La vista en vivo. Devuelve cuando la persona sale. */
export function watchLive(
  home: string,
  targets: () => string[],
  abiertos: ReadonlyMap<string, boolean> = new Map(),
): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  let board: BoardState = { selected: undefined, abiertos };
  let detail: Selectable | undefined;
  let selectable: Selectable[] = [];

  const draw = () => {
    const width = out.columns > 0 ? out.columns : 100;
    const height = out.rows > 0 ? out.rows : 30;
    let lines: string[];
    if (detail === undefined) {
      const drawn = renderRuns(home, targets(), {
        width,
        color: true,
        ...board,
        now: Date.now(),
      });
      selectable = drawn.selectable;
      lines = [...drawn.lines.slice(0, height - 2), "", `\x1b[90m${KEYS_BOARD}\x1b[0m`];
    } else {
      lines = [
        ...detailLines(home, detail, width, height - 2),
        "",
        `\x1b[90m${KEYS_DETAIL}\x1b[0m`,
      ];
    }
    out.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
  };

  return new Promise((resolve) => {
    out.write("\x1b[?1049h\x1b[?25l");
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const timer = setInterval(draw, REFRESH_MS);
    const quit = () => {
      clearInterval(timer);
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onKey);
      out.removeListener("resize", draw);
      out.write("\x1b[?25h\x1b[?1049l");
      resolve();
    };
    const onKey = (key: string) => {
      if (key === "q" || key === "\x03") {
        quit();
        return;
      }
      if (detail !== undefined) {
        if (key === "\x1b" || key === "\x1b[D") detail = undefined;
      } else {
        const next = boardKey(board, key, selectable);
        board = { selected: next.selected, abiertos: next.abiertos };
        detail = next.detail;
      }
      draw();
    };
    input.on("data", onKey);
    out.on("resize", draw);
    draw();
  });
}
