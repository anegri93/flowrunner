import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadGlobalConfig, loadRepoConfig } from "./load.ts";
import { ConfigError, DEFAULT_MODELS } from "./schemas.ts";

function repoWithConfig(yaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-cfg-"));
  mkdirSync(join(repo, ".flowrunner"));
  writeFileSync(join(repo, ".flowrunner", "config.yaml"), yaml);
  return repo;
}

function homeWithConfig(yaml: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "fr-home-"));
  mkdirSync(join(home, ".flowrunner"));
  writeFileSync(join(home, ".flowrunner", "config.yaml"), yaml);
  return { HOME: home };
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.map((p) => `${p.where}: ${p.message}`);
    throw error;
  }
  throw new Error("se esperaba un ConfigError");
}

const MINIMAL = "setup: pnpm install\ntests_globs: [tests/**]\n";

describe("config del repo", () => {
  // Si regresiona, un typo en la config hace que flowrunner ignore el campo en silencio.
  test("un campo desconocido es un error que lo nombra", () => {
    const problems = problemsOf(() => loadRepoConfig(repoWithConfig(`${MINIMAL}max_paralel: 2\n`)));
    expect(problems.join("\n")).toMatch(/campo desconocido: max_paralel/);
  });

  // Si regresiona, una fase corre con un modelo inexistente y el run falla recién en el SDK.
  test("un modelo o effort inexistente es un error con la fase", () => {
    const problems = problemsOf(() =>
      loadRepoConfig(
        repoWithConfig(`${MINIMAL}models:\n  revisar: { model: gpt-4, effort: altisimo }\n`),
      ),
    );
    expect(problems.some((p) => p.includes("models › revisar › model"))).toBe(true);
    expect(problems.some((p) => p.includes("models › revisar › effort"))).toBe(true);
  });

  // Si regresiona, el programador de sub-tasks nunca arranca ninguna.
  test("max_parallel menor que 1 es un error", () => {
    const problems = problemsOf(() =>
      loadRepoConfig(repoWithConfig(`${MINIMAL}max_parallel: 0\n`)),
    );
    expect(problems.join("\n")).toMatch(/max_parallel/);
  });

  // Si regresiona, un repo sin cambios en la config corre con valores distintos a los documentados.
  test("una config mínima recibe los defaults, y un modelo cambiado no pisa los demás", () => {
    const config = loadRepoConfig(
      repoWithConfig(
        `${MINIMAL}models:\n  revisar: { model: claude-sonnet-5-5, effort: medium }\n`,
      ),
    );
    expect(config.base_branch).toBe("main");
    expect(config.verify).toBe(".flowrunner/verify.sh");
    expect(config.max_parallel).toBe(3);
    expect(config.budget).toBeUndefined();
    expect(config.models.revisar).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(config.models.planificar).toEqual(DEFAULT_MODELS.planificar);
  });

  // Si regresiona, un repo que no tocó nada paga una sesión de exploración más por run, o el explorador
  // vuelve a ser Haiku y su informe queda corto: Opus vuelve a leer lo que el informe tenía que darle.
  test("explorar_antes viene apagado y el explorador usa Sonnet por defecto", () => {
    const config = loadRepoConfig(repoWithConfig(MINIMAL));
    expect(config.explorar_antes).toBe(false);
    expect(config.models.explorar).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  test("varios problemas a la vez llegan todos juntos", () => {
    const problems = problemsOf(() =>
      loadRepoConfig(repoWithConfig("tests_globs: []\nverify: ../fuera.sh\nmax_parallel: 0\n")),
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  test("un repo sin .flowrunner/config.yaml sugiere brain init", () => {
    const repo = mkdtempSync(join(tmpdir(), "fr-cfg-"));
    expect(problemsOf(() => loadRepoConfig(repo)).join("\n")).toMatch(/brain init/);
  });
});

describe("config global", () => {
  // Si regresiona, dos proyectos con el mismo nombre resuelven a un repo cualquiera.
  test("un proyecto repetido es un error", () => {
    const env = homeWithConfig(
      "github_user: yo\nprojects:\n  - { name: api, path: /a }\n  - { name: api, path: /b }\n",
    );
    expect(problemsOf(() => loadGlobalConfig(env)).join("\n")).toMatch(/"api" está repetido/);
  });

  test("tick_minutes vale 10 por defecto y ~ se expande al HOME", () => {
    const env = homeWithConfig("github_user: yo\nprojects:\n  - { name: api, path: ~/code/api }\n");
    const config = loadGlobalConfig(env);
    expect(config.tick_minutes).toBe(10);
    expect(config.projects[0]?.path).toBe(join(env.HOME ?? "", "code", "api"));
  });
});
