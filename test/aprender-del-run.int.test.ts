// Gate de la Fase 3 de flowrunner 2.0: aprender de todo el run, no solo de lo que salió mal. Con el CLI
// real, las fases reales, el SDK simulado y el gh falso: un run sin vueltas donde el que implementa anota
// un descubrimiento llega a la PR con su lección propuesta, y al mergear aprender la pasa a
// lecciones.md con su número y para quién es.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DESCUBRIMIENTO_TOOL } from "../src/phases/descubrimientos.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { BRANCH } from "./helpers/delivered.ts";
import { git, tempDir } from "./helpers/git.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

const ORIGEN = "implementar ST-1, descubrimiento 1";

// Si regresiona, alguna pieza de la Fase 3 no encaja con las otras: el descubrimiento no queda como
// evento, proponer no lo ve porque el run no tuvo vueltas, la lección no dice para quién es, o aprender
// la pierde al numerarla.
test("un descubrimiento sin vueltas llega a la PR como lección y, al mergear, a lecciones.md con su Para", async () => {
  const w = simWorld({
    real: [
      "preparar",
      "planificar",
      "aprobar",
      "implementar",
      "verificar",
      "revisar",
      "entregar",
      "aprender",
    ],
    scripts: [
      { match: "Sos el planificador", calls: [WRITE_TEST], output: PLAN },
      {
        match: "Sub-task ST-1",
        calls: [
          {
            tool: "Write",
            input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
          },
          {
            tool: DESCUBRIMIENTO_TOOL,
            mcp: true,
            input: {
              que: "el CSV necesita un salto de línea final",
              donde: "src/export/csv.js:1",
              como: "el test de aceptación comparaba el archivo entero",
            },
          },
        ],
      },
      { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
      {
        match: "Sos el que aprende de lo que le costó",
        output: {
          lecciones: [
            {
              titulo: "Los CSV terminan con un salto de línea",
              regla: "Cerrar todo CSV con \\n.",
              aplica: "src/export/",
              para: "codigo",
              origen: ORIGEN,
            },
          ],
        },
      },
    ],
    feature: FEATURE,
    project: { config: { setup: "true", tests_globs: ["tests/**"], aprobar: "si_hace_falta" } },
  });
  const id = w.launch();
  await waitFor("entregado", () => ["entregado", "detenido"].includes(w.state(id).status), 120_000);
  expect(w.state(id).halt?.motivo).toBeUndefined();

  const events = readLog(w.dir(id)).events;
  expect(events).toContainEqual(
    expect.objectContaining({
      tipo: "descubrimiento",
      unidad: "ST-1",
      donde: "src/export/csv.js:1",
    }),
  );
  expect(events.some((e) => e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve")).toBe(
    false,
  );
  const propuestas = git(w.remote, "show", `${BRANCH}:.flowrunner/propuestas/SHOP-214.md`);
  expect(propuestas).toContain("Para: código");
  expect(propuestas).toContain(ORIGEN);

  // El merge: la rama de la feature entra a main en el remote, y gh dice que la PR se mergeó.
  const clone = join(tempDir(), "c");
  execFileSync("git", ["clone", "-q", w.remote, clone]);
  git(clone, "merge", "-q", "--no-ff", `origin/${BRANCH}`, "-m", "Merge PR 412");
  git(clone, "push", "-q", "origin", "main");
  const stateFile = join(w.env.HOME ?? "", "gh-state.json");
  const gh = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: { state: string }[] };
  for (const pr of gh.prs) pr.state = "MERGED";
  writeFileSync(stateFile, JSON.stringify(gh));

  expect(runCli(["learn", id], w.env).stdout).toContain("quedó cerrado");
  const lecciones = git(w.remote, "show", "chore/lecciones-SHOP-214:.flowrunner/lecciones.md");
  expect(lecciones).toMatch(/### L-\d+ · Los CSV terminan con un salto de línea/);
  expect(lecciones).toContain("Para: código");
}, 240_000);
