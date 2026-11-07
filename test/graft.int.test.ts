import { spawn } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, graftMcpServer } from "../src/graft/graft.ts";
import { git, repoWith, tempDir } from "./helpers/git.ts";

const FILES = {
  "src/pedidos.ts":
    "export function totalDePedidos(montos: number[]): number {\n  return montos.reduce((a, b) => a + b, 0);\n}\n",
  "src/api.ts":
    'import { totalDePedidos } from "./pedidos.ts";\nexport const total = totalDePedidos([1, 2]);\n',
};

/** Habla MCP por stdio con el servidor que flowrunner le pasaría al SDK y llama a una herramienta. */
async function callGraftTool(repo: string, indexDir: string, tool: string): Promise<string> {
  const server = graftMcpServer(repo, indexDir);
  const child = spawn(server.command, server.args, { env: server.env, cwd: repo });
  let buffer = "";
  const responses = new Map<number, unknown>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) responses.set(message.id, message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id: number) => {
    for (let i = 0; i < 300; i++) {
      if (responses.has(id)) return responses.get(id);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`graft mcp no respondió el pedido ${id}`);
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } });
    return JSON.stringify(await waitFor(2));
  } finally {
    child.kill();
  }
}

describe("graft fuera del repo", () => {
  // Si regresiona, el diff de cada feature arrastra .gitignore, .ignore o la caché de graft.
  test("construir el índice no deja ningún archivo en el worktree", async () => {
    const repo = repoWith(FILES);
    await buildIndex(repo, join(tempDir(), "graft"));
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  // Si regresiona, planificar y revisar trabajan sin el grafo sin enterarse.
  test("el servidor MCP responde con archivos reales del repo", async () => {
    const repo = repoWith(FILES);
    const index = join(tempDir(), "graft");
    await buildIndex(repo, index);
    const map = await callGraftTool(repo, index, "graft_repo_map");
    expect(map).toContain("src/pedidos.ts");
  });

  // Sostiene la decisión del ADR 0015: un índice construido en un worktree sirve copiado a otro.
  test("un índice copiado responde igual desde otro clon del repo", async () => {
    const repo = repoWith(FILES);
    const index = join(tempDir(), "graft");
    await buildIndex(repo, index);
    const other = tempDir();
    git(other, "clone", "-q", repo, "clon");
    const copied = join(tempDir(), "graft");
    cpSync(index, copied, { recursive: true });
    const map = await callGraftTool(join(other, "clon"), copied, "graft_repo_map");
    expect(map).toContain("src/api.ts");
  });
});
