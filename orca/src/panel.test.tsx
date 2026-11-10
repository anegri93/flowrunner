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

// Si regresiona, el detalle de una etapa no se puede abrir desde el panel, o se ofrece en una que
// todavía no arrancó.
test("tocar una etapa que arrancó abre su detalle; una pendiente no es un link", async () => {
  const opened: unknown[] = [];
  await withPanel(
    withRuns({
      "flowrunner.abrir": (input: unknown) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
    async (view) => {
      const vf2 = "VF-2-20261109-001527";
      const running = runs.find((r) => r.id === vf2);
      const started = running?.fases.map((p) => p.fase) ?? [];
      assert.ok(started.includes("implementar"));
      await view.press({ type: "Link", text: "Implementar" });
      assert.deepEqual(opened, [{ run: vf2, que: { tipo: "etapa", fase: "implementar" } }]);
      // Ningún run en vista llegó a verificar: la etapa es texto, no un link.
      assert.equal(view.findAll({ type: "Link", text: "Verificar" }).length, 0);
      assert.ok(view.find({ text: "Verificar" }));
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
      "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      await view.press({ role: "button", text: "Aprobar" });
      assert.deepEqual(sent, []);
      await view.press({ text: "Sí, confirmar" });
      assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar", plan: `${PIZ3}#1` } }]);
      await view.press({ role: "button", text: "Cambios" });
      await view.type({ label: "Qué cambiar del plan" }, "separá la validación", { submit: true });
      assert.deepEqual(sent[1], {
        run: PIZ3,
        decision: { accion: "cambios", motivo: "separá la validación" },
      });
    },
  );
});

// Si regresiona, un run que se detuvo con una pregunta no se puede responder desde el panel.
test("un run detenido muestra Arreglar ST-n, que pide qué corregir y lo manda", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const id = "VF-2-20261109-001527";
  const asked = runs.map((r): Run =>
    r.id === id
      ? {
          ...r,
          status: "detenido",
          motivo: "verificar: AC-2 sigue en rojo",
          siguiente: `flowrunner fix ${id} --unidad ST-2 "<qué cambiar>"`,
          unidades: ["ST-2"],
          opciones: [
            {
              comando: `flowrunner fix ${id} --unidad ST-2 "<qué cambiar>"`,
              que: "que ST-2 lo corrija",
            },
            { comando: `flowrunner fix ${id} --auto`, que: "formateador y lint" },
            { comando: `flowrunner fix ${id} --yo`, que: "lo arreglás vos" },
            { comando: `flowrunner accept ${id} "<por qué>"`, que: "seguir igual" },
            { comando: `flowrunner abort ${id}`, que: "cortar el run" },
          ],
        }
      : r,
  );
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: asked, at: 0 }),
        "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
          sent.push(input);
          return { ok: true, mensaje: "arreglando ST-2" };
        },
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: "Parece ser de: ST-2" }));
      assert.ok(view.find({ role: "button", text: "Autofix" }));
      assert.equal(view.find({ role: "button", text: "Lo arreglo yo" }), null);
      assert.ok(view.find({ role: "button", text: "Seguir igual" }));
      await view.press({ role: "button", text: "Arreglar ST-2" });
      assert.deepEqual(sent, []);
      await view.type({ label: "Qué tiene que corregir ST-2" }, "el CSV lleva BOM", {
        submit: true,
      });
      assert.deepEqual(sent, [
        {
          run: id,
          decision: { accion: "arreglar", unidad: "ST-2", instruccion: "el CSV lleva BOM" },
        },
      ]);
    },
  );
});

// Si regresiona, un run vivo no se puede abortar desde el panel, o se aborta sin confirmar.
test("cada run vivo tiene «Abortar el run» al pie, que pide confirmación antes de mandarlo", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  await withPanel(
    withRuns({
      "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
        sent.push(input);
        return { ok: true, mensaje: "abortado; las ramas quedan" };
      },
    }),
    async (view) => {
      const buttons = view.findAll({ role: "button", text: "Abortar el run" });
      assert.equal(buttons.length, runs.length);
      // Al pie de la tarjeta, después de las etapas, no entre ellas.
      const drawn = JSON.stringify(view.tree());
      assert.ok(drawn.lastIndexOf("Abortar el run") > drawn.lastIndexOf("Aprender"));
      const first = buttons[0];
      if (first === undefined) throw new Error("sin botón Abortar");
      await view.press(first);
      assert.deepEqual(sent, []);
      const question = view.find({ text: /^¿Abortar el run [A-Z]+-\d+\?$/ })?.text ?? "";
      const clave = /¿Abortar el run ([A-Z]+-\d+)\?/.exec(question)?.[1];
      assert.ok(view.find({ text: /borra sus worktrees\. La rama y la PR quedan\./ }));
      await view.press({ text: "Sí, abortar el run" });
      assert.deepEqual(sent, [
        { run: runs.find((r) => r.clave === clave)?.id, decision: { accion: "abortar" } },
      ]);
    },
  );
});

// Si regresiona, el panel aprueba un plan que cambia lo que ya existe sin mostrarlo, o flowrunner
// rechaza la aprobación porque el panel no manda que la persona lo aceptó.
test("aprobar un plan que cambia lo existente muestra los cambios y manda que se aceptaron", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const cambio = { que: "el alta rechaza otro dominio", donde: "a.ts:42", criterio: "AC-1" };
  const withChanges = runs.map((r) => (r.id === PIZ3 ? { ...r, cambiaLoExistente: [cambio] } : r));
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: withChanges, at: 0 }),
        "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
        "flowrunner.decidir": (input: { run: string; decision: Decision }) => {
          sent.push(input);
          return { ok: true, mensaje: "hecho" };
        },
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: /^⚠ El plan cambia lo que ya existe \(1\): miralo/ }));
      await view.press({ role: "button", text: "Plan" });
      await view.press({ role: "button", text: "Aprobar" });
      assert.ok(view.find({ text: "• el alta rechaza otro dominio (a.ts:42) ← AC-1" }));
      assert.equal(view.find({ text: "Sí, confirmar" }), null);
      assert.deepEqual(sent, []);
      await view.press({ role: "button", text: "Acepto los cambios y apruebo" });
      assert.deepEqual(sent, [
        { run: PIZ3, decision: { accion: "aprobar", aceptoCambios: true, plan: `${PIZ3}#1` } },
      ]);
    },
  );
});

/** El botón Aprobar de la fila de decisiones, no el link de la etapa. */
const approveButton = (view: View) => view.find({ role: "button", text: "Aprobar" });
const disabled = (view: View) => approveButton(view)?.disabled === true;
/** Los runs del fixture, con PIZ-3 replanificado: una sesión más de planificar. */
const replanned = runs.map((r): Run =>
  r.id === PIZ3
    ? {
        ...r,
        fases: r.fases.map((p) =>
          p.fase === "planificar" ? { ...p, sesiones: [...p.sesiones, ...p.sesiones] } : p,
        ),
      }
    : r,
);

// Si regresiona, se aprueba desde Orca un plan que nadie abrió: en VF-6, cuatro aprobaciones a
// segundos del plan listo, y la de las 01:08 costó unos US$ 6 (D3).
test("Aprobar está deshabilitado hasta abrir el plan de ese run en Orca", async () => {
  const sent: unknown[] = [];
  await withPanel(
    withRuns({
      "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
      "flowrunner.decidir": (input: unknown) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
    async (view) => {
      assert.ok(approveButton(view));
      assert.equal(disabled(view), true);
      assert.ok(view.find({ text: "Abrí el plan para poder aprobar." }));
      await view.press({ role: "button", text: "Plan" });
      assert.equal(disabled(view), false);
      assert.equal(view.find({ text: "Abrí el plan para poder aprobar." }), null);
      await view.press({ role: "button", text: "Aprobar" });
      await view.press({ text: "Sí, confirmar" });
      // Manda la versión que abrió: el worker no aprueba si el plan cambió desde entonces.
      assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar", plan: `${PIZ3}#1` } }]);
    },
  );
});

test("si el plan no se pudo abrir, Aprobar sigue deshabilitado", async () => {
  await withPanel(
    withRuns({ "flowrunner.abrir": () => ({ ok: false, mensaje: "Orca no abrió el archivo" }) }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      assert.ok(view.find({ text: "Orca no abrió el archivo" }));
      assert.equal(disabled(view), true);
    },
  );
});

test("un plan nuevo después de pedir cambios hay que abrirlo de nuevo", async () => {
  let current = runs;
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: current, at: 0 }),
        "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
      },
    }),
    async (view) => {
      // El link de la etapa Aprobar también abre el plan, y también cuenta.
      const link = view.findAll({ type: "Link", text: "Aprobar" })[0];
      if (link === undefined) throw new Error("sin el link de la etapa Aprobar");
      await view.press(link);
      assert.equal(disabled(view), false);
      current = replanned;
      await panel.refresh();
      await view.settled();
      assert.equal(disabled(view), true);
      assert.ok(view.find({ text: "Abrí el plan para poder aprobar." }));
    },
  );
});

// Si regresiona, un «Aprobar» que se tocó sobre un plan y quedó sin confirmar aprueba el plan corregido
// que llegó después, sin que nadie lo abra.
test("una aprobación a medio confirmar no vale para el plan corregido que llegó después", async () => {
  let current = runs;
  const sent: unknown[] = [];
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: current, at: 0 }),
        "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
        "flowrunner.decidir": (input: unknown) => {
          sent.push(input);
          return { ok: true, mensaje: "hecho" };
        },
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      await view.press({ role: "button", text: "Aprobar" });
      assert.ok(view.find({ text: "Sí, confirmar" }));
      current = replanned;
      await panel.refresh();
      await view.settled();
      assert.equal(view.find({ text: "Sí, confirmar" }), null);
      assert.equal(disabled(view), true);
      // Abrir el plan corregido no hace volver la confirmación del anterior: hay que tocar Aprobar.
      await view.press({ role: "button", text: "Plan" });
      assert.equal(view.find({ text: "Sí, confirmar" }), null);
      assert.equal(disabled(view), false);
      assert.deepEqual(sent, []);
    },
  );
});

// Si regresiona, recargar el panel o reiniciar Orca obliga a abrir de nuevo un plan ya abierto.
test("después de recargar el panel, un plan ya abierto sigue habilitando Aprobar", async () => {
  const host = withRuns({ "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }) });
  let persisted: View["persisted"] | undefined;
  await withPanel(host, async (view) => {
    assert.equal(disabled(view), true);
    await view.press({ role: "button", text: "Plan" });
    assert.equal(disabled(view), false);
    persisted = view.persisted;
  });
  const again = await mount(panel, { host, persisted });
  try {
    assert.equal(disabled(again), false);
  } finally {
    await again.unmount();
  }
});

// Si regresiona, lo que el panel guarda de los planes abiertos crece con cada run, o una lectura que
// falla hace olvidar un plan ya abierto.
test("el plan abierto de un run que ya no está activo se olvida; una lectura con error no olvida nada", async () => {
  let current: { runs: Run[]; at: number; error?: string } = { runs, at: 0 };
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => current,
        "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      assert.deepEqual(view.persisted.plugin.planesVistos, { [PIZ3]: `${PIZ3}#1` });
      current = { runs: [], at: 1, error: "timeout" };
      await panel.refresh();
      await view.settled();
      assert.deepEqual(view.persisted.plugin.planesVistos, { [PIZ3]: `${PIZ3}#1` });
      current = { runs: runs.filter((r) => r.id !== PIZ3), at: 2 };
      await panel.refresh();
      await view.settled();
      assert.deepEqual(view.persisted.plugin.planesVistos, {});
    },
  );
});

// Si regresiona, cambiar de proyecto en Orca y volver obliga a abrir otra vez el plan de un run que
// sigue esperando: la lectura filtrada por proyecto no trae los runs activos de los demás.
test("al cambiar de proyecto, el plan abierto de un run del otro sigue recordado; uno cerrado se olvida", async () => {
  let current: { runs: Run[]; at: number; proyecto: string; otros: number; cerrados?: Run[] } = {
    runs,
    at: 0,
    proyecto: "pizarra",
    otros: 0,
  };
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => current,
        "flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" }),
      },
    }),
    async (view) => {
      await view.press({ role: "button", text: "Plan" });
      current = { runs: [], at: 1, proyecto: "otro", otros: runs.length };
      await panel.refresh();
      await view.settled();
      assert.deepEqual(view.persisted.plugin.planesVistos, { [PIZ3]: `${PIZ3}#1` });
      // Con otros proyectos activos, lo que se olvida es lo que la lectura dice cerrado.
      const piz3 = runs.find((r) => r.id === PIZ3) as Run;
      current = {
        runs: [],
        at: 2,
        proyecto: "pizarra",
        otros: 2,
        cerrados: [{ ...piz3, status: "abortado" }],
      };
      await panel.refresh();
      await view.settled();
      assert.deepEqual(view.persisted.plugin.planesVistos, {});
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

// Si regresiona, cambiar de proyecto en Orca abre el informe de cada run entregado del proyecto anterior,
// como si se hubiera cerrado.
test("al cambiar de proyecto, los runs del anterior se dejan de ver sin abrir su informe", async () => {
  let current: { runs: typeof runs; at: number; proyecto: string; otros: number } = {
    runs,
    at: 0,
    proyecto: "videoFactory",
    otros: 0,
  };
  const opened: unknown[] = [];
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => current,
        "flowrunner.abrir": (input: unknown) => {
          opened.push(input);
          return { ok: true, mensaje: "abierto" };
        },
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: "videoFactory" }));
      current = { runs: [], at: 1, proyecto: "pizarra-en-vivo", otros: runs.length };
      await panel.refresh();
      await view.settled();
      assert.deepEqual(opened, []);
      // El título y la descripción del vacío se leen como su etiqueta y su texto.
      const empty = view.find({ label: "No hay runs activos en pizarra-en-vivo" });
      assert.ok(empty);
      assert.match(
        empty.text,
        /3 runs activos en otros proyectos: cambiá de proyecto en Orca para verlos\./,
      );
    },
  );
});

// Si regresiona, los runs cerrados desaparecen del panel, lo llenan con tarjetas enteras, o uno
// abortado aparece trabajando.
test("los cerrados van aparte y compactos; el título abre el informe y la flecha sus etapas", async () => {
  const base = runs[2] as Run;
  const closed = {
    ...base,
    id: "VF-0-20261101-102507",
    clave: "VF-0",
    status: "abortado",
    costoUsd: 5.22,
    segundos: 527,
    // El árbol dice que aprobar seguía corriendo cuando se abortó.
    fases: base.fases.map((f) => (f.fase === "aprobar" ? { ...f, estado: "corriendo" } : f)),
  } as Run;
  const opened: unknown[] = [];
  await withPanel(
    mockHost({
      requests: {
        "flowrunner.runs": () => ({ runs: [], cerrados: [closed], at: 0 }),
        "flowrunner.abrir": (input: unknown) => {
          opened.push(input);
          return { ok: true, mensaje: "" };
        },
      },
    }),
    async (view) => {
      assert.ok(view.find({ text: "CERRADOS · 1" }));
      assert.equal(view.find({ text: `VF-0 · ${closed.titulo}` }), null);
      await view.press({ label: "Ver los runs cerrados" });
      assert.ok(view.find({ text: `VF-0 · ${closed.titulo}` }));
      assert.ok(view.find({ text: "abortado · 01/11 10:25 · 8:47 · $5.22" }));
      assert.equal(view.findAll({ type: "Card" }).length, 0);
      await view.press({ text: `VF-0 · ${closed.titulo}` });
      assert.deepEqual(opened, [{ run: closed.id, que: { tipo: "informe" } }]);
      // Desplegado: solo las etapas que corrieron, ninguna trabajando, y sin abortar.
      await view.press({ label: "Ver las etapas de VF-0" });
      assert.ok(view.find({ text: "Preparar" }));
      assert.equal(view.find({ text: "Implementar" }), null);
      assert.equal(view.find({ text: "trabajando" }), null);
      assert.equal(view.find({ label: "Aprobar: trabajando" }), null);
      assert.ok(view.find({ text: "cortada" }));
      assert.equal(view.find({ text: "Abortar el run" }), null);
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

// Si regresiona, al cambiar de proyecto la pestaña queda casi en blanco hasta que llegan los runs.
test("antes de la primera lectura muestra la nave en camino", async () => {
  // Solo el componente, sin `setup`: queda en el estado de antes de leer los runs.
  const view = await mount(panel.default, { host: mockHost() });
  try {
    assert.ok(view.find({ type: "Image" }));
    assert.ok(view.find({ text: "Leyendo los runs…" }));
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.refusals, []);
  } finally {
    await view.unmount();
  }
});

// Si regresiona, al cambiar de proyecto se ven los runs del anterior hasta el próximo refresco.
test("al cambiar de workspace lee enseguida; un cambio de sus terminales no cuenta", async () => {
  let pedidos = 0;
  let proyecto = "uno";
  const host = mockHost({
    requests: {
      "flowrunner.runs": () => {
        pedidos += 1;
        return { runs: proyecto === "uno" ? runs : [], at: 0, proyecto };
      },
    },
  });
  const focused = (displayName: string, terminals: { id: string }[] = []) => ({
    context: { branch: "main", displayName, terminals },
  });
  await withPanel(host, async (view) => {
    await view.emit("workspace.changed", focused("uno"));
    assert.ok(view.findAll({ type: "Card" }).length > 0);
    const antes = pedidos;
    await view.emit("workspace.changed", focused("uno", [{ id: "t1" }]));
    assert.equal(pedidos, antes);
    proyecto = "dos";
    await view.emit("workspace.changed", focused("dos"));
    assert.equal(pedidos, antes + 1);
    assert.equal(view.findAll({ type: "Card" }).length, 0);
    assert.ok(
      view.find({ label: "No hay runs activos en dos" }) ??
        view.find({ text: "No hay runs activos en dos" }),
    );
  });
});
