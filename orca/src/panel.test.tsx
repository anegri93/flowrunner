// El panel con un worker simulado: los runs, los pasos de una sesión y los estados vacíos.
import { readFileSync } from "node:fs";
import { assert, mockHost, mount, test } from "orca/testing";
import * as panel from "./panel";
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

// Si regresiona, la pestaña de flowrunner en Orca no muestra el run ni deja ver qué hace una sesión.
test("muestra el run con sus fases, y al tocar una sesión sus pasos", async () => {
  const host = mockHost({
    requests: {
      "flowrunner.runs": () => ({ runs, at: 0 }),
      "flowrunner.pasos": ({ sesion }) => ({ sesion, texto: "Edit src/precio.ts" }),
    },
  });
  await withPanel(host, async (view) => {
    assert.ok(view.find({ label: "VF-2 · Precios en la base" }));
    assert.ok(view.find({ label: "└ ST-2 Comando /precio" }));
    // Un run entregado lleva a su PR con un link, no con la URL cortada.
    assert.equal(view.find({ text: "Abrir la PR" }), null);
    await view.press({ label: "  └ implementar-ST-2-1" });
    assert.ok(view.find({ label: "Pasos de implementar-ST-2-1" }));
    assert.ok(view.find({ text: "Edit src/precio.ts" }));
    await view.press({ text: "Cerrar" });
    assert.equal(view.find({ label: "Pasos de implementar-ST-2-1" }), null);
  });
});

test("un run entregado muestra el link a su PR", async () => {
  const delivered = {
    ...runs[0]!,
    status: "entregado" as const,
    siguiente: "https://github.com/o/r/pull/4",
  };
  await withPanel(
    mockHost({ requests: { "flowrunner.runs": () => ({ runs: [delivered], at: 0 }) } }),
    async (view) => {
      assert.ok(view.find({ type: "Link", text: "Abrir la PR" }));
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
