// Graba sesiones reales del SDK como fixtures para los tests sin modelo. Gasta suscripción.
// Uso: pnpm exec tsx scripts/record-streams.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type HookCallback,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { copyToyRepo, isolatedOptions } from "../smoke/helpers.ts";

const OUT = join(import.meta.dirname, "..", "test", "fixtures", "streams");

function allowOnly(
  allowed: (tool: string, input: Record<string, unknown>) => string | null,
): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const reason = allowed(input.tool_name, input.tool_input as Record<string, unknown>);
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: reason === null ? "allow" : "deny",
        ...(reason === null ? {} : { permissionDecisionReason: reason }),
      },
    });
  };
}

async function record(name: string, prompt: string, options: Options, stopAfter?: number) {
  const messages: SDKMessage[] = [];
  const controller = new AbortController();
  try {
    for await (const message of query({
      prompt,
      options: { ...options, abortController: controller },
    })) {
      messages.push(message);
      if (stopAfter !== undefined && messages.length >= stopAfter) controller.abort();
    }
  } catch (error) {
    if (stopAfter === undefined) throw error;
  }
  const repo = options.cwd ?? "";
  const text = messages
    .map((m) => JSON.stringify(m))
    .join("\n")
    .replaceAll(repo, "/REPO")
    .replaceAll(homedir(), "/HOME");
  writeFileSync(join(OUT, `${name}.jsonl`), `${text}\n`);
  console.log(name, messages.length, "mensajes");
}

mkdirSync(OUT, { recursive: true });

{
  const repo = copyToyRepo();
  await record(
    "leer-y-editar",
    "Read src/pedidos.js and add an exported function `confirmados(lista)` that returns only the orders whose estado is 'confirmado'. Edit the file, then stop.",
    isolatedOptions(repo, {
      tools: ["Read", "Edit"],
      hooks: { PreToolUse: [{ hooks: [allowOnly(() => null)] }] },
    }),
  );
}
{
  const repo = copyToyRepo();
  await record(
    "bash-permitido-y-negado",
    "First run the bash command `node --test`. Then run the bash command `rm -rf src`. Report what happened and stop.",
    isolatedOptions(repo, {
      tools: ["Bash"],
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              allowOnly((_tool, input) =>
                input.command === "node --test"
                  ? null
                  : "fuera de la lista permitida de la sub-task",
              ),
            ],
          },
        ],
      },
    }),
  );
}
{
  const repo = copyToyRepo();
  await record(
    "salida-estructurada",
    "Look at src/pedidos.js and answer with a short summary of what it does and one decision you would take to add a `confirmados` function.",
    isolatedOptions(repo, {
      tools: ["Read"],
      hooks: { PreToolUse: [{ hooks: [allowOnly(() => null)] }] },
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["resumen", "decisiones"],
          properties: {
            resumen: { type: "string" },
            decisiones: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["que", "por_que"],
                properties: { que: { type: "string" }, por_que: { type: "string" } },
              },
            },
          },
        },
      },
    }),
  );
}
{
  const repo = copyToyRepo();
  await record(
    "cortada-por-timeout",
    "Read every file in this repo one by one, then summarize each in detail.",
    isolatedOptions(repo, {
      tools: ["Read", "Glob"],
      hooks: { PreToolUse: [{ hooks: [allowOnly(() => null)] }] },
    }),
    4,
  );
}
