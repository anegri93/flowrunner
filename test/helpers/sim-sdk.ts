// Un SDK simulado para tests sin modelo: reproduce un guion de herramientas, pasa cada una por el
// hook PreToolUse real como lo haría el SDK, aplica en disco lo permitido y termina con un resultado.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/types.ts";
import { stream } from "./fake-query.ts";

export interface SimCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface SimScript {
  readonly calls?: readonly SimCall[];
  /** El `structured_output` del resultado. */
  readonly output?: unknown;
  readonly text?: string;
  readonly costUsd?: number;
  /** Para simular un resultado de error del SDK. */
  readonly subtype?: string;
  /** Cuánto tarda la sesión antes de terminar, para probar sesiones simultáneas. */
  readonly delayMs?: number;
  /** Si está, el guion solo sirve para un prompt que contiene este texto. */
  readonly match?: string;
  /** La sesión se corta con este error después del init, como un corte de red del SDK. */
  readonly throws?: string;
}

export interface SimRecord {
  readonly prompt: string;
  readonly options: Options | undefined;
  readonly decisions: { tool: string; decision: string; reason?: string }[];
}

const INIT = stream("salida-estructurada").find((m) => m.type === "system") as SDKMessage;
const RESULT = stream("salida-estructurada").find((m) => m.type === "result") as SDKMessage;

function apply(cwd: string, call: SimCall): string {
  const path = (p: unknown) => (typeof p === "string" ? (isAbsolute(p) ? p : join(cwd, p)) : "");
  switch (call.tool) {
    case "Write": {
      const file = path(call.input.file_path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof call.input.content === "string" ? call.input.content : "");
      return "File written";
    }
    case "Edit": {
      const file = path(call.input.file_path);
      const text = readFileSync(file, "utf8");
      writeFileSync(
        file,
        text.replace(String(call.input.old_string), String(call.input.new_string)),
      );
      return "File edited";
    }
    case "Bash":
      try {
        return execFileSync(
          "sh",
          ["-c", typeof call.input.command === "string" ? call.input.command : ""],
          {
            cwd,
            encoding: "utf8",
          },
        );
      } catch (error) {
        return `exit ${(error as { status?: number }).status ?? 1}`;
      }
    default:
      return "ok";
  }
}

/** Cada llamada a `query` toma el siguiente guion; `records` guarda prompts, opciones y decisiones. */
export function simQuery(
  scripts: readonly SimScript[] | ((prompt: string, n: number) => SimScript),
) {
  const records: SimRecord[] = [];
  const concurrency = { active: 0, max: 0 };
  const query: QueryFn = ({ prompt, options }) => {
    const n = records.length;
    const script =
      typeof scripts === "function" ? scripts(prompt, n) : scripts[Math.min(n, scripts.length - 1)];
    if (script === undefined) throw new Error("simQuery sin guiones");
    const record: SimRecord = { prompt, options, decisions: [] };
    records.push(record);
    const cwd = options?.cwd ?? process.cwd();
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
    return (async function* () {
      concurrency.active++;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
      yield INIT;
      if (script.throws !== undefined) {
        concurrency.active--;
        throw new Error(script.throws);
      }
      for (const [i, call] of (script.calls ?? []).entries()) {
        const id = `toolu_sim_${n}_${i}`;
        let decision = "allow";
        let reason: string | undefined;
        let input = call.input;
        if (hook !== undefined) {
          const out = (await hook(
            {
              hook_event_name: "PreToolUse",
              tool_name: call.tool,
              tool_input: call.input,
              tool_use_id: id,
              session_id: "sim",
              transcript_path: "/sim",
              cwd,
            },
            id,
            { signal: new AbortController().signal },
          )) as {
            hookSpecificOutput?: {
              permissionDecision?: string;
              permissionDecisionReason?: string;
              updatedInput?: Record<string, unknown>;
            };
          };
          decision = out.hookSpecificOutput?.permissionDecision ?? "allow";
          reason = out.hookSpecificOutput?.permissionDecisionReason;
          input = out.hookSpecificOutput?.updatedInput ?? call.input;
        }
        record.decisions.push({
          tool: call.tool,
          decision,
          ...(reason === undefined ? {} : { reason }),
        });
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name: call.tool, input: call.input }] },
        } as unknown as SDKMessage;
        const content =
          decision === "allow" ? apply(cwd, { tool: call.tool, input }) : (reason ?? "denied");
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
        } as unknown as SDKMessage;
      }
      if (script.delayMs !== undefined) await new Promise((r) => setTimeout(r, script.delayMs));
      concurrency.active--;
      yield {
        ...RESULT,
        subtype: script.subtype ?? "success",
        result: script.text ?? "listo",
        structured_output: script.output,
        total_cost_usd: script.costUsd ?? 0.01,
        errors: [],
      } as SDKMessage;
    })();
  };
  return { query, records, concurrency };
}
