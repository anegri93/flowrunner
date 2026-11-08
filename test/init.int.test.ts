// flowrunner init: infiere la config de un repo real, comprueba la base y, con --aplicar, deja la
// máquina y el repo listos. Con repos en tmpdir, el gh y el claude falsos, y un HOME de prueba.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { runCli, TEST_BIN } from "./helpers/cli.ts";
import { git, repoWithRemote, tempDir } from "./helpers/git.ts";

const LOCK = JSON.stringify({
  name: "pizarra",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "pizarra" } },
});

const GRAFT_DIR = dirname(
  execFileSync("sh", ["-c", "command -v graft"], { encoding: "utf8" }).trim(),
);
const SYSTEM_BIN = [GRAFT_DIR, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

function world(testScript = "node -e 0") {
  const { work, remote } = repoWithRemote({
    "package.json": JSON.stringify({ name: "pizarra", scripts: { test: testScript } }),
    "package-lock.json": LOCK,
    "vitest.config.ts": "export default {};\n",
    "servidor/api.test.ts": "// test\n",
  });
  const home = tempDir("init-home-");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    // Un PATH armado a mano: el real puede tener un flowrunner ya instalado por la persona, y vitest
    // expone el propio en node_modules/.bin; en los dos casos init lo daría por instalado.
    PATH: [TEST_BIN, localBin, dirname(process.execPath), ...SYSTEM_BIN].join(":"),
    USER: process.env.USER ?? "test",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    FAKE_LOG_DIR: tempDir("init-logs-"),
    FLOWRUNNER_LAUNCH_AGENTS: tempDir("init-agents-"),
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  return { work, remote, home, env };
}

interface Paso {
  que: string;
  estado: string;
  detalle: string;
}
const pasos = (stdout: string) => (JSON.parse(stdout) as { pasos: Paso[] }).pasos;
const paso = (stdout: string, que: string) => pasos(stdout).find((p) => p.que === que);
const remoteBranches = (remote: string) => git(remote, "branch", "--format=%(refname:short)");

describe("init", () => {
  // Si regresiona, mirar el informe de init ya cambia la máquina o el repo de la persona.
  test("sin --aplicar infiere y comprueba la base, pero no escribe nada", () => {
    const w = world();
    const out = runCli(["init", w.work, "--json"], w.env);
    expect(out.stderr).toBe("");
    expect(paso(out.stdout, "setup")).toMatchObject({ estado: "inferido" });
    expect(paso(out.stdout, "setup")?.detalle).toContain("npm ci");
    expect(paso(out.stdout, "base en verde")).toMatchObject({ estado: "ok" });
    expect(paso(out.stdout, "auth")).toMatchObject({ estado: "inferido", detalle: "login" });
    expect(existsSync(join(w.home, ".flowrunner", "config.yaml"))).toBe(false);
    expect(
      existsSync(join(w.env.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist")),
    ).toBe(false);
    expect(existsSync(join(w.home, ".claude"))).toBe(false);
    expect(remoteBranches(w.remote)).toBe("main");
  }, 120_000);

  // Si regresiona, la persona tiene que hacer a mano los nueve pasos de la puesta en marcha.
  test("con --aplicar deja todo listo, y correrlo otra vez no duplica nada", () => {
    const w = world();
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);

    const config = parse(
      git(w.remote, "show", "chore/flowrunner-init:.flowrunner/config.yaml"),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      setup: "npm ci",
      tests_globs: ["servidor/**/*.test.ts"],
      harness_files: ["vitest.config.ts"],
    });
    expect(git(w.remote, "show", "chore/flowrunner-init:.flowrunner/verify.sh")).toContain(
      "npm run test",
    );
    expect(git(w.remote, "ls-tree", "chore/flowrunner-init", ".flowrunner/verify.sh")).toMatch(
      /^100755/,
    );
    const global = parse(readFileSync(join(w.home, ".flowrunner", "config.yaml"), "utf8")) as {
      github_user: string;
      auth: string;
      projects: { name: string; path: string }[];
    };
    expect(global.github_user).toBe("anegri93");
    expect(global.auth).toBe("login");
    expect(global.projects.map((p) => p.path)).toEqual([
      git(w.work, "rev-parse", "--show-toplevel"),
    ]);
    expect(
      existsSync(join(w.env.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist")),
    ).toBe(true);
    expect(existsSync(join(w.home, ".claude", "skills", "flowrunner", "SKILL.md"))).toBe(true);
    expect(paso(out.stdout, "comando flowrunner"), out.stdout).toMatchObject({ estado: "hecho" });
    expect(existsSync(join(w.home, ".local", "bin", "flowrunner"))).toBe(true);
    expect(paso(out.stdout, "PR del cerebro")?.detalle).toMatch(/pull\/412/);

    const again = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(again.status).toBe(0);
    const state = JSON.parse(
      readFileSync(join(w.env.FAKE_LOG_DIR ?? "", "gh-state.json"), "utf8"),
    ) as {
      prs: unknown[];
    };
    expect(state.prs).toHaveLength(1);
    const after = parse(readFileSync(join(w.home, ".flowrunner", "config.yaml"), "utf8")) as {
      projects: unknown[];
    };
    expect(after.projects).toHaveLength(1);

    // Una skill vieja, como la que deja un flowrunner anterior, se ve pendiente y --aplicar la renueva.
    appendFileSync(join(w.home, ".claude", "skills", "flowrunner", "SKILL.md"), "\nvieja\n");
    expect(
      paso(runCli(["init", w.work, "--json"], w.env).stdout, "skill de Claude Code"),
    ).toMatchObject({
      estado: "pendiente",
    });
    const renewed = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(paso(renewed.stdout, "skill de Claude Code")).toMatchObject({ estado: "hecho" });
  }, 180_000);

  // Si regresiona, init abre una PR sobre una base roja y el primer run se detiene en preparar.
  test("con la base en rojo, --aplicar sale 1 y no empuja nada", () => {
    const w = world("node -e 'process.exit(1)'");
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status).toBe(1);
    expect(paso(out.stdout, "base en verde")).toMatchObject({ estado: "falta" });
    // Si regresiona, la línea de la PR desaparece y nada dice que no se abrió.
    expect(paso(out.stdout, "PR del cerebro")).toMatchObject({
      estado: "pendiente",
      detalle: "no se abre hasta que origin/main esté en verde",
    });
    expect(remoteBranches(w.remote)).toBe("main");
  }, 120_000);

  test("si el cerebro ya está en la base, no lo infiere de nuevo", () => {
    const w = world();
    mkdirSync(join(w.work, ".flowrunner"), { recursive: true });
    execFileSync("sh", ["-c", "echo 'setup: \"true\"' > .flowrunner/config.yaml"], { cwd: w.work });
    git(w.work, "add", "-A");
    git(w.work, "commit", "-qm", "cerebro");
    git(w.work, "push", "-q", "origin", "main");
    const out = runCli(["init", w.work, "--json"], w.env);
    expect(paso(out.stdout, "cerebro del repo")).toMatchObject({ estado: "ya estaba" });
    expect(paso(out.stdout, "setup")).toBeUndefined();
  }, 120_000);
});
