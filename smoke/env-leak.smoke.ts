// Smoke del punto abierto 1, ADR 0013. Usa la sesión de Claude Code de la persona y gasta suscripción.
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { buildSessionEnv, scrubCommand, SECRET_ENV_VARS } from "../src/agent/env.ts";

const SENTINEL = "FLOWRUNNER_SENTINEL";
const SENTINEL_VALUE = "centinela-7f3a";
const COMMAND = `env | grep -c ${SENTINEL} ; echo "valor=\${${SENTINEL}:-ausente}"`;

/** Corre una sesión real que ejecuta COMMAND por Bash y devuelve lo que vio el comando. */
async function bashOutputSeenByAgent(scrub: boolean): Promise<string> {
  const rewrite: HookCallback = (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
      return Promise.resolve({});
    }
    const toolInput = input.tool_input as { command: string };
    const command = scrub
      ? scrubCommand(toolInput.command, [...SECRET_ENV_VARS, SENTINEL])
      : toolInput.command;
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, command },
      },
    });
  };
  const env = { ...buildSessionEnv({ kind: "login" }, process.env), [SENTINEL]: SENTINEL_VALUE };
  const session = query({
    prompt: `Run exactly this bash command once, then stop: ${COMMAND}`,
    options: {
      model: "haiku",
      effort: "low",
      settingSources: [],
      strictMcpConfig: true,
      env,
      tools: ["Bash"],
      maxTurns: 3,
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [rewrite] }] },
      canUseTool: () => Promise.resolve({ behavior: "deny", message: "no permitido" }),
    },
  });
  const outputs: string[] = [];
  for await (const message of session as AsyncIterable<SDKMessage>) {
    if (message.type !== "user" || !Array.isArray(message.message.content)) continue;
    for (const block of message.message.content) {
      if (block.type === "tool_result") outputs.push(JSON.stringify(block.content));
    }
  }
  return outputs.join("\n");
}

// Si regresiona, el código que escribe el agente puede leer la credencial de la suscripción.
test("con la reescritura, Bash no ve las variables secretas de la sesión", async () => {
  const seen = await bashOutputSeenByAgent(true);
  expect(seen).toContain("valor=ausente");
  expect(seen).not.toContain(SENTINEL_VALUE);
});

// El canario vive en el propio smoke: sin la reescritura, el mismo comando ve el centinela.
test("sin la reescritura, Bash ve el entorno de la sesión", async () => {
  const seen = await bashOutputSeenByAgent(false);
  expect(seen).toContain(`valor=${SENTINEL_VALUE}`);
});
