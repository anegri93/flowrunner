// Gate de la Fase 2 de flowrunner 2.0: el CLI real, las fases reales hasta revisar y el SDK simulado.
// La revisión, que tiene graft, lee entero un archivo largo sin que el hook la frene (T2.1), y un bloqueante de la
// revisión que es una decisión de la persona detiene el run con una pregunta, sin volver a implementar
// (T2.2), en un repo que aprueba solo (T1.6).
import { expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

const LARGO = `${Array.from({ length: 500 }, (_, i) => `// l${String(i)}`).join("\n")}\n`;

// Si regresiona, alguna pieza de la Fase 2 no encaja con el run de verdad: el hook vuelve a rechazar
// leer entero, o un bloqueante de decisión vuelve a la sub-task y gasta otra vuelta (PIZ-3).
test("la revisión lee entero un archivo largo y un bloqueante de decisión detiene revisar con una pregunta", async () => {
  const w = simWorld({
    real: ["preparar", "planificar", "aprobar", "implementar", "verificar", "revisar"],
    scripts: [
      { calls: [WRITE_TEST], output: PLAN },
      {
        calls: [
          {
            tool: "Write",
            input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
          },
        ],
      },
      {
        // Revisar tiene graft: era donde el hook rechazaba leer entero un archivo largo.
        calls: [{ tool: "Read", input: { file_path: "src/grande.js" } }],
        output: {
          hallazgos: [
            {
              severidad: "bloqueante",
              archivo: "package.json",
              linea: 10,
              afirmacion: "la librería pide Node >=24 y el repo promete >=20.6",
              regla: "engines del repo",
              subtarea: "ST-1",
              decision: true,
              arreglos: ["Subí `engines.node` a `>=24`", "Usá otra librería"],
            },
          ],
          decisiones: [],
        },
      },
    ],
    feature: FEATURE,
    project: {
      config: { setup: "true", tests_globs: ["tests/**"], aprobar: "si_hace_falta" },
      files: { "src/grande.js": LARGO },
    },
  });
  const id = w.launch();
  await waitFor("detenido", () => w.state(id).status === "detenido", 90_000);

  const s = w.state(id);
  expect(s.fase).toBe("revisar");
  expect(s.halt?.motivo).toContain("alguno es una decisión tuya");
  expect(s.halt?.motivo).toContain("Elegí: Subí `engines.node` a `>=24` · Usá otra librería");
  const events = readLog(w.dir(id)).events;
  expect(events.filter((e) => e.tipo === "rechazo")).toEqual([]);
  expect(
    events.filter((e) => e.tipo === "accion_iniciada" && e.fase === "implementar"),
  ).toHaveLength(1);
});
