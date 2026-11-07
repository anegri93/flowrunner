import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { simQuery, type SimScript } from "../../test/helpers/sim-sdk.ts";
import type { Plan, Subtask } from "../gates/plan.ts";
import { readLog } from "../store/run-log.ts";
import { implementar } from "./implementar.ts";

const st = (id: string, alcance: string[], extra: Partial<Subtask> = {}): Subtask => ({
  id,
  titulo: `tarea ${id}`,
  descripcion: id,
  alcance,
  dependencias: [],
  depende_de: [],
  ...extra,
});

const planWith = (subtareas: Subtask[], criterios: Plan["criterios"] = []): Plan => ({
  plan: "plan",
  subtareas,
  criterios:
    criterios.length > 0
      ? criterios
      : [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: subtareas[0]?.id ?? "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
});

const TESTS = { "tests/ac1.mjs": "process.exit(1);\n" };
const write = (path: string, content: string) => ({
  tool: "Write",
  input: { file_path: path, content },
});

/** Elige el guion según la sub-task del prompt y cuántas veces se la llamó. */
function byUnit(scripts: Record<string, SimScript[]>) {
  const seen = new Map<string, number>();
  return (prompt: string): SimScript => {
    const id = /Sub-task (ST-\d+)/.exec(prompt)?.[1] ?? "";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    const list = scripts[id] ?? [{}];
    return list[Math.min(n, list.length - 1)] ?? {};
  };
}

const unitEvents = (dir: string) =>
  readLog(dir).events.flatMap((e) => (e.tipo === "unidad" ? [`${e.unidad}:${e.estado}`] : []));

describe("implementar", () => {
  // Si regresiona, las sub-tasks independientes corren de a una y el run tarda el doble.
  test("dos sub-tasks independientes corren a la vez y dejan un commit cada una, con su trailer", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/a/uno.js", "export const a = 1;\n")], delayMs: 300 }],
        "ST-2": [{ calls: [write("src/b/dos.js", "export const b = 2;\n")], delayMs: 300 }],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(sim.concurrency.max).toBe(2);
    const subjects = git(featureWt, "log", "--format=%s", "-3").split("\n");
    expect(subjects.slice(0, 2).sort()).toEqual([
      "feat: tarea ST-1 · ST-1",
      "feat: tarea ST-2 · ST-2",
    ]);
    expect(subjects[2]).toBe("test: criterios en rojo");
    const bodies = git(featureWt, "log", "--format=%B", "-2");
    expect(bodies).toContain("Flowrunner-Subtask: ST-1");
    expect(bodies).toContain("Flowrunner-Subtask: ST-2");
    // Historial lineal: ningún merge.
    expect(git(featureWt, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
  });

  // Si regresiona, un conflicto de integración tira abajo la sub-task en lugar de rehacerla.
  test("una sub-task que choca al integrarse se rehace una vez sobre la punta nueva y después integra", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/compartido.js", "export const x = 'uno';\n")] }],
        "ST-2": [
          { calls: [write("src/compartido.js", "export const x = 'dos';\n")], delayMs: 400 },
          {
            calls: [
              {
                tool: "Edit",
                input: {
                  file_path: "src/compartido.js",
                  old_string: "'uno'",
                  new_string: "'uno y dos'",
                },
              },
            ],
          },
        ],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/compartido.js"]), st("ST-2", ["src/compartido.js"])]),
      TESTS,
      deps,
      { files: { "src/compartido.js": "export const x = 'base';\n" } },
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(readFileSync(join(featureWt, "src/compartido.js"), "utf8")).toBe(
      "export const x = 'uno y dos';\n",
    );
    expect(unitEvents(run.dir).filter((e) => e.startsWith("ST-2"))).toEqual([
      "ST-2:iniciada",
      "ST-2:commiteada",
      "ST-2:iniciada",
      "ST-2:commiteada",
      "ST-2:integrada",
    ]);
    const secondPrompt =
      sim.records.filter((r) => r.prompt.includes("Sub-task ST-2"))[1]?.prompt ?? "";
    expect(secondPrompt).toMatch(/chocó al integrarse.*src\/compartido\.js/);
  });

  // Si regresiona, un test que escribe archivos como efecto lateral cuela cambios fuera del alcance.
  test("una sub-task que viola el doble control no se commitea y reintenta con el motivo", async () => {
    const sideEffect =
      'import { writeFileSync } from "node:fs";\nwriteFileSync("src/generado.txt", "x");\nprocess.exit(1);\n';
    const sim = simQuery(
      byUnit({
        "ST-1": [
          {
            calls: [
              write("src/a/uno.js", "export {};\n"),
              { tool: "Bash", input: { command: "node tests/ac1.mjs" } },
            ],
          },
          { calls: [write("src/a/uno.js", "export {};\n")] },
        ],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/a/"])]),
      { "tests/ac1.mjs": sideEffect },
      deps,
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(unitEvents(run.dir)).toEqual([
      "ST-1:iniciada",
      "ST-1:iniciada",
      "ST-1:commiteada",
      "ST-1:integrada",
    ]);
    expect(sim.records[1]?.prompt).toMatch(/src\/generado\.txt está fuera del alcance de ST-1/);
    expect(git(featureWt, "show", "--stat", "--format=", "HEAD")).not.toContain("generado");
  });

  test("una sub-task que falla definitivamente no corta la otra, que se integra", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/fuera.js", "x")] }],
        "ST-2": [{ calls: [write("src/b/dos.js", "export {};\n")], delayMs: 200 }],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    const outcome = await implementar(contextFor(run, "implementar", deps));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/ST-1 no salió en 3 intentos/);
    expect(unitEvents(run.dir)).toContain("ST-2:integrada");
    expect(unitEvents(run.dir)).toContain("ST-1:fallida");
  });

  test("devuelto por verificar: rehace solo las sub-tasks nombradas, con el motivo", async () => {
    const sim = simQuery(
      byUnit({ "ST-2": [{ calls: [write("src/b/dos.js", "export const b = 3;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    const outcome = await implementar(
      contextFor(run, "implementar", deps, {
        unidades: ["ST-2"],
        instruccion: "AC-2 sigue rojo: esperaba 403",
      }),
    );
    expect(outcome).toEqual({ tipo: "ok" });
    expect(sim.records).toHaveLength(1);
    expect(sim.records[0]?.prompt).toContain("AC-2 sigue rojo: esperaba 403");
  });
});
