// Gate de la Fase 0: el CLI real valida una feature contra el proyecto y la config de su repo.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { homeWith, runCli } from "./helpers/cli.ts";
import { repoWith, tempDir } from "./helpers/git.ts";

const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Un administrador descarga los pedidos como CSV.

## Criterios
- AC-1: GET /pedidos.csv devuelve text/csv.
`;

function setup() {
  const repo = repoWith({
    ".flowrunner/config.yaml": "setup: pnpm install\ntests_globs: [tests/**]\n",
    "src/index.ts": "export {};\n",
  });
  const env = homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${repo} }\n`);
  const feature = join(tempDir(), "SHOP-214.md");
  writeFileSync(feature, FEATURE);
  return { repo, env, feature };
}

describe("Fase 0 ensamblada", () => {
  // Si regresiona, la skill de consola no puede confiar en lo que le dice feature check.
  test("una feature válida resuelve su proyecto y la config del repo con defaults", () => {
    const { repo, env, feature } = setup();
    const result = runCli(["feature", "check", feature, "--json"], env);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      project: { path: string };
      repoConfig: { max_parallel: number; models: { planificar: { model: string } } };
      feature: { criterios: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.project.path).toBe(repo);
    expect(parsed.repoConfig.max_parallel).toBe(3);
    expect(parsed.repoConfig.models.planificar.model).toBe("claude-opus-5-5");
    expect(parsed.feature.criterios).toHaveLength(1);
  });

  test("un repo sin .flowrunner/config.yaml sale 1 con el motivo", () => {
    const { repo, env, feature } = setup();
    rmSync(join(repo, ".flowrunner"), { recursive: true });
    const result = runCli(["feature", "check", feature], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no tiene \.flowrunner\/config\.yaml/);
  });

  test("un proyecto que no está registrado sale 1 y dice cómo registrarlo", () => {
    const { feature } = setup();
    const env = homeWith("github_user: yo\nprojects: []\n");
    const result = runCli(["feature", "check", feature, "--json"], env);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { next: "flowrunner project add <ruta del repo>" },
    });
  });
});
