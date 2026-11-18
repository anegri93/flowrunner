import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TEST_BIN } from "../../test/helpers/cli.ts";
import { git, tempDir } from "../../test/helpers/git.ts";
import { PLAN } from "../../test/helpers/plan-fixtures.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import type { NewEvent } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import type { RunPaths } from "../runner/types.ts";
import { entregar } from "./entregar.ts";
import { decide, leaseDe, traerLaRama, type FeedbackDecision } from "./feedback.ts";
import { readPlan } from "./planificar.ts";

const run: RunPaths = { id: "R1", home: "/h", dir: "/h/runs/R1", worktrees: "/h/worktrees/R1" };
const IDS = ["ST-1", "ST-2"];
const FEEDBACK = "el CSV tiene que separar con punto y coma";

function decideWith(d: Partial<FeedbackDecision>) {
  const emitted: NewEvent[] = [];
  const outcome = decide(
    {
      run,
      emit: (e) => {
        emitted.push(e);
        return { ...e, at: "2026-11-17T10:00:00.000Z" };
      },
    },
    FEEDBACK,
    { desde: "planificar", unidades: [], instruccion: "cambiar", por_que: "porque sí", ...d },
    IDS,
  );
  return { outcome, emitted };
}

// Si regresiona, lo que la sesión decidió no llega al engine, o llega sin tu feedback.
test("implementar con sub-tasks del plan reentra en implementar con tu feedback y su por qué", () => {
  const { outcome, emitted } = decideWith({
    desde: "implementar",
    unidades: ["ST-2", "ST-2"],
    instruccion: "ST-2: usar ; en src/export/csv.ts",
    por_que: "el separador vive en ST-2",
  });
  expect(outcome).toMatchObject({
    tipo: "reentrar",
    desde: "implementar",
    unidades: ["ST-2"],
    por_que: "el separador vive en ST-2",
  });
  expect(outcome.tipo === "reentrar" && outcome.instruccion).toContain(FEEDBACK);
  expect(outcome.tipo === "reentrar" && outcome.instruccion).toContain("ST-2: usar ;");
  expect(emitted).toContainEqual(
    expect.objectContaining({
      tipo: "decision",
      que: "tu feedback: rehacer ST-2 desde implementar",
      por_que: "el separador vive en ST-2",
    }),
  );
});

// Si regresiona, una respuesta inventada del modelo corre sub-tasks que no existen o el plan entero.
test("implementar sin sub-tasks válidas replanifica, que pasa por tu aprobación, con un aviso", () => {
  for (const unidades of [[], ["ST-9"]]) {
    const { outcome, emitted } = decideWith({ desde: "implementar", unidades });
    expect(outcome).toMatchObject({ tipo: "reentrar", desde: "planificar" });
    expect(emitted.some((e) => e.tipo === "aviso" && /se replanifica/.test(e.texto))).toBe(true);
  }
});

// Si regresiona, un feedback que cambia la feature se rehace sin preguntarte.
test("un feedback que cambia la feature se detiene a preguntar y dice cómo replanificar", () => {
  const { outcome } = decideWith({ desde: "feature", instruccion: "la feature pide CSV" });
  expect(outcome.tipo).toBe("pregunta");
  expect(outcome.tipo === "pregunta" && outcome.motivo).toContain(
    "flowrunner rerun R1 --desde planificar",
  );
  // tick no mira un run detenido: si la persona mergea igual, la detención dice cómo aprender.
  expect(outcome.tipo === "pregunta" && outcome.motivo).toContain(
    "Si la mergeás igual: flowrunner rerun R1 --desde aprender",
  );
});

// Si regresiona, la persona corrige un test de criterios en la rama de la PR, lo trae el feedback, y
// verificar detiene el run porque el test bloqueado «cambió a mano»; o la entrega siguiente no sabe
// qué vio en GitHub y puede pisar un push posterior.
test("traer la rama re-bloquea los tests que corrigió la persona y guarda lo que vio en GitHub", async () => {
  const home = tempDir("gh-home-");
  const deps = testDeps({
    env: { ...testDeps().env, HOME: home, PATH: `${TEST_BIN}:${process.env.PATH ?? ""}` },
  });
  const { run, featureWt, work } = await plannedRun(
    PLAN,
    { "tests/ac1.mjs": "process.exit(0);\n" },
    deps,
  );
  await entregar(contextFor(run, "entregar", deps));
  const branch = "feat/SHOP-214-exportar-pedidos-a-csv";
  const persona = tempDir("persona-");
  git(persona, "clone", "-q", "-b", branch, git(work, "remote", "get-url", "origin"), ".");
  const nuevo = "process.exit(process.argv.length > 0 ? 0 : 1);\n";
  writeFileSync(join(persona, "tests/ac1.mjs"), nuevo);
  git(persona, "commit", "-qam", "corrijo el test");
  git(persona, "push", "-q", "origin", branch);
  const tuyo = git(persona, "rev-parse", "HEAD");

  expect(await traerLaRama(contextFor(run, "aprender", deps), featureWt)).toBeUndefined();
  expect(git(featureWt, "rev-parse", "HEAD")).toBe(tuyo);
  expect(readPlan(run).locked["tests/ac1.mjs"]).toBe(
    createHash("sha256").update(nuevo).digest("hex"),
  );
  expect(readLog(run.dir).events.findLast((e) => e.tipo === "aviso")).toMatchObject({
    texto: expect.stringContaining("tests/ac1.mjs") as unknown,
  });
  expect(leaseDe(run)).toBe(tuyo);
});
