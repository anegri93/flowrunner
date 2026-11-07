// `flowrunner watch [run]`: el árbol de un run, o de todos los activos, en vivo como `top`. Con las
// flechas se elige una sesión y con Enter se ven sus pasos. Fuera de una terminal, o con --once, se
// dibuja una vez y sale.
import { renderSession, renderTree, sessionOrder } from "../watch/render.ts";
import { activeRuns, loadSteps, loadTree, resolveRun } from "../watch/load.ts";
import type { RunTree } from "../watch/tree.ts";
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
): { lines: string[]; trees: RunTree[] } {
  if (ids.length === 0) return { lines: ["no hay runs activos"], trees: [] };
  const trees = ids.map((id) => loadTree(home, id, opts.now));
  const lines = trees.flatMap((t, i) => [...(i > 0 ? [""] : []), ...renderTree(t, opts)]);
  return { lines, trees };
}

const KEYS_TREE = "↑↓ elegir sesión · Enter ver sus pasos · q salir";
const KEYS_DETAIL = "Esc volver al árbol · q salir";

/** La vista en vivo. Devuelve cuando la persona sale. */
export function watchLive(home: string, targets: () => string[]): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  let selected: string | undefined;
  let detail: { run: string; session: string } | undefined;
  let trees: RunTree[] = [];

  const draw = () => {
    const width = out.columns > 0 ? out.columns : 100;
    const height = out.rows > 0 ? out.rows : 30;
    let lines: string[];
    if (detail === undefined) {
      const rendered = renderRuns(home, targets(), {
        width,
        color: true,
        selected,
        now: Date.now(),
      });
      trees = rendered.trees;
      lines = [...rendered.lines.slice(0, height - 2), "", `\x1b[90m${KEYS_TREE}\x1b[0m`];
    } else {
      const { run, session } = detail;
      const live = loadTree(home, run, Date.now())
        .fases.flatMap((p) => [...p.sesiones, ...p.unidades.flatMap((u) => u.sesiones)])
        .find((s) => s.nombre === session);
      lines =
        live === undefined
          ? ["la sesión ya no está"]
          : renderSession(live, loadSteps(home, run, session), {
              width,
              height: height - 2,
              color: true,
            });
      lines.push("", `\x1b[90m${KEYS_DETAIL}\x1b[0m`);
    }
    out.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
  };

  const order = () => trees.flatMap((t) => sessionOrder(t).map((s) => ({ run: t.id, session: s })));
  const move = (delta: number) => {
    const all = order();
    if (all.length === 0) return;
    const at = all.findIndex((x) => x.session === selected);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : all.length - 1
        : Math.min(all.length - 1, Math.max(0, at + delta));
    selected = all[next]?.session;
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
        detail = order().find((x) => x.session === selected);
      } else if (key === "\x1b") selected = undefined;
      draw();
    };
    input.on("data", onKey);
    out.on("resize", draw);
    draw();
  });
}
