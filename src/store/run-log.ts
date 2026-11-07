// Leer y escribir `events.jsonl`. Cada evento se escribe con fsync: un corte no pierde lo escrito.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { eventSchema, type NewEvent, type RunEvent } from "./events.ts";

export class CorruptLogError extends Error {
  constructor(file: string, line: number, reason: string) {
    super(
      `events.jsonl corrupto en ${file}, línea ${line}: ${reason}. No se adivina el estado del run.`,
    );
    this.name = "CorruptLogError";
  }
}

export interface LogRead {
  readonly events: RunEvent[];
  /** La última línea estaba cortada por un corte durante la escritura y se descartó. */
  readonly discardedTail: boolean;
}

export function logFile(runDir: string): string {
  return join(runDir, "events.jsonl");
}

export function readLog(runDir: string): LogRead {
  const file = logFile(runDir);
  if (!existsSync(file)) return { events: [], discardedTail: false };
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  // Un archivo bien escrito termina en "\n": la última "línea" es vacía.
  const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines;
  const events: RunEvent[] = [];
  let discardedTail = false;
  for (const [index, line] of complete.entries()) {
    const isLast = index === complete.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLast && !text.endsWith("\n")) {
        discardedTail = true;
        break;
      }
      throw new CorruptLogError(file, index + 1, "no es JSON");
    }
    const result = eventSchema.safeParse(parsed);
    if (!result.success) {
      throw new CorruptLogError(
        file,
        index + 1,
        result.error.issues[0]?.message ?? "evento inválido",
      );
    }
    events.push(result.data);
  }
  return { events, discardedTail };
}

/** Agrega un evento al log. El `at` sale del reloj inyectado. */
export function appendEvent(
  runDir: string,
  event: NewEvent,
  now: () => Date = () => new Date(),
): RunEvent {
  const full = eventSchema.parse({ ...event, at: now().toISOString() });
  const fd = openSync(logFile(runDir), "a");
  try {
    writeSync(fd, `${JSON.stringify(full)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return full;
}
