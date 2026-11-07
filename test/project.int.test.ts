// T2.2: registrar un repo y escribirle el cerebro con el CLI real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli, TEST_BIN } from "./helpers/cli.ts";
import { repoWith, tempDir } from "./helpers/git.ts";

function bareHome(): NodeJS.ProcessEnv {
  return {
    HOME: tempDir("flowrunner-home-"),
    PATH: `${TEST_BIN}:${process.env.PATH ?? ""}`,
    USER: process.env.USER ?? "test",
  };
}

describe("project add y brain init", () => {
  // Si regresiona, aprender no sabe de quién son las correcciones y aprende de cualquiera.
  test("sin config global, project add exige el usuario de GitHub", () => {
    const result = runCli(["project", "add", repoWith({ "a.txt": "x\n" })], bareHome());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--github-user/);
  });

  test("brain init deja un repo que project add da por listo", () => {
    const env = bareHome();
    const repo = repoWith({ "a.txt": "x\n" });
    const first = JSON.parse(
      runCli(["project", "add", repo, "--github-user", "yo", "--json"], env).stdout,
    ) as { faltan: string[] };
    expect(first.faltan.length).toBeGreaterThan(0);
    const init = JSON.parse(runCli(["brain", "init", repo, "--json"], env).stdout) as {
      creados: string[];
    };
    expect(init.creados).toContain(".flowrunner/verify.sh");
    const second = JSON.parse(runCli(["project", "add", repo, "--json"], env).stdout) as {
      proyecto: string;
      faltan: string[];
    };
    expect(second.faltan).toEqual([]);
    const config = readFileSync(join(env.HOME ?? "", ".flowrunner", "config.yaml"), "utf8");
    expect(config).toContain("github_user: yo");
    expect(config.match(new RegExp(`name: ${second.proyecto}`, "g"))).toHaveLength(1);
  });
});
