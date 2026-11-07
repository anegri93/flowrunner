// Ayudas de los smoke tests: el repo de juguete en un tmpdir y una sesión real que junta mensajes.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildSessionEnv } from "../src/agent/env.ts";

const TOY_REPO = join(import.meta.dirname, "..", "test", "toy-repo");

/** Copia el repo de juguete a un tmpdir, como repo git con un commit. */
export function copyToyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "flowrunner-toy-"));
  cpSync(TOY_REPO, dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=toy", "-c", "user.email=toy@example.com", "commit", "-q", "-m", "toy");
  return dir;
}

/** Opciones aisladas por defecto de los smoke: Haiku, effort bajo, sin settings, sin MCP ajenos. */
export function isolatedOptions(cwd: string, extra: Partial<Options> = {}): Options {
  return {
    cwd,
    model: "haiku",
    effort: "low",
    settingSources: [],
    strictMcpConfig: true,
    env: buildSessionEnv({ kind: "login" }, process.env),
    maxTurns: 6,
    canUseTool: () => Promise.resolve({ behavior: "deny", message: "no permitido en el smoke" }),
    ...extra,
  };
}

export async function collect(prompt: string, options: Options): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt, options })) messages.push(message);
  return messages;
}
