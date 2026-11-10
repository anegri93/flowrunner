// Gate de la Fase 5: implementar y verificar reales en el runner, con el SDK simulado. Un criterio
// falla en la primera pasada, vuelve, se arregla y la rama queda verde.
import { describe, expect, test } from "vitest";
import type { Plan } from "../src/gates/plan.ts";
import { implementar } from "../src/phases/implementar.ts";
import { verificar } from "../src/phases/verificar.ts";
import { runUntilStop } from "../src/runner/runner.ts";
import type { PhaseFn, PhaseRegistry } from "../src/runner/types.ts";
import { PHASES } from "../src/store/events.ts";
import { readLog } from "../src/store/run-log.ts";
import { git } from "./helpers/git.ts";
import { plannedRun } from "./helpers/planned.ts";
import { testDeps } from "./helpers/project.ts";
import { simQuery, type SimScript } from "./helpers/sim-sdk.ts";

const plan: Plan = {
  plan: "tres sub-tasks",
  subtareas: [
    {
      id: "ST-1",
      titulo: "csv",
      descripcion: "csv",
      alcance: ["src/a/"],
      dependencias: [],
      depende_de: [],
    },
    {
      id: "ST-2",
      titulo: "permiso",
      descripcion: "403",
      alcance: ["src/b/"],
      dependencias: [],
      depende_de: [],
    },
    {
      id: "ST-3",
      titulo: "endpoint",
      descripcion: "api",
      alcance: ["src/c/"],
      dependencias: [],
      depende_de: ["ST-1"],
    },
  ],
  criterios: [
    { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
    { id: "AC-2", comando: "node tests/ac2.mjs", subtarea: "ST-2" },
    { id: "AC-3", comando: "node tests/ac3.mjs", subtarea: "ST-3" },
  ],
  tests: ["tests/ac1.mjs", "tests/ac2.mjs", "tests/ac3.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

const exists = (p: string) =>
  `import { existsSync } from "node:fs";\nprocess.exit(existsSync("${p}") ? 0 : 1);\n`;
const TESTS = {
  "tests/ac1.mjs": exists("src/a/csv.js"),
  "tests/ac2.mjs":
    'import { readFileSync, existsSync } from "node:fs";\nconst f = "src/b/permiso.js";\nprocess.exit(existsSync(f) && readFileSync(f, "utf8").includes("403") ? 0 : 1);\n',
  "tests/ac3.mjs": exists("src/c/api.js"),
};
const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});

describe("Fase 5 ensamblada", () => {
  // Si regresiona, una rama queda con sub-tasks a medias o un criterio rojo llega a revisar.
  test("dos en paralelo y una dependiente; AC-2 vuelve una vez y la rama queda verde y lineal", async () => {
    // Las sesiones duran lo suficiente para superponerse aunque los worktrees se creen en fila con el
    // turno de git (ADR 0019): con 200 ms, una máquina cargada las dejaba correr de a una.
    const scripts: Record<string, SimScript[]> = {
      "ST-1": [{ calls: [write("src/a/csv.js", "export const csv = 1;\n")], delayMs: 1_500 }],
      "ST-2": [
        { calls: [write("src/b/permiso.js", "export const status = 200;\n")], delayMs: 1_500 },
        {
          calls: [
            {
              tool: "Edit",
              input: { file_path: "src/b/permiso.js", old_string: "200", new_string: "403" },
            },
          ],
        },
      ],
      "ST-3": [{ calls: [write("src/c/api.js", "export const api = 1;\n")] }],
    };
    const seen = new Map<string, number>();
    const sim = simQuery((prompt) => {
      const id = /Sub-task (ST-\d+)/.exec(prompt)?.[1] ?? "";
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const list = scripts[id] ?? [{}];
      return list[Math.min(n, list.length - 1)] ?? {};
    });
    const deps = testDeps({ query: sim.query });
    const { run, featureWt, baseSha } = await plannedRun(plan, TESTS, deps);
    const ok: PhaseFn = () => Promise.resolve({ tipo: "ok" });
    const registry = Object.fromEntries(PHASES.map((f) => [f, ok])) as PhaseRegistry;
    registry.implementar = implementar;
    registry.verificar = verificar;

    const final = await runUntilStop(run, registry, deps);
    expect(final.status).toBe("entregado");
    expect(final.vueltas.verificar).toBe(1);
    expect(sim.concurrency.max).toBe(2);
    const subjects = git(featureWt, "log", "--format=%s", `${baseSha}..HEAD`).split("\n").reverse();
    expect(subjects[0]).toBe("test: criterios en rojo");
    expect(subjects.slice(1, 3).sort()).toEqual(["feat: csv · ST-1", "feat: permiso · ST-2"]);
    expect(subjects.slice(3)).toEqual(["feat: endpoint · ST-3", "feat: permiso · ST-2"]);
    expect(git(featureWt, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
    const back = readLog(run.dir).events.find(
      (e) => e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve",
    );
    expect(back?.tipo === "accion_terminada" && back.resultado).toMatchObject({
      unidades: ["ST-2"],
    });
    const redo = sim.records.filter((r) => r.prompt.includes("Sub-task ST-2"))[1]?.prompt ?? "";
    expect(redo).toContain("AC-2 sigue en rojo");
  }, 120_000);
});
