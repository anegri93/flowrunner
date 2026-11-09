// El panel con un worker simulado: cada run como el seguimiento de un pedido, los pasos de una
// sesión, el plan y las decisiones.
import { readFileSync } from "node:fs";
import { assert, mockHost, mount, test } from "orca/testing";
import * as panel from "./panel";
import type { Decision } from "./runs";
import { parseWatch } from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const PIZ3 = "PIZ-3-20261109-010000";

type View = Awaited<ReturnType<typeof mount>>;

/** Monta el panel y lo desmonta siempre: si no, su refresco cada 3 s deja el test colgado al fallar. */
async function withPanel(host: ReturnType<typeof mockHost>, body: (view: View) => Promise<void>) {
  const view = await mount(panel, { host });
  try {
    await body(view);
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.refusals, []);
  } finally {
    await view.unmount();
  }
}

const withRuns = (extra: Record<string, (input: never) => unknown> = {}) =>
  mockHost({ requests: { "flowrunner.runs": () => ({ runs, at: 0 }), ...extra } });

// Si regresiona, el panel deja de leerse de un vistazo: sin la frase del estado, el avance y los pasos.
test("cada run muestra su estado en una frase, el avance y los cinco pasos; los más recientes arriba", async () => {
  await withPanel(withRuns(), async (view) => {
    const cards = view.findAll({ type: "Card" }).map((c) => c.label);
    assert.deepEqual(cards, [
      "PIZ-3 · Modo oscuro",
      "VF-2 · Precios en la base",
      "VF-1 · Registro de costos",
    ]);
    assert.ok(view.find({ text: "🟡 El plan te espera" }));
    assert.ok(view.find({ text: "🔵 Implementando · 1 de 2 sub-tasks" }));
    assert.ok(view.find({ text: "🟢 PR abierta: falta tu merge" }));
    assert.equal(view.findAll({ text: "Tu OK" }).length, 3);
    assert.equal(view.findAll({ type: "Progress" }).length, 3);
  });
});

// Si regresiona, un run terminado vuelve a ocupar el panel con todo su detalle.
test("el detalle de un run terminado se abre a pedido", async () => {
  await withPanel(withRuns(), async (view) => {
    assert.equal(view.find({ text: "Abrir la PR" }), null);
    await view.press({ label: "Ver el detalle de VF-1" });
    assert.ok(view.find({ text: "Abrir la PR" }));
    await view.press({ label: "Ocultar el detalle de VF-2" });
    assert.equal(view.find({ text: "● ST-2 Comando /precio" }), null);
  });
});

// Si regresiona, no se ve qué sub-tasks faltan ni qué hace la sesión que corre.
test("las sub-tasks como lista de tareas, y los pasos de la sesión que corre", async () => {
  await withPanel(
    withRuns({
      "flowrunner.pasos": ({ sesion }: { sesion: string }) => ({
        sesion,
        texto: "Edit src/precio.ts",
      }),
    }),
    async (view) => {
      assert.ok(view.find({ text: "✓ ST-1 Tabla de precios" }));
      assert.ok(view.find({ text: "● ST-2 Comando /precio" }));
      assert.ok(view.find({ text: "▸ Edit src/precio.ts · ctx 52k" }));
      await view.press({ label: "Pasos de implementar-ST-2-1" });
      assert.ok(view.find({ text: "Edit src/precio.ts" }));
    },
  );
});

// Regresión: en VF-3, el plan pasaba los 16 KiB que Orca dibuja por texto. Orca rechazaba ese dibujo
// y todos los que seguían, y ni «Ver plan» ni «Pedir cambios» hacían nada.
test("un plan largo se ve, y después se puede pedir cambios", async () => {
  const long = `# Plan\n${"una línea larga del plan. ".repeat(1_500)}`;
  await withPanel(
    withRuns({
      "flowrunner.plan": () => ({
        subtareas: [{ id: "ST-1", titulo: "Variables de color" }],
        criterios: 1,
        cambios: [],
        texto: long.slice(0, 4_000),
        recortado: true,
      }),
    }),
    async (view) => {
      await view.press({ text: "Ver plan" });
      assert.deepEqual(view.errors, []);
      assert.ok(view.find({ text: "Plan: 1 sub-tasks · 1 criterios" }));
      assert.ok(view.find({ text: /una línea larga del plan/ }));
      await view.press({ text: "Pedir cambios" });
      assert.ok(view.find({ label: "Qué cambiar del plan" }));
    },
  );
});

// Si regresiona, aprobar desde el panel no llega a flowrunner, o aprueba sin confirmar.
test("aprobar pide confirmación y manda la decisión; pedir cambios manda el motivo escrito", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  await withPanel(
    withRuns({
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
    async (view) => {
      await view.press({ text: "Aprobar" });
      assert.deepEqual(sent, []);
      assert.ok(view.find({ text: "¿Aprobar el plan? Arranca la implementación." }));
      await view.press({ text: "Sí, confirmar" });
      assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar" } }]);
      await view.press({ text: "Pedir cambios" });
      await view.type({ label: "Qué cambiar del plan" }, "separá la validación", { submit: true });
      assert.deepEqual(sent[1], {
        run: PIZ3,
        decision: { accion: "cambios", motivo: "separá la validación" },
      });
    },
  );
});

// Si regresiona, un flowrunner roto o sin runs deja el panel vacío sin decir por qué.
test("sin runs lo dice; con un error de flowrunner, lo muestra", async () => {
  await withPanel(
    mockHost({ requests: { "flowrunner.runs": () => ({ runs: [], at: 0 }) } }),
    async (view) => {
      assert.ok(
        view.find({ label: "No hay runs activos" }) ?? view.find({ text: "No hay runs activos" }),
      );
    },
  );
  await withPanel(
    mockHost({
      requests: { "flowrunner.runs": () => ({ runs: [], error: "command not found", at: 0 }) },
    }),
    async (view) => {
      assert.ok(view.find({ text: /No se pudo leer flowrunner: command not found/ }));
    },
  );
});
