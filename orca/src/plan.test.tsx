// La pestaña del plan con un worker simulado: el plan entero y las decisiones arriba.
import { readFileSync } from "node:fs";
import { assert, mockHost, mount, test } from "orca/testing";
import * as planTab from "./plan";
import { parseWatch, planView } from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const waiting = runs.find((r) => r.clave === "PIZ-3");

// Regresión: el plan de VF-3 no se podía ver en el panel. Si regresiona, la persona aprueba sin
// poder leer el plan.
test("muestra el plan entero, lo que cambió y los botones para decidir", async () => {
  const plan = planView({
    plan: `# Enfoque\n${"una línea larga del plan. ".repeat(800)}\n## Casos límite\n- vacío`,
    subtareas: [{ id: "ST-1", titulo: "Variables de color" }],
    criterios: [{ id: "AC-1" }],
    cambios: { tests_quitados: ["test/a.test.ts"] },
  });
  const view = await mount(planTab, {
    host: mockHost({ requests: { "flowrunner.planActual": () => ({ run: waiting, plan }) } }),
  });
  try {
    assert.ok(view.find({ text: "PIZ-3 · Modo oscuro" }));
    assert.ok(view.find({ text: "🟡 Aprobar — te espera" }));
    assert.ok(view.find({ text: "Aprobar" }));
    assert.ok(view.find({ text: "Cambios" }));
    assert.ok(view.find({ text: "ST-1 · Variables de color" }));
    assert.ok(view.find({ text: "tests que ya no están: test/a.test.ts" }));
    assert.ok(view.find({ text: "Enfoque" }));
    assert.ok(view.find({ text: "- vacío" }));
    assert.deepEqual(view.errors, []);
  } finally {
    await view.unmount();
  }
});

test("sin plan que espere, lo dice", async () => {
  const view = await mount(planTab, {
    host: mockHost({ requests: { "flowrunner.planActual": () => ({}) } }),
  });
  try {
    assert.ok(
      view.find({ label: "Ningún plan te espera" }) ?? view.find({ text: "Ningún plan te espera" }),
    );
  } finally {
    await view.unmount();
  }
});
