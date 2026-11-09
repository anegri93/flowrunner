// La pestaña de los runs con un worker simulado: las tarjetas, las etapas, el detalle, las
// decisiones y un refresco que no borra lo que se ve.
import { readFileSync } from "node:fs";
import { assert, mockHost, mount, test } from "orca/testing";
import * as panel from "./panel";
import type { Decision, Run } from "./runs";
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

// Si regresiona, el panel deja de leerse de un vistazo: el estado, el tiempo y las etapas en lista.
test("cada run: su estado, el título, el tiempo y las ocho etapas en lista; la que trabaja gira", async () => {
  await withPanel(withRuns(), async (view) => {
    assert.deepEqual(
      view.findAll({ type: "Badge" }).map((b) => b.text),
      ["TE ESPERA", "EN CURSO", "PR ABIERTA"],
    );
    assert.ok(view.find({ text: "Modo oscuro" }));
    assert.ok(view.find({ text: "PIZ-3 · PIZ-3-20261109-010000" }));
    assert.ok(view.find({ text: "20:00" }));
    assert.ok(view.find({ text: "Verificar" }));
    assert.ok(view.find({ label: "Implementar: trabajando" }));
    assert.ok(view.find({ text: "te espera" }));
  });
});

// Si regresiona, un run terminado vuelve a ocupar el panel con todas sus etapas.
test("un run terminado muestra solo su etapa actual hasta que se abre", async () => {
  await withPanel(withRuns(), async (view) => {
    assert.ok(view.find({ text: "espera merge" }));
    const before = view.findAll({ text: "Preparar" }).length;
    await view.press({ label: "Ver las etapas de VF-1" });
    assert.equal(view.findAll({ text: "Preparar" }).length, before + 1);
    assert.ok(view.find({ text: "Abrir la PR" }));
  });
});

// Si regresiona, no se ve qué sub-tasks faltan ni qué hace la sesión que corre.
test("las sub-tasks con su estado, y los pasos de la sesión que corre", async () => {
  await withPanel(
    withRuns({
      "flowrunner.pasos": ({ sesion }: { sesion: string }) => ({
        sesion,
        texto: "Edit src/precio.ts",
      }),
    }),
    async (view) => {
      assert.ok(view.find({ text: "✓ ST-1 Tabla de precios · integrada" }));
      assert.ok(view.find({ text: "● ST-2 Comando /precio · trabajando" }));
      assert.ok(view.find({ text: "▸ Edit src/precio.ts · ctx 52k" }));
      await view.press({ label: "Pasos de implementar-ST-2-1" });
      assert.ok(view.find({ text: "Edit src/precio.ts" }));
    },
  );
});

// Si regresiona, «Plan» no abre la pestaña del plan, o aprobar llega sin confirmar.
test("Plan abre su pestaña; aprobar pide confirmación; Cambios manda el motivo escrito", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const opened: string[] = [];
  await withPanel(
    withRuns({
      "flowrunner.verPlan": ({ run }: { run: string }) => {
        opened.push(run);
        return { ok: true, mensaje: "plan abierto" };
      },
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      assert.deepEqual(opened, [PIZ3]);
      await view.press({ role: "button", text: "Aprobar" });
      assert.deepEqual(sent, []);
      await view.press({ text: "Sí, confirmar" });
      assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar" } }]);
      await view.press({ role: "button", text: "Cambios" });
      await view.type({ label: "Qué cambiar del plan" }, "separá la validación", { submit: true });
      assert.deepEqual(sent[1], {
        run: PIZ3,
        decision: { accion: "cambios", motivo: "separá la validación" },
      });
    },
  );
});

// Regresión: una lectura que fallaba dejaba el panel sin runs hasta la siguiente, y todo parpadeaba.
test("si una lectura falla, los runs que se veían quedan, con el error arriba", async () => {
  let fail = false;
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () =>
          fail ? { runs: [] as Run[], error: "timeout", at: 1 } : { runs, at: 0 },
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: "Modo oscuro" }));
      fail = true;
      await panel.refresh();
      await view.settled();
      assert.ok(view.find({ text: "Modo oscuro" }));
      assert.ok(view.find({ text: /No se pudo leer flowrunner: timeout/ }));
    },
  );
});

// Si regresiona, un flowrunner roto o sin runs deja el panel vacío sin decir por qué.
test("sin runs lo dice", async () => {
  await withPanel(
    mockHost({ requests: { "flowrunner.runs": () => ({ runs: [], at: 0 }) } }),
    async (view) => {
      assert.ok(
        view.find({ label: "No hay runs activos" }) ?? view.find({ text: "No hay runs activos" }),
      );
    },
  );
});
