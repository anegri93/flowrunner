import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { describe, expect, test } from "vitest";
import { buildSessionEnv, scrubCommand, SECRET_ENV_VARS } from "./env.ts";

function runInShell(command: string, env: Record<string, string>): string {
  return execFileSync("sh", ["-c", command], { env: { PATH: process.env.PATH ?? "", ...env } })
    .toString()
    .trim();
}

describe("scrubCommand", () => {
  // Si regresiona, un test escrito por el agente puede leer el token de la suscripción.
  test("el comando reescrito no ve las variables secretas", () => {
    const out = runInShell(scrubCommand('echo "token=${CLAUDE_CODE_OAUTH_TOKEN:-ausente}"'), {
      CLAUDE_CODE_OAUTH_TOKEN: "secreto-real",
    });
    expect(out).toBe("token=ausente");
  });

  // Si regresiona, un comando permitido del ac-map deja de correr igual que lo escribió plan.
  test("conserva comillas simples, dobles y variables que no son secretas", () => {
    const out = runInShell(scrubCommand(`printf '%s|%s' "a'b" "$OTRA"`), { OTRA: "c d" });
    expect(out).toBe("a'b|c d");
  });

  test("conserva el código de salida del comando", () => {
    const result = spawnSync("sh", ["-c", scrubCommand("exit 3")]);
    expect(result.status).toBe(3);
  });
});

describe("buildSessionEnv", () => {
  // Si regresiona, la sesión hereda variables de la persona que el agente no debería ver.
  test("solo pasa lo necesario para arrancar, más el token en modo token", () => {
    const env = buildSessionEnv(
      { kind: "token", token: "tok", configDir: "/x/claude" },
      { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "no", GITHUB_TOKEN: "no" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      USER: userInfo().username,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_AGENT_SDK_CLIENT_APP: "flowrunner/0",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CONFIG_DIR: "/x/claude",
    });
  });

  test("en modo login no agrega token ni config propia", () => {
    const env = buildSessionEnv({ kind: "login" }, { PATH: "/bin", USER: "u" });
    expect(
      Object.keys(env).filter((k) => (SECRET_ENV_VARS as readonly string[]).includes(k)),
    ).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  // Si regresiona, un run lanzado sin USER, como desde el panel de Orca, falla con «Not logged in»:
  // Claude Code busca su sesión del Keychain con la cuenta de USER.
  test("completa USER cuando el lanzador no lo pasa", () => {
    const login = { kind: "login" } as const;
    expect(buildSessionEnv(login, { PATH: "/bin", USER: "u", LOGNAME: "l" }).USER).toBe("u");
    expect(buildSessionEnv(login, { PATH: "/bin", LOGNAME: "l" }).USER).toBe("l");
    expect(buildSessionEnv(login, { PATH: "/bin", HOME: "/h" }).USER).toBe(userInfo().username);
  });
});
