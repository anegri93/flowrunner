// Smoke del entorno de sesión: un comando que pasa el timeout de Bash muere, no queda en segundo
// plano. Usa la sesión de Claude Code de la persona y gasta suscripción.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { collect, isolatedOptions } from "./helpers.ts";

const MARK = `flowrunner-fondo-${String(process.pid)}`;
const alive = () => Number(execSync(`pgrep -f "${MARK}" | wc -l`).toString().trim());

const allowBash: HookCallback = (input) =>
  Promise.resolve(
    input.hook_event_name === "PreToolUse" && input.tool_name === "Bash"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }
      : {},
  );

// Si regresiona (el SDK cambia la variable o su efecto), una sub-task con un test que no termina
// vuelve a trabar el run hasta su timeout, como ST-2 en CUENTAS-1. Sin la variable, el mismo comando
// devuelve `backgroundTaskId`, el stream no cierra y el proceso sigue vivo: se comprobó a mano al
// escribir este smoke, y no se automatiza porque deja la sesión colgada.
test("con el entorno de flowrunner, un comando que pasa su timeout muere y la sesión cierra", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "flowrunner-fondo-"));
  const messages: SDKMessage[] = await collect(
    `Run exactly this Bash command with the timeout parameter set to 4000: \`node -e "setInterval(()=>{},1000)" ${MARK}\`. Do not run anything else. When the tool returns, reply only with the word listo.`,
    isolatedOptions(cwd, {
      tools: ["Bash"],
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [allowBash] }] },
    }),
  );
  const results = messages.flatMap((m) =>
    m.type === "user" && Array.isArray(m.message.content)
      ? m.message.content.filter((b) => b.type === "tool_result").map((b) => JSON.stringify(b))
      : [],
  );
  expect(results.join("\n")).not.toContain("backgroundTaskId");
  expect(results.join("\n")).toMatch(/timed out/i);
  expect(alive()).toBe(0);
}, 120_000);
