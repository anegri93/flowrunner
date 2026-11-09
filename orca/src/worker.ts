// El worker del plugin: corre el CLI de flowrunner y le contesta al panel. Orca lo transpila al
// cargarlo, sin paso de build. No guarda estado: cada pedido lee los runs de nuevo.
import { execFile } from "node:child_process";
import type { OrcaWorkerApi } from "orca/worker";
import type { Snapshot } from "./protocol";
import { parseWatch } from "./runs";

const TIMEOUT_MS = 20_000;

/**
 * El comando de flowrunner, de la config del plugin. Corre en un shell de login para tener el PATH
 * de la persona: Orca no lanza el worker desde una terminal, y `flowrunner` vive en ~/.local/bin.
 */
async function command(orca: OrcaWorkerApi): Promise<string> {
  const settings = await orca.settings.get();
  const value = settings.comando;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "flowrunner";
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

function run(script: string): Promise<string> {
  const shell = process.env.SHELL ?? "/bin/zsh";
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-lc", script],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error((stderr.trim() || error.message).split("\n").slice(-3).join("\n")));
      },
    );
  });
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle("flowrunner.runs", async (): Promise<Snapshot> => {
    const at = Date.now();
    try {
      const out = await run(`${await command(orca)} watch --json`);
      return { runs: parseWatch(out), at };
    } catch (error) {
      return { runs: [], error: error instanceof Error ? error.message : String(error), at };
    }
  });

  orca.panels.handle("flowrunner.pasos", async ({ run: id, sesion }) => {
    const out = await run(
      `${await command(orca)} report ${quote(id)} --sesion ${quote(sesion)} --json`,
    );
    const data = JSON.parse(out) as { texto?: unknown };
    return { sesion, texto: typeof data.texto === "string" ? data.texto : "" };
  });
}
