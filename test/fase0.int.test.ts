// Gate de la Fase 0: el CLI real valida una feature contra el proyecto y la config de su repo.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const SIN_PROBAR =
  "el repo no tiene `probar` en .flowrunner/config.yaml: la fase probar se va a saltear y ningún criterio se va a probar en la app. Para que pruebe, agregá cómo levantar el entorno (README, «Probar la feature en el entorno»)";

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

  // Si regresiona, feature check no lee el package.json del repo, o no ve sus binarios locales, y los
  // avisos de scripts faltan o sobran. AC-2 además solo pide el typecheck del repo (ADR 0027).
  test("feature check avisa un script que no está en el package.json del repo, y no un binario local", () => {
    const { repo, env, feature } = setup();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(repo, "node_modules", ".bin", "tsc"), "");
    writeFileSync(
      feature,
      FEATURE.replace(
        "- AC-1: GET /pedidos.csv devuelve text/csv.",
        "- AC-1: `npm run mac` levanta el trabajador.\n- AC-2: `pnpm tsc --noEmit` pasa.",
      ),
    );
    const result = runCli(["feature", "check", feature, "--json"], env);
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { avisos: string[] }).avisos).toEqual([
      'AC-1 usa `npm run mac`, y el package.json del repo no tiene el script "mac". Si la feature lo crea, el plan tiene que poner package.json en el alcance de una sub-task; si no, el criterio no se puede cumplir',
      "AC-2 solo pide que el repo pase sus chequeos: eso ya lo corre verificar en cada vuelta, y probar no puede correr comandos, así que el criterio sobra y frena el run. Sacalo; si a .flowrunner/verify.sh le falta un chequeo, sumáselo ahí",
      SIN_PROBAR,
    ]);
  });

  // Si regresiona, una feature se lanza sin saber que probar se va a saltear, y la PR llega sin
  // que nadie la haya probado en la app.
  test("feature check avisa que probar se saltea si el repo no lo configura, y calla si lo configura", () => {
    const { repo, env, feature } = setup();
    const avisos = () =>
      (
        JSON.parse(runCli(["feature", "check", feature, "--json"], env).stdout) as {
          avisos: string[];
        }
      ).avisos;
    expect(avisos()).toEqual([SIN_PROBAR]);
    writeFileSync(
      join(repo, ".flowrunner/config.yaml"),
      "setup: pnpm install\ntests_globs: [tests/**]\nprobar:\n  levantar: pnpm dev\n  urls: { web: http://localhost:5173 }\n",
    );
    expect(avisos()).toEqual([]);
  });

  // Si regresiona, una cita al código que la feature va a crear, o a una línea que ya no está, llega al
  // planificador como el código de hoy.
  test("feature check frena una cita de Contexto que no está en el repo y cuenta las que valen", () => {
    const { env, feature } = setup();
    const conContexto = (citas: string) =>
      FEATURE.replace("## Criterios", `## Contexto\n${citas}\n\n## Criterios`);
    writeFileSync(feature, conContexto("- src/index.ts:1 — exporta nada"));
    const ok = runCli(["feature", "check", feature], env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("1 citas de código en Contexto");
    writeFileSync(
      feature,
      conContexto("- src/index.ts:1-5 — exporta nada\n- src/nuevo.ts — lo que se va a crear"),
    );
    const mal = runCli(["feature", "check", feature], env);
    expect(mal.status).toBe(1);
    expect(mal.stderr).toContain("Contexto cita src/index.ts:1-5, pero el archivo tiene 1 líneas");
    expect(mal.stderr).toContain(
      "Contexto cita src/nuevo.ts, que no existe en el repo: las citas son del código de hoy",
    );
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
