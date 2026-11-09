// El worker del plugin: corre el CLI de flowrunner y le contesta al panel. Orca lo transpila al
// cargarlo, sin paso de build. No guarda estado: cada pedido lee los runs de nuevo.
import { execFile } from "node:child_process";
import type { OrcaWorkerApi } from "orca/worker";
import type { Outcome, Snapshot } from "./protocol";
import { parseWatch, PHASES, planView, type Decision } from "./runs";

const TIMEOUT_MS = 20_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MOTIVO = 2_000;

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

interface Proc {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(script: string): Promise<Proc> {
  const shell = process.env.SHELL ?? "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", script],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });
}

const lastLines = (text: string) => text.trim().split("\n").slice(-3).join("\n");

async function ok(script: string): Promise<string> {
  const proc = await run(script);
  if (proc.code !== 0) throw new Error(lastLines(proc.stderr || proc.stdout));
  return proc.stdout;
}

/** El id tiene que ser el de un run, nunca algo que el shell interprete. */
function runId(id: unknown): string {
  if (typeof id !== "string" || !RUN_ID.test(id))
    throw new Error(`id de run inválido: ${String(id)}`);
  return id;
}

/** La decisión como argumentos de un comando fijo de flowrunner; nada del panel llega sin validar. */
export function decisionArgs(id: string, decision: Decision): string {
  switch (decision.accion) {
    case "aprobar":
      return `approve ${quote(id)}`;
    case "cambios": {
      const motivo = typeof decision.motivo === "string" ? decision.motivo.trim() : "";
      if (motivo === "") throw new Error("falta el motivo de los cambios");
      if (motivo.length > MAX_MOTIVO) throw new Error("el motivo es demasiado largo");
      return `changes ${quote(id)} ${quote(motivo)}`;
    }
    case "reanudar":
      return `resume ${quote(id)}`;
    case "rehacer":
      if (!PHASES.includes(decision.desde))
        throw new Error(`fase inválida: ${String(decision.desde)}`);
      return `rerun ${quote(id)} --desde ${decision.desde}`;
    default:
      throw new Error("decisión desconocida");
  }
}

/** Lo que contestó flowrunner a una decisión, con `--json`: lo que hizo, o el error y cómo seguir. */
function outcomeOf(proc: Proc): Outcome {
  try {
    const data = JSON.parse(proc.stdout) as {
      ok?: boolean;
      accion?: string;
      error?: { message?: string; next?: string };
    };
    if (data.ok === true) return { ok: true, mensaje: data.accion ?? "hecho" };
    const next = data.error?.next === undefined ? "" : `\nPara seguir: ${data.error.next}`;
    return { ok: false, mensaje: `${data.error?.message ?? "flowrunner no pudo"}${next}` };
  } catch {
    return {
      ok: false,
      mensaje: lastLines(proc.stderr || proc.stdout) || "flowrunner no contestó",
    };
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle("flowrunner.runs", async (): Promise<Snapshot> => {
    const at = Date.now();
    try {
      return { runs: parseWatch(await ok(`${await command(orca)} watch --json`)), at };
    } catch (error) {
      return { runs: [], error: error instanceof Error ? error.message : String(error), at };
    }
  });

  orca.panels.handle("flowrunner.pasos", async ({ run: id, sesion }) => {
    const out = await ok(
      `${await command(orca)} report ${quote(runId(id))} --sesion ${quote(sesion)} --json`,
    );
    const data = JSON.parse(out) as { texto?: unknown };
    return { sesion, texto: typeof data.texto === "string" ? data.texto : "" };
  });

  orca.panels.handle("flowrunner.plan", async ({ run: id }) =>
    planView(JSON.parse(await ok(`${await command(orca)} plan ${quote(runId(id))} --json`))),
  );

  orca.panels.handle("flowrunner.decidir", async ({ run: id, decision }) => {
    let args: string;
    try {
      args = decisionArgs(runId(id), decision);
    } catch (error) {
      return { ok: false, mensaje: error instanceof Error ? error.message : String(error) };
    }
    orca.log(`decisión: ${args}`);
    return outcomeOf(await run(`${await command(orca)} ${args} --json`));
  });
}
