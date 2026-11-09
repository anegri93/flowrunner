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

// Si regresiona, no se ve qué hace la sesión que corre, o sus pasos no se abren en una pestaña.
test("las sub-tasks con su estado; Pasos y Plan piden abrir su archivo en una pestaña", async () => {
  const opened: unknown[] = [];
  await withPanel(
    withRuns({
      "flowrunner.abrir": (input: unknown) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: "✓ ST-1 Tabla de precios · integrada" }));
      assert.ok(view.find({ text: "▸ Edit src/precio.ts · ctx 52k" }));
      await view.press({ label: "Pasos de implementar-ST-2-1" });
      await view.press({ role: "button", text: "Plan" });
      assert.deepEqual(opened, [
        { run: "VF-2-20261109-001527", que: { tipo: "pasos", sesion: "implementar-ST-2-1" } },
        { run: PIZ3, que: { tipo: "plan" } },
      ]);
    },
  );
});

// Si regresiona, un plan ya aprobado no se puede volver a ver desde el panel.
test("tocar Aprobar abre el plan, también el de un run que ya lo aprobó", async () => {
  const opened: unknown[] = [];
  await withPanel(
    withRuns({
      "flowrunner.abrir": (input: unknown) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
    async (view) => {
      // PIZ-3 espera aprobación; VF-2 ya pasó de planificar. Los dos tienen plan para ver.
      const links = view.findAll({ type: "Link", text: "Aprobar" });
      assert.equal(links.length, 2);
      for (const link of links) await view.press(link);
      assert.deepEqual(opened, [
        { run: "PIZ-3-20261109-010000", que: { tipo: "plan" } },
        { run: "VF-2-20261109-001527", que: { tipo: "plan" } },
      ]);
    },
  );
});

// Si regresiona, un archivo que no se pudo abrir falla en silencio.
test("si no se puede abrir, lo dice en el run", async () => {
  await withPanel(
    withRuns({ "flowrunner.abrir": () => ({ ok: false, mensaje: "Orca no abrió el archivo" }) }),
    async (view) => {
      await view.press({ label: "Pasos de implementar-ST-2-1" });
      assert.ok(view.find({ text: "Orca no abrió el archivo" }));
    },
  );
});

// Si regresiona, aprobar desde el panel no llega a flowrunner, o aprueba sin confirmar.
test("aprobar pide confirmación; Cambios manda el motivo escrito", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  await withPanel(
    withRuns({
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
    async (view) => {
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

// Si regresiona, después de mergear la PR hay que esperar el chequeo de cada 10 minutos para aprender.
test("Aprender ahora, en un run con la PR abierta, aprende sin esperar y muestra lo que dijo", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  await withPanel(
    withRuns({
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "la PR sigue abierta" };
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Aprender ahora" });
      assert.deepEqual(sent, [{ run: "VF-1-20261108-211454", decision: { accion: "aprender" } }]);
      assert.ok(view.find({ text: "la PR sigue abierta" }));
    },
  );
});

// Si regresiona, el run desaparece del panel al cerrarse y la persona no ve cómo terminó.
test("cuando un run con la PR abierta se cierra, su informe se abre solo, una vez", async () => {
  let current = runs;
  const opened: unknown[] = [];
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: current, at: 0 }),
        "flowrunner.abrir": (input: unknown) => {
          opened.push(input);
          return { ok: true, mensaje: "abierto" };
        },
      },
    }),
    async (view) => {
      // VF-1 estaba entregado; el chequeo vio el merge y lo cerró: ya no está entre los activos.
      current = runs.filter((r) => r.clave !== "VF-1");
      await panel.refresh();
      await view.settled();
      await panel.refresh();
      await view.settled();
      assert.deepEqual(opened, [{ run: "VF-1-20261108-211454", que: { tipo: "informe" } }]);
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
