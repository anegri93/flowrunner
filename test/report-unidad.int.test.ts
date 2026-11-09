// `flowrunner report <run> --unidad ST-n`: lo que el panel de Orca abre al tocar una sub-task.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { showUnit } from "../src/cli/report.ts";
import { commitAll } from "../src/git/git.ts";
import { appendEvent } from "../src/store/run-log.ts";
import { plannedRun } from "./helpers/planned.ts";
import { PLAN } from "./helpers/plan-fixtures.ts";
import { testDeps, writeFiles } from "./helpers/project.ts";

const TESTS = { "tests/ac1.mjs": "process.exit(1);\n" };
const said = (text: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;

describe("report --unidad", () => {
  // Si regresiona, tocar una sub-task terminada en el panel no muestra lo que cambió, o muestra el
  // diff de otra sub-task o de un plan anterior.
  test("una sub-task integrada trae su plan, lo último que dijo y el diff de su commit", async () => {
    const deps = testDeps();
    const { run, featureWt } = await plannedRun(PLAN, TESTS, deps);
    writeFiles(featureWt, { "src/export/csv.js": "export const csv = () => 'a,b';\n" });
    const sha = await commitAll(featureWt, "feat: Serializador CSV · ST-1", {}, deps.env);
    if (sha === undefined) throw new Error("sin commit");
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "iniciada",
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "integrada",
      sha,
    });
    mkdirSync(join(run.dir, "sesiones"), { recursive: true });
    writeFileSync(join(run.dir, "sesiones", "implementar-ST-1-1.jsonl"), said("primer intento"));
    writeFileSync(
      join(run.dir, "sesiones", "implementar-ST-1-2.jsonl"),
      said("Agregué el serializador en src/export/csv.js."),
    );
    // Una sesión de ST-10 no se confunde con las de ST-1.
    writeFileSync(join(run.dir, "sesiones", "implementar-ST-10-3.jsonl"), said("otra sub-task"));

    const unit = await showUnit(run.home, run.id, "ST-1", deps.env);

    expect(unit).toMatchObject({ estado: "integrada", intentos: 1, commits: [sha] });
    expect(unit.texto).toContain("# SHOP-214 · ST-1 Serializador CSV");
    expect(unit.texto).toContain("AC-1 `node tests/ac1.mjs`");
    expect(unit.texto).toContain("Agregué el serializador en src/export/csv.js.");
    expect(unit.texto).toContain("src/export/csv.js | 1 +");
    expect(unit.texto).toContain("+export const csv = () => 'a,b';");
    // El commit de los tests en rojo es anterior a la sub-task: no es parte de su diff.
    expect(unit.texto).not.toContain("tests/ac1.mjs |");
  });

  // Si regresiona, después de pedir cambios al plan la sub-task muestra commits que ya no están en
  // la rama de la feature.
  test("lo integrado antes del último plan no cuenta, y sin commits lo dice", async () => {
    const deps = testDeps();
    const { run } = await plannedRun(PLAN, TESTS, deps);
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "integrada",
      sha: "0".repeat(40),
    });
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });

    const unit = await showUnit(run.home, run.id, "ST-1", deps.env);

    expect(unit).toMatchObject({ estado: "pendiente", intentos: 0, commits: [] });
    expect(unit.texto).toContain("Todavía no hay cambios integrados.");
    expect(unit.texto).toContain("Todavía no hay una sesión de esta sub-task.");
  });

  test("una sub-task que no está en el plan dice cómo verlo", async () => {
    const { run } = await plannedRun(PLAN, TESTS, testDeps());
    await expect(showUnit(run.home, run.id, "ST-9", process.env)).rejects.toThrow(
      `el plan de ${run.id} no tiene ST-9`,
    );
    await expect(showUnit(run.home, run.id, "../x", process.env)).rejects.toThrow(
      "sub-task inválida",
    );
  });
});
