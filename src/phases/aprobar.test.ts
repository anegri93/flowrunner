// Aprobar fija las versiones de las dependencias nuevas antes de que la persona vea el plan (ADR 0028).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { PLAN } from "../../test/helpers/plan-fixtures.ts";
import { contextFor, newRun, testDeps } from "../../test/helpers/project.ts";
import { approveRun, describePlan, planViewSchema } from "../cli/approval.ts";
import { summarize } from "../cli/contracts.ts";
import { esFallaDeRed } from "../engine/motivos.ts";
import type { Plan } from "../gates/plan.ts";
import type { RunPaths } from "../runner/types.ts";
import { appendEvent } from "../store/run-log.ts";
import { loadState } from "../store/runs.ts";
import type { Consulta, Registro } from "../versiones/versiones.ts";
import { aprobar } from "./aprobar.ts";
import { readPlan, writePlanArtifacts } from "./planificar.ts";

const CON_DEPS: Plan = {
  ...PLAN,
  subtareas: PLAN.subtareas.map((t) => ({
    ...t,
    dependencias: ["unpdf"],
    dependencias_dev: ["fflate@0.8.2"],
  })),
};

const UNPDF: Consulta = {
  tipo: "ok",
  versiones: [
    { version: "1.9.1", node: ">=20", deprecada: false },
    { version: "2.1.0", node: ">=24", deprecada: false },
  ],
  latest: "2.1.0",
};

/** Un run planificado sobre un worktree con estos archivos, a punto de entrar a aprobar. */
function planificado(files: Record<string, string>, plan: Plan = CON_DEPS): RunPaths {
  const worktree = tempDir("fr-aprobar-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(worktree, name), content);
  const run = newRun(worktree);
  appendEvent(run.dir, { tipo: "preparado", rama: "flowrunner/x", worktree, base_sha: "abc" });
  writePlanArtifacts(run, plan, {});
  for (const fase of ["preparar", "planificar"] as const) {
    appendEvent(run.dir, { tipo: "accion_iniciada", fase });
    appendEvent(run.dir, { tipo: "accion_terminada", fase, resultado: { tipo: "ok" } });
  }
  appendEvent(run.dir, { tipo: "accion_iniciada", fase: "aprobar" });
  return run;
}

const registro =
  (paquetes: Record<string, Consulta>): Registro =>
  (paquete) => {
    const c = paquetes[paquete];
    return c === undefined
      ? Promise.reject(new Error(`no esperaba ${paquete}`))
      : Promise.resolve(c);
  };

/** Lo que vería la persona con `flowrunner plan`, sin el diff de los tests. */
function vista(run: RunPaths) {
  const plan = readPlan(run);
  return planViewSchema.parse({
    ok: true,
    run: summarize(loadState(run.home, run.id)),
    plan: plan.plan,
    subtareas: plan.subtareas,
    criterios: plan.criterios,
    tests: [],
    diff_tests: "",
    cambia_lo_existente: [],
    se_pisa_con: [],
    versiones: plan.versiones ?? null,
    cambios: null,
  });
}

describe("aprobar", () => {
  // Si regresiona, la sub-task instala la última versión sin mirar el Node del repo, como en PIZ-3.
  test("el plan que ve la persona trae la versión elegida, y una que el plan fijó queda igual", async () => {
    const run = planificado({ "package.json": JSON.stringify({ engines: { node: ">=20.6" } }) });
    const out = await aprobar(
      contextFor(run, "aprobar", testDeps({ registro: registro({ unpdf: UNPDF }) })),
    );
    expect(out).toEqual({ tipo: "espera" });
    const task = readPlan(run).subtareas[0];
    expect(task?.dependencias).toEqual(["unpdf@1.9.1"]);
    expect(task?.dependencias_dev).toEqual(["fflate@0.8.2"]);
    const text = describePlan(vista(run));
    expect(text).toContain("agrega unpdf@1.9.1, fflate@0.8.2");
    expect(text).toContain(
      "Versiones que eligió flowrunner, las estables más nuevas (andan con Node 20.6.0, de engines.node de package.json): unpdf@1.9.1",
    );
  });

  // Si regresiona, se aprueba un plan con una dependencia que no anda con el Node del repo.
  test("si ninguna versión anda, el plan lo muestra primero y approve no sigue", async () => {
    const run = planificado({ "package.json": JSON.stringify({ engines: { node: ">=18" } }) });
    await aprobar(contextFor(run, "aprobar", testDeps({ registro: registro({ unpdf: UNPDF }) })));
    appendEvent(run.dir, {
      tipo: "accion_terminada",
      fase: "aprobar",
      resultado: { tipo: "espera" },
    });
    expect(loadState(run.home, run.id).status).toBe("esperando_aprobacion");
    const motivo =
      "Ninguna versión estable de unpdf anda con Node 18.0.0 (engines.node de package.json); la más nueva, 2.1.0, pide >=24: subí `engines.node` a `>=24` o elegí otra librería";
    expect(describePlan(vista(run))).toContain(
      `⚠ Sin una versión que sirva (1). No se puede aprobar así: pedí cambios:\n  - ${motivo}`,
    );
    expect(() => approveRun(run.home, run.id, {}, true)).toThrow(motivo);
    expect(() => approveRun(run.home, run.id, {}, true, "claude")).toThrow(
      expect.objectContaining({
        next: `flowrunner changes ${run.id} "<qué hacer con unpdf>" --origen claude`,
      }),
    );
    expect(loadState(run.home, run.id).status).toBe("esperando_aprobacion");
  });

  // Si regresiona, un registro caído cuelga el run, o lo detiene sin esperar como un corte de red.
  test("si el registro no responde, falla como infraestructura con un motivo de red", async () => {
    const run = planificado({ "package.json": "{}" });
    const caido: Registro = () =>
      Promise.reject(
        new Error(
          "el registro de npm no respondió en 30 s al buscar las versiones de unpdf (ETIMEDOUT)",
        ),
      );
    const out = await aprobar(contextFor(run, "aprobar", testDeps({ registro: caido })));
    expect(out).toEqual({
      tipo: "falla",
      clase: "infra",
      motivo:
        "el registro de npm no respondió en 30 s al buscar las versiones de unpdf (ETIMEDOUT)",
    });
    expect(esFallaDeRed(out.tipo === "falla" ? out.motivo : "")).toBe(true);
    expect(readPlan(run).subtareas[0]?.dependencias).toEqual(["unpdf"]);
  });

  test("un repo sin package.json no consulta el registro", async () => {
    const run = planificado({ "deps.txt": "" });
    // testDeps trae un registro que rechaza: si se consultara, aprobar fallaría.
    expect(await aprobar(contextFor(run, "aprobar", testDeps()))).toEqual({ tipo: "espera" });
    expect(readPlan(run).subtareas[0]?.dependencias).toEqual(["unpdf"]);
    expect(existsSync(join(run.dir, "versiones.json"))).toBe(false);
  });

  // Si regresiona, un replan llega a aprobar con las versiones del plan anterior.
  test("un plan nuevo borra las versiones del anterior", async () => {
    const run = planificado({ "package.json": JSON.stringify({ engines: { node: ">=18" } }) });
    await aprobar(contextFor(run, "aprobar", testDeps({ registro: registro({ unpdf: UNPDF }) })));
    expect(readPlan(run).versiones?.sin_version).toHaveLength(1);
    writePlanArtifacts(run, PLAN, {});
    expect(readPlan(run).versiones).toBeUndefined();
    expect(JSON.parse(readFileSync(join(run.dir, "tasks.json"), "utf8"))).toEqual(PLAN.subtareas);
  });
});
