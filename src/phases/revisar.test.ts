import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps, writeFiles } from "../../test/helpers/project.ts";
import { simQuery } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import { commitAll } from "../git/git.ts";
import { readLog } from "../store/run-log.ts";
import { z } from "zod";
import { revisar, reviewSchema, type Review } from "./revisar.ts";

const plan: Plan = {
  plan: "dos sub-tasks",
  subtareas: ["ST-1", "ST-2"].map((id) => ({
    id,
    titulo: id,
    descripcion: id,
    alcance: [`src/${id}/`],
    dependencias: [],
    depende_de: [],
  })),
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

const finding = (extra: Partial<Review["hallazgos"][number]>): Review["hallazgos"][number] => ({
  severidad: "bloqueante",
  archivo: "src/ST-2/x.js",
  linea: 1,
  afirmacion: "usa var",
  regla: "no var",
  subtarea: "ST-2",
  ...extra,
});

async function reviewWith(output: Review) {
  const sim = simQuery([{ output }]);
  const deps = testDeps({ query: sim.query });
  const { run, featureWt } = await plannedRun(
    plan,
    { "tests/ac1.mjs": "process.exit(0);\n" },
    deps,
    {
      files: { "src/base.js": "export function base() { return 1; }\n" },
    },
  );
  writeFiles(featureWt, {
    "src/ST-2/x.js": 'import { base } from "../base.js";\nvar x = base();\n',
  });
  await commitAll(featureWt, "feat: ST-2", {}, deps.env);
  const outcome = await revisar(contextFor(run, "revisar", deps));
  return { outcome, sim, run };
}

describe("revisar", () => {
  // Si regresiona, un bloqueante llega a la PR, o revisar rehace sub-tasks que no tocó.
  test("un bloqueante en ST-2 vuelve solo ST-2 con el hallazgo y la regla en el motivo", async () => {
    const { outcome, sim } = await reviewWith({ hallazgos: [finding({})], decisiones: [] });
    expect(outcome).toEqual({
      tipo: "vuelve",
      unidades: ["ST-2"],
      motivo:
        "la revisión encontró bloqueantes:\n- ST-2 · src/ST-2/x.js:1: usa var (regla: no var)",
    });
    const prompt = sim.records[0]?.prompt ?? "";
    expect(prompt).toContain("+var x = base();");
    expect(sim.records[0]?.options?.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  test("solo avisos: avanza, los avisos quedan como eventos y review.json en el run", async () => {
    const { outcome, run } = await reviewWith({
      hallazgos: [finding({ severidad: "aviso" })],
      decisiones: [],
    });
    expect(outcome).toEqual({ tipo: "ok" });
    expect(readLog(run.dir).events.filter((e) => e.tipo === "aviso")).toEqual([
      expect.objectContaining({ texto: "src/ST-2/x.js:1: usa var" }),
    ]);
    expect(existsSync(join(run.dir, "review.json"))).toBe(true);
  });

  test("un hallazgo que nombra una sub-task inexistente es falla de gate", async () => {
    const { outcome } = await reviewWith({
      hallazgos: [finding({ subtarea: "ST-9" })],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/ST-9.*las válidas son ST-1, ST-2/);
  });

  test("el prompt recibe el radio de impacto de graft sobre el diff real", async () => {
    const { sim } = await reviewWith({ hallazgos: [], decisiones: [] });
    const prompt = sim.records[0]?.prompt ?? "";
    const blast = prompt.slice(
      prompt.indexOf("# Radio de impacto según graft"),
      prompt.indexOf("# El cerebro del repo"),
    );
    expect(blast).not.toMatch(/no pudo calcular/);
    expect(blast).toMatch(/x\.js|base/);
  });
});

// Si regresiona, el modelo puede omitir el paso a paso: el default solo existe para leer review.json viejos.
test("el schema que recibe el revisor exige como_probar", () => {
  expect(z.toJSONSchema(reviewSchema, { target: "draft-7" }).required).toContain("como_probar");
});
