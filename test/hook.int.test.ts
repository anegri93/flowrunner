// El hook SessionStart de Claude Code: en un repo registrado en flowrunner, la sesión arranca sabiendo
// que las features van por flowrunner. En cualquier otro lado no dice nada.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { homeWith, runCli } from "./helpers/cli.ts";
import { repoWith } from "./helpers/git.ts";

const realPath = (dir: string) =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();

const hook = (cwd: string, env: NodeJS.ProcessEnv) =>
  runCli(["hook", "session-start"], env, JSON.stringify({ hook_event_name: "SessionStart", cwd }));

describe("hook session-start", () => {
  // Si regresiona, una sesión en un repo con flowrunner implementa features a mano sin usarlo.
  test("en un repo registrado, avisa que las features van por flowrunner, también desde una subcarpeta", () => {
    const repo = realPath(repoWith({ "src/a.ts": "export {};\n" }));
    const env = homeWith(`github_user: yo\nprojects:\n  - name: pizarra\n    path: ${repo}\n`);
    const out = hook(join(repo, "src"), env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("pizarra");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("skill `flowrunner`");
  });

  // Si regresiona, flowrunner se mete en sesiones de repos que no lo usan, o rompe el arranque.
  test("fuera de un repo registrado, o sin config, no dice nada y sale 0", () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const env = homeWith("github_user: yo\nprojects: []\n");
    expect(hook(repo, env)).toMatchObject({ status: 0, stdout: "" });
    const sinConfig = homeWith("");
    const noGit = join(sinConfig.HOME ?? "", "suelto");
    mkdirSync(noGit);
    expect(hook(noGit, { ...sinConfig, HOME: join(sinConfig.HOME ?? "", "otro") })).toMatchObject({
      status: 0,
      stdout: "",
    });
    expect(runCli(["hook", "session-start"], env, "no es json")).toMatchObject({
      status: 0,
      stdout: "",
    });
  });
});
