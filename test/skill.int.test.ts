// T8.1: la skill de consola y sus reglas ask en ~/.claude/settings.json, con un HOME de prueba.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { skillUpToDate } from "../src/cli/skill.ts";
import { BIN, runCli, TEST_BIN } from "./helpers/cli.ts";
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
    hooks?: Record<string, { hooks: { type: string; command: string }[] }[]>;
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
  test("con permisos propios, --confirmar los conserva y agrega las reglas ask", () => {
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
      "Bash(flowrunner accept-untested:*)",
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
      "Bash(flowrunner accept-untested:*)",
    ]);
  });

  test("sin --confirmar no toca settings.json y dice qué agregaría", () => {
    const env = home({ permissions: { ask: [] } });
    const before = readFileSync(join(env.HOME ?? "", ".claude", "settings.json"), "utf8");
    const out = runCli(["skill", "install"], env);
    expect(out.stdout).toContain("Bash(flowrunner approve:*)");
    expect(readFileSync(join(env.HOME ?? "", ".claude", "settings.json"), "utf8")).toBe(before);
  });

  // Si regresiona, una sesión nueva en un repo con flowrunner no se entera y hace las features a mano.
  test("--confirmar agrega el hook SessionStart de flowrunner, conserva los propios y no lo duplica", () => {
    const env = home({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo mio" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo fin" }] }],
      },
    });
    runCli(["skill", "install", "--confirmar"], env);
    runCli(["skill", "install", "--confirmar"], env);
    const hooks = settingsOf(env).hooks ?? {};
    expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo fin" }] }]);
    const commands = (hooks.SessionStart ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands[0]).toBe("echo mio");
    expect(commands.filter((c) => c.includes("hook session-start"))).toEqual([
      `'${BIN}' hook session-start`,
    ]);
  });

  // Si regresiona, init da por instalada una skill vieja y la sesión sigue con las instrucciones de antes.
  test("skillUpToDate: recién instalada, sí; con el SKILL.md cambiado o sin el hook, no", () => {
    const env = home({});
    expect(skillUpToDate(env)).toBe(false);
    runCli(["skill", "install", "--confirmar"], env);
    expect(skillUpToDate(env)).toBe(true);
    appendFileSync(
      join(env.HOME ?? "", ".claude", "skills", "flowrunner", "SKILL.md"),
      "\nvieja\n",
    );
    expect(skillUpToDate(env)).toBe(false);
    runCli(["skill", "install", "--confirmar"], env);
    const file = join(env.HOME ?? "", ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete settings.hooks;
    writeFileSync(file, JSON.stringify(settings));
    expect(skillUpToDate(env)).toBe(false);
  });
});
