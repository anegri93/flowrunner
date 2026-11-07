// `flowrunner watch [run]`: la tabla de un run, o de todos los activos, en vivo como `top`. Con las
// flechas se elige una fase o una sub-task y con Enter se ven los pasos de sus sesiones. Fuera de una
// terminal, o con --once, se dibuja una vez y sale.
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
  opts: { width: number; color: boolean; selected?: string | undefined; now: number },
): { lines: string[]; selectable: Selectable[] } {
  return renderBoard(
    ids.map((id) => loadTree(home, id, opts.now)),
    opts,
  );
}

const KEYS_BOARD = "↑↓ elegir fase o sub-task · Enter ver sus pasos · q salir";
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
  return renderDetail(`${tree.clave} · ${row.key.slice(row.run.length + 1)}`, sessions, {
    width,
    height,
    color: true,
  });
}

/** La vista en vivo. Devuelve cuando la persona sale. */
export function watchLive(home: string, targets: () => string[]): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  let selected: string | undefined;
  let detail: Selectable | undefined;
  let selectable: Selectable[] = [];

  const draw = () => {
    const width = out.columns > 0 ? out.columns : 100;
    const height = out.rows > 0 ? out.rows : 30;
    let lines: string[];
    if (detail === undefined) {
      const board = renderRuns(home, targets(), { width, color: true, selected, now: Date.now() });
      selectable = board.selectable;
      lines = [...board.lines.slice(0, height - 2), "", `\x1b[90m${KEYS_BOARD}\x1b[0m`];
    } else {
      lines = [
        ...detailLines(home, detail, width, height - 2),
        "",
        `\x1b[90m${KEYS_DETAIL}\x1b[0m`,
      ];
    }
    out.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
  };

  const move = (delta: number) => {
    if (selectable.length === 0) return;
    const at = selectable.findIndex((x) => x.key === selected);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : selectable.length - 1
        : Math.min(selectable.length - 1, Math.max(0, at + delta));
    selected = selectable[next]?.key;
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
      } else if (key === "\x1b[A" || key === "k") move(-1);
      else if (key === "\x1b[B" || key === "j") move(1);
      else if ((key === "\r" || key === "\x1b[C") && selected !== undefined) {
        detail = selectable.find((x) => x.key === selected);
      } else if (key === "\x1b") selected = undefined;
      draw();
    };
    input.on("data", onKey);
    out.on("resize", draw);
    draw();
  });
}
