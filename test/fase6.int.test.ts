// Gate de la Fase 6: un run completo por CLI, de la feature a la PR, con todas las fases reales salvo
// el modelo y gh. Pasa por una aprobación, una vuelta de verificar y una de revisar.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./helpers/cli.ts";
import { git } from "./helpers/git.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { slotOf, waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});

describe("Fase 6 ensamblada", () => {
  // Si regresiona, un run no llega a la PR, o llega sin decir qué vueltas dio.
  test("feature a PR: aprobación, una vuelta de verificar, una de revisar, entregado con PR e informe", async () => {
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
        { calls: [WRITE_TEST], output: PLAN },
        { calls: [write("src/export/otro.js", "export {};\n")] },
        { calls: [write("src/export/csv.js", "export var csv = 1;\n")] },
        {
          output: {
            hallazgos: [
              {
                severidad: "bloqueante",
                archivo: "src/export/csv.js",
                linea: 1,
                afirmacion: "usa var",
                regla: "const, nunca var",
                subtarea: "ST-1",
              },
            ],
            decisiones: [],
          },
        },
        {
          calls: [
            {
              tool: "Edit",
              input: { file_path: "src/export/csv.js", old_string: "var", new_string: "const" },
            },
          ],
        },
        { output: { hallazgos: [], decisiones: [{ que: "aprobar", por_que: "cumple" }] } },
      ],
      feature: FEATURE,
      // Un repo que pide vueltas automáticas: sin ellas, la primera vuelta es una pregunta (ADR 0023).
      project: { config: { setup: "true", tests_globs: ["tests/**"], vueltas: 2 } },
    });
    const id = w.launch();
    await waitFor(
      "esperando aprobación",
      () => w.state(id).status === "esperando_aprobacion",
      60_000,
    );
    expect(runCli(["approve", id], w.env).status).toBe(0);
    await waitFor(
      "entregado",
      () => w.state(id).status === "entregado" || w.state(id).status === "detenido",
      90_000,
    );
    const state = w.state(id);
    expect(state.halt?.motivo).toBeUndefined();
    expect(state.status).toBe("entregado");
    expect(state.vueltas).toEqual({ verificar: 1, revisar: 1, probar: 0 });

    const gh = readFileSync(join(w.env.HOME ?? "", "gh.log"), "utf8");
    expect(gh.match(/"create"/g)).toHaveLength(1);
    expect(gh).not.toMatch(/"merge"/);
    const branch = "feat/SHOP-214-exportar-pedidos-a-csv";
    expect(git(w.remote, "show", `${branch}:src/export/csv.js`)).toBe("export const csv = 1;");

    const informe = readFileSync(join(w.dir(id), "informe.md"), "utf8");
    expect(informe).toContain("- **PR:** https://github.com/acme/acme-api/pull/412");
    expect(informe).toMatch(/verificar devolvió trabajo: AC-1 sigue en rojo/);
    expect(informe).toMatch(/revisar devolvió trabajo: la revisión encontró bloqueantes/);
    await waitFor("lugar suelto", () => slotOf(w) === undefined, 10_000);
    await waitFor(
      "el aviso",
      () =>
        w
          .notices()
          .includes("SHOP-214: PR abierta, 2 vueltas. Pedile a Claude que te explique el informe."),
      10_000,
    );
  }, 180_000);
});
