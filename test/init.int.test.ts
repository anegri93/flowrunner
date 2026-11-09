// flowrunner init: infiere la config de un repo real, comprueba la base y, con --aplicar, deja la
// máquina y el repo listos. Con repos en tmpdir, el gh y el claude falsos, y un HOME de prueba.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { runCli, TEST_BIN } from "./helpers/cli.ts";
import { git, repoWithRemote, tempDir } from "./helpers/git.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { SIM_HOOKS } from "./helpers/sim-world.ts";

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

/** El borrador que redacta la sesión simulada: cita archivos del repo de prueba. */
function draftScript(fuente = "servidor/api.ts"): SimScript {
  return {
    match: "Sos el que arma el cerebro",
    calls: [{ tool: "Read", input: { file_path: "servidor/api.ts" } }],
    output: {
      convenciones: {
        texto: "- Los errores de la API salen como `ErrorDeApi`, como en `servidor/api.ts`.",
        fuentes: [fuente],
      },
      contexto: {
        texto: "### Qué reusar antes de escribir\n\n- `servidor/api.ts`: el cliente HTTP.",
        fuentes: ["servidor/api.ts"],
      },
      que_es_bien: {
        texto: "- Cada endpoint nuevo trae su test al lado, como `servidor/api.test.ts`.",
        fuentes: ["servidor/api.test.ts"],
      },
    },
  };
}

function world(testScript = "node -e 0", draft = draftScript()) {
  const { work, remote } = repoWithRemote({
    "package.json": JSON.stringify({ name: "pizarra", scripts: { test: testScript } }),
    "package-lock.json": LOCK,
    "vitest.config.ts": "export default {};\n",
    "servidor/api.ts": "export class ErrorDeApi extends Error {}\n",
    "servidor/api.test.ts": "// test\n",
  });
  const scripts = join(tempDir("init-guiones-"), "guiones.json");
  writeFileSync(scripts, JSON.stringify([draft]));
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
    // El SDK simulado: la sesión del borrador corre de verdad, con el guion de `draft`.
    FLOWRUNNER_TEST_HOOKS: SIM_HOOKS,
    FAKE_SIM_SCRIPTS: scripts,
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
const brainFile = (remote: string, file: string) =>
  git(remote, "show", `chore/flowrunner-init:.flowrunner/${file}`);
const template = (file: string) =>
  readFileSync(join(import.meta.dirname, "..", "templates", "brain", file), "utf8").trimEnd();
const prBody = (env: NodeJS.ProcessEnv) =>
  (
    JSON.parse(readFileSync(join(env.FAKE_LOG_DIR ?? "", "gh-state.json"), "utf8")) as {
      prs: { body: string }[];
    }
  ).prs[0]?.body ?? "";

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
    // Si regresiona, mirar el informe cuesta una sesión del modelo.
    expect(existsSync(join(w.home, "prompts.log"))).toBe(false);
  }, 120_000);

  // Si regresiona, el cerebro llega vacío y los runs no siguen la lógica que el repo ya tiene.
  test("con --aplicar redacta convenciones, contexto y qué es bien con lo que leyó del repo", () => {
    const w = world();
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(paso(out.stdout, "borrador del cerebro")).toMatchObject({ estado: "inferido" });

    const convenciones = brainFile(w.remote, "convenciones.md");
    expect(convenciones.startsWith(template("convenciones.md"))).toBe(true);
    expect(convenciones).toContain("## Borrador de flowrunner init");
    expect(convenciones).toContain("Los errores de la API salen como `ErrorDeApi`");
    expect(convenciones).toContain("Fuentes: `servidor/api.ts`");
    expect(brainFile(w.remote, "contexto.md")).toContain("### Qué reusar antes de escribir");
    expect(brainFile(w.remote, "que-es-bien.md")).toContain("como `servidor/api.test.ts`");
    expect(prBody(w.env)).toContain("traen un borrador que init dedujo");

    // La sesión recibió el repo real: sus archivos y sus commits.
    const prompt = readFileSync(join(w.home, "prompts.log"), "utf8");
    expect(prompt).toContain("Sos el que arma el cerebro");
    expect(prompt).toContain("servidor/api.ts");
    expect(prompt).toContain("inicial");
  }, 120_000);

  // Si regresiona, la PR del cerebro afirma reglas sobre archivos que no existen en el repo.
  test("si el borrador cita un archivo que no existe, quedan las plantillas y la PR igual se abre", () => {
    const w = world("node -e 0", draftScript("servidor/inventado.ts"));
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(paso(out.stdout, "borrador del cerebro")).toMatchObject({ estado: "pendiente" });
    expect(paso(out.stdout, "borrador del cerebro")?.detalle).toContain("servidor/inventado.ts");
    for (const file of ["convenciones.md", "contexto.md", "que-es-bien.md"]) {
      expect(brainFile(w.remote, file)).toBe(template(file));
    }
    expect(paso(out.stdout, "PR del cerebro")?.detalle).toMatch(/pull\/412/);
    expect(prBody(w.env)).toContain("completá `contexto.md`");
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
