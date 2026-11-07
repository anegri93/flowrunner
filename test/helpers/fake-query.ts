// Una `query` falsa que reproduce un stream grabado y guarda las opciones con que la llamaron.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/types.ts";

export const STREAMS = join(import.meta.dirname, "..", "fixtures", "streams");

export function stream(name: string): SDKMessage[] {
  return readFileSync(join(STREAMS, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage);
}

export interface FakeQuery {
  readonly query: QueryFn;
  readonly calls: { prompt: string; options: Options | undefined }[];
}

/** Cada llamada devuelve el siguiente stream de `streams`; el último se repite. */
export function fakeQuery(
  ...streams: (SDKMessage[] | ((options: Options | undefined) => AsyncIterable<SDKMessage>))[]
): FakeQuery {
  const calls: FakeQuery["calls"] = [];
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const next = streams[Math.min(calls.length - 1, streams.length - 1)];
    if (next === undefined) throw new Error("fakeQuery sin streams");
    if (typeof next === "function") return next(options);
    return (async function* () {
      for (const message of next) yield await Promise.resolve(message);
    })();
  };
  return { query, calls };
}

/** Un stream que no termina hasta que se aborta la sesión. */
export function hanging(options: Options | undefined): AsyncIterable<SDKMessage> {
  return (async function* () {
    await new Promise((_, reject) => {
      options?.abortController?.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
    yield* [];
  })();
}

/** Un resultado de éxito mínimo, con costo y salida estructurada opcional. */
export function resultMessage(extra: Record<string, unknown> = {}): SDKMessage {
  const base = stream("salida-estructurada").find((m) => m.type === "result");
  return { ...base, ...extra } as SDKMessage;
}
