// Gate de la Fase 8: una feature pasa feature check, corre de punta a punta y stats la refleja.
import { describe, expect, test } from "vitest";
import { runCli } from "./helpers/cli.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});

describe("Fase 8 ensamblada", () => {
  // Si regresiona, la consola de Claude Code no puede responder qué fase mejorar.
  test("feature check, un run completo con una vuelta y stats con sus vueltas y su costo", async () => {
    const w = simWorld({
      real: [
        "preparar",
        "planificar",
        "aprobar",
        "implementar",
        "verificar",
        "revisar",
        "entregar",
      ],
      scripts: [
        { calls: [WRITE_TEST], output: PLAN, costUsd: 0.5 },
        { calls: [write("src/export/otro.js", "export {};\n")], costUsd: 0.25 },
        { calls: [write("src/export/csv.js", "export const csv = 1;\n")], costUsd: 0.25 },
        { output: { hallazgos: [], decisiones: [] }, costUsd: 0.1 },
      ],
      feature: FEATURE,
      // Un repo que pide vueltas automáticas: sin ellas, la primera vuelta es una pregunta (ADR 0023).
      project: { config: { setup: "true", tests_globs: ["tests/**"], vueltas: 2 } },
    });
    const check = runCli(["feature", "check", w.feature, "--json"], w.env);
    expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, feature: { clave: "SHOP-214" } });
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    expect(runCli(["approve", id, "--json"], w.env).status).toBe(0);
    await waitFor("entregado", () => w.state(id).status === "entregado", 90_000);
    const s = JSON.parse(runCli(["stats", "acme-api", "--json"], w.env).stdout) as {
      runs: number;
      fases: { fase: string; reintentos: number; costoUsd: number }[];
      motivos: { motivo: string; veces: number }[];
    };
    expect(s.runs).toBe(1);
    expect(s.fases[0]).toMatchObject({ fase: "verificar", reintentos: 1 });
    expect(s.fases.find((f) => f.fase === "implementar")?.costoUsd).toBeCloseTo(0.5);
    expect(s.fases.find((f) => f.fase === "planificar")?.costoUsd).toBeCloseTo(0.5);
    expect(s.motivos[0]?.motivo).toMatch(/^verificar · vuelta: <id> sigue en rojo/);
    expect(runCli(["stats"], w.env).stdout).toMatch(/1 runs · 0 lecciones/);
    // Con --runs, la línea de base del plan de raíz: un renglón por run.
    const porRun = JSON.parse(runCli(["stats", "--runs", "acme-api", "--json"], w.env).stdout) as {
      runs: {
        id: string;
        planes: number;
        vueltas: number;
        derecho: boolean;
        costoPorFase: { planificar?: number };
      }[];
      resumen: { runs: number; derechos: number };
    };
    expect(porRun.runs).toHaveLength(1);
    expect(porRun.runs[0]).toMatchObject({ id, planes: 1, vueltas: 1, derecho: false });
    expect(porRun.runs[0]?.costoPorFase.planificar).toBeCloseTo(0.5);
    expect(porRun.resumen).toMatchObject({ runs: 1, derechos: 0 });
    expect(runCli(["stats", "--runs"], w.env).stdout).toMatch(/^\| id +\| activo /);
  }, 180_000);
});
