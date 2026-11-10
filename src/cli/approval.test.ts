import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Subtask } from "../gates/plan.ts";
import type { NewEvent } from "../store/events.ts";
import { appendEvent } from "../store/run-log.ts";
import { createRun } from "../store/runs.ts";
import type { z } from "zod";
import { describePlan, pisadas, type planViewSchema } from "./approval.ts";

const task = (alcance: string[], dependencias: string[] = []): Subtask => ({
  id: "ST-1",
  titulo: "t",
  descripcion: "d",
  alcance,
  dependencias,
  depende_de: [],
});
const rules = { lockfiles: ["pnpm-lock.yaml"], manifests: ["package.json"] };

function homeWithRuns() {
  const home = mkdtempSync(join(tmpdir(), "fr-pisadas-"));
  let second = 0;
  const run = (
    clave: string,
    tasks: Subtask[] | undefined,
    events: NewEvent[] = [],
    proyecto = "acme",
  ) => {
    second += 1;
    const paths = createRun(
      home,
      { clave, proyecto, repo: "/r", featureText: "x" },
      new Date(Date.UTC(2026, 10, 9, 10, 0, second)),
    );
    if (tasks !== undefined) writeFileSync(join(paths.dir, "tasks.json"), JSON.stringify(tasks));
    for (const e of events) appendEvent(paths.dir, e);
    return paths.id;
  };
  return { home, run };
}

describe("pisadas", () => {
  // Si regresiona, se aprueba un plan que choca con la PR abierta de otro run sin que nadie lo diga.
  test("avisa el archivo igual y la carpeta que lo contiene, con el estado y la PR del otro", () => {
    const { home, run } = homeWithRuns();
    const me = run("A-1", undefined);
    const withPr = run(
      "B-1",
      [task(["src/export/"])],
      [{ tipo: "pr", url: "https://x/pull/70", numero: 70 }],
    );
    const running = run("C-1", [task(["src/csv.ts", "docs/"])]);
    run("D-1", [task(["src/otra.ts"])]);
    expect(pisadas(home, me, [task(["src/export/csv.ts", "src/csv.ts"])], rules)).toEqual([
      { run: withPr, status: "en_curso", pr: 70, archivos: ["src/export/csv.ts"] },
      { run: running, status: "en_curso", pr: null, archivos: ["src/csv.ts"] },
    ]);
  });

  test("dos runs que agregan dependencias se pisan en el lockfile", () => {
    const { home, run } = homeWithRuns();
    const me = run("A-1", undefined);
    const other = run("B-1", [task(["src/b.ts"], ["zod"])]);
    expect(pisadas(home, me, [task(["src/a.ts"], ["yaml"])], rules)).toEqual([
      { run: other, status: "en_curso", pr: null, archivos: ["package.json", "pnpm-lock.yaml"] },
    ]);
  });

  test("no cuentan los runs cerrados, abortados, de otro proyecto ni sin plan legible", () => {
    const { home, run } = homeWithRuns();
    const me = run("A-1", undefined);
    run("B-1", [task(["src/a.ts"])], [{ tipo: "abortado" }]);
    run("C-1", [task(["src/a.ts"])], [{ tipo: "pr_cerrada", mergeada: false }]);
    run("D-1", [task(["src/a.ts"])], [], "otro");
    const roto = run("E-1", undefined);
    writeFileSync(join(home, "runs", roto, "tasks.json"), "{a medio escribir");
    expect(pisadas(home, me, [task(["src/a.ts"])], rules)).toEqual([]);
  });
});

// Si regresiona, el plan muestra «AC-2 → run» y quien aprueba busca una sub-task «run» que no existe.
test("un criterio del run se muestra como del run, no como una sub-task", () => {
  const view = {
    run: { id: "r-1", status: "esperando_aprobacion" },
    plan: "p",
    subtareas: [task(["src/a.ts"])],
    criterios: [
      { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
      { id: "AC-2", comando: "./.flowrunner/verify.sh", subtarea: "run" },
    ],
    tests: [],
    diff_tests: "",
    cambia_lo_existente: [],
    se_pisa_con: [],
    versiones: null,
    cambios: null,
  } as unknown as z.infer<typeof planViewSchema>;
  const text = describePlan(view);
  expect(text).toContain("  AC-1 → ST-1: node tests/ac1.mjs");
  expect(text).toContain("  AC-2 → del run (lo comprueba verificar): ./.flowrunner/verify.sh");
});
