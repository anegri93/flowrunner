// T8.1: la skill de consola y sus reglas ask en ~/.claude/settings.json, con un HOME de prueba.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli, TEST_BIN } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";

const SKILL = join(import.meta.dirname, "..", "skills", "flowrunner", "SKILL.md");

function home(settings?: object): NodeJS.ProcessEnv {
  const dir = tempDir("skill-home-");
  if (settings !== undefined) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings));
  }
  return { HOME: dir, PATH: `${TEST_BIN}:${process.env.PATH ?? ""}` };
}
const settingsOf = (env: NodeJS.ProcessEnv) =>
  JSON.parse(readFileSync(join(env.HOME ?? "", ".claude", "settings.json"), "utf8")) as {
    permissions: { allow?: string[]; ask: string[] };
    model?: string;
  };

describe("skill install", () => {
  test("el frontmatter de la skill tiene nombre y descripción válidos", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(SKILL, "utf8"))?.[1] ?? "";
    const schema = z.strictObject({
      name: z.literal("flowrunner"),
      description: z.string().min(40).max(1024),
    });
    expect(schema.safeParse(parse(front)).success).toBe(true);
  });

  // Si regresiona, Claude podría aprobar un plan sin preguntarte, o pisar tus permisos.
  test("con permisos propios, --confirmar los conserva y agrega las dos reglas ask", () => {
    const env = home({
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"], ask: ["Bash(rm:*)"] },
    });
    expect(runCli(["skill", "install", "--confirmar"], env).status).toBe(0);
    const s = settingsOf(env);
    expect(s.model).toBe("opus");
    expect(s.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(s.permissions.ask).toEqual([
      "Bash(rm:*)",
      "Bash(flowrunner approve:*)",
      "Bash(flowrunner changes:*)",
    ]);
    expect(existsSync(join(env.HOME ?? "", ".claude", "skills", "flowrunner", "SKILL.md"))).toBe(
      true,
    );
  });

  test("correrlo dos veces no duplica las reglas", () => {
    const env = home({});
    runCli(["skill", "install", "--confirmar"], env);
    runCli(["skill", "install", "--confirmar"], env);
    expect(settingsOf(env).permissions.ask).toEqual([
      "Bash(flowrunner approve:*)",
      "Bash(flowrunner changes:*)",
    ]);
  });

  test("sin --confirmar no toca settings.json y dice qué agregaría", () => {
    const env = home({ permissions: { ask: [] } });
    const before = readFileSync(join(env.HOME ?? "", ".claude", "settings.json"), "utf8");
    const out = runCli(["skill", "install"], env);
    expect(out.stdout).toContain("Bash(flowrunner approve:*)");
    expect(readFileSync(join(env.HOME ?? "", ".claude", "settings.json"), "utf8")).toBe(before);
  });
});
