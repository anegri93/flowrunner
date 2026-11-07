// Salida del CLI: texto para una persona o JSON para la skill de consola. Una sola forma de error.
import { ConfigError } from "../config/schemas.ts";

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const processIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

/** Un error que la persona puede arreglar: sale 1 con el motivo y, si hay, el comando para seguir. */
export class UserError extends Error {
  readonly next: string | undefined;
  constructor(message: string, next?: string) {
    super(message);
    this.name = "UserError";
    this.next = next;
  }
}

export function reportError(error: unknown, json: boolean, io: Io): number {
  if (error instanceof ConfigError || error instanceof UserError) {
    const problems = error instanceof ConfigError ? error.problems : [];
    const next = error instanceof UserError ? error.next : undefined;
    if (json) {
      io.out(JSON.stringify({ ok: false, error: { message: error.message, problems, next } }));
    } else {
      io.err(error.message);
      if (next !== undefined) io.err(`Para seguir: ${next}`);
    }
    return 1;
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (json)
    io.out(JSON.stringify({ ok: false, error: { message: "error interno", detail: message } }));
  else io.err(`error interno de flowrunner:\n${message}`);
  return 2;
}
