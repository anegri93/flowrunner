// El panel con un worker simulado: el orden, contraer y expandir, la etapa actual, los pasos y las
// decisiones.
import { readFileSync } from "node:fs";
import { assert, mockHost, mount, test } from "orca/testing";
import * as panel from "./panel";
import type { Decision } from "./runs";
import { parseWatch } from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));

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

const titles = (view: View) =>
  view
    .findAll({ type: "ListItem" })
    .map((item) => item.label ?? "")
    .filter((t) => /^[▾▸]/.test(t));

// Si regresiona, el panel vuelve a mostrar todo expandido, con los terminados arriba.
test("los más recientes arriba; los terminados contraídos; tocar un run lo expande", async () => {
  const host = mockHost({ requests: { "flowrunner.runs": () => ({ runs, at: 0 }) } });
  await withPanel(host, async (view) => {
    assert.deepEqual(titles(view), [
      "▾ PIZ-3 · Modo oscuro",
      "▾ VF-2 · Precios en la base",
      "▸ VF-1 · Registro de costos",
    ]);
    assert.equal(view.find({ text: "Abrir la PR" }), null);
    await view.press({ label: "▸ VF-1 · Registro de costos" });
    assert.ok(view.find({ label: "▾ VF-1 · Registro de costos" }));
    assert.ok(view.find({ text: "Abrir la PR" }));
    await view.press({ label: "▾ VF-2 · Precios en la base" });
    assert.equal(view.find({ text: "▶ implementar" }), null);
  });
});

// Si regresiona, la etapa actual se pierde entre las terminadas, o no se ve qué hace una sesión.
test("la etapa actual se destaca; las listas van en una línea que se expande; los pasos de una sesión", async () => {
  const host = mockHost({
    requests: {
      "flowrunner.runs": () => ({ runs, at: 0 }),
      "flowrunner.pasos": ({ sesion }) => ({ sesion, texto: "Edit src/precio.ts" }),
    },
  });
  await withPanel(host, async (view) => {
    assert.ok(view.find({ text: "▶ implementar" }));
    assert.ok(view.find({ text: "trabajando" }));
    assert.equal(view.find({ text: "✓ preparar · 12s" }), null);
    // PIZ-3 y VF-2 tienen dos fases listas cada uno; el primero es PIZ-3, el más reciente.
    assert.equal(view.findAll({ text: "▸ ✓ 2 listas" }).length, 2);
    await view.press({ text: "▸ ✓ 2 listas" });
    assert.ok(view.find({ text: "✓ preparar · 12s" }));
    assert.equal(view.find({ text: "✓ preparar · 16s" }), null);
    assert.ok(view.find({ text: "Faltan: verificar" }));
    await view.press({ label: "Pasos de implementar-ST-2-1" });
    assert.ok(view.find({ text: "Pasos de implementar-ST-2-1" }));
    assert.ok(view.find({ text: "Edit src/precio.ts" }));
  });
});

// Si regresiona, aprobar desde el panel no llega a flowrunner, o aprueba sin confirmar.
test("aprobar pide confirmación y manda la decisión; pedir cambios manda el motivo escrito", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const host = mockHost({
    requests: {
      "flowrunner.runs": () => ({ runs, at: 0 }),
      "flowrunner.decidir": (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    },
  });
  await withPanel(host, async (view) => {
    assert.equal(view.findAll({ text: "Aprobar" }).length, 1);
    await view.press({ text: "Aprobar" });
    assert.deepEqual(sent, []);
    assert.ok(view.find({ text: "¿Aprobar el plan de PIZ-3? Arranca la implementación." }));
    await view.press({ text: "Sí, confirmar" });
    assert.deepEqual(sent, [{ run: "PIZ-3-20261109-010000", decision: { accion: "aprobar" } }]);
    await view.press({ text: "Pedir cambios" });
    await view.type({ label: "Qué cambiar del plan" }, "separá la validación", { submit: true });
    assert.deepEqual(sent[1], {
      run: "PIZ-3-20261109-010000",
      decision: { accion: "cambios", motivo: "separá la validación" },
    });
  });
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
