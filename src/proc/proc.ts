// Correr procesos: git, gh, setup, verify y los comandos del ac-map. Nunca con los secretos del run.
import { spawn } from "node:child_process";
import { SECRET_ENV_VARS } from "../agent/env.ts";

export interface ProcResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** El entorno de un proceso que lanza flowrunner: el de la persona sin las variables secretas. */
export function cleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of SECRET_ENV_VARS) Reflect.deleteProperty(env, name);
  return env;
}

export function runProc(
  command: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: cleanEnv(opts.env) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer);
      if (error.code === "ENOENT")
        resolve({ code: 127, stdout, stderr: `${command}: no existe`, timedOut });
      else reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: code ?? 137, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Un comando de shell, como el setup o un comando del ac-map. */
export function runShell(
  script: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcResult> {
  return runProc("sh", ["-c", script], opts);
}

/** El final de la salida de un proceso, para un motivo legible: las últimas `lines` líneas. */
export function tail(result: ProcResult, lines = 30): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split("\n").slice(-lines).join("\n");
}

/** Exit 126 o 127, o "command not found": el comando no se pudo ejecutar, no falló. */
export function isUnrunnable(result: ProcResult): boolean {
  return (
    result.code === 126 ||
    result.code === 127 ||
    /command not found|not found: |No such file or directory/.test(result.stderr)
  );
}
