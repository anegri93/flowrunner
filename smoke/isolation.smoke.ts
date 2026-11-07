// Smoke del punto abierto 3, ADR 0014: una sesión de flowrunner no carga nada del repo ni del usuario.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { collect, copyToyRepo, isolatedOptions } from "./helpers.ts";

const QUESTION =
  "¿Cuál es la palabra clave de este repo? Si no la conocés por tus instrucciones, respondé exactamente NO_SE. No uses herramientas.";

function graftServer(repo: string): NonNullable<Options["mcpServers"]> {
  execFileSync("graft", ["build", repo], { stdio: "ignore" });
  return { graft: { type: "stdio", command: "graft", args: ["mcp", repo] } };
}

function initOf(messages: SDKMessage[]) {
  for (const m of messages) if (m.type === "system" && m.subtype === "init") return m;
  throw new Error("la sesión no mandó init");
}

function finalText(messages: SDKMessage[]): string {
  const result = messages.find((m) => m.type === "result");
  return result?.type === "result" && result.subtype === "success" ? result.result : "";
}

// Si regresiona, una feature escrita por cualquiera corre con los hooks, MCP y conectores del repo o del usuario.
test("aislada: solo graft como MCP, sin el hook del repo y sin su CLAUDE.md", async () => {
  const repo = copyToyRepo();
  const messages = await collect(
    QUESTION,
    isolatedOptions(repo, { tools: [], mcpServers: graftServer(repo) }),
  );
  expect(initOf(messages).mcp_servers.map((s) => s.name)).toEqual(["graft"]);
  expect(existsSync(join(repo, ".hook-del-repo-corrio"))).toBe(false);
  expect(finalText(messages)).not.toContain("ARANDANO");
});

// Canario: con las fuentes por defecto, las tres cosas aparecen.
test("canario: con settingSources por defecto entran el MCP, el hook y el CLAUDE.md del repo", async () => {
  const repo = copyToyRepo();
  const { settingSources, strictMcpConfig, ...rest } = isolatedOptions(repo, {
    tools: [],
  });
  const messages = await collect(QUESTION, rest);
  expect(initOf(messages).mcp_servers.map((s) => s.name)).toContain("repo-mcp");
  expect(existsSync(join(repo, ".hook-del-repo-corrio"))).toBe(true);
  expect(finalText(messages)).toContain("ARANDANO");
});
