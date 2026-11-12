// La pestaña de los runs con un worker simulado: las tarjetas, las etapas, el detalle, las
// decisiones y un refresco que no borra lo que se ve. Se maneja como una persona: lee el HTML que se
// dibuja y toca los controles por su texto o su etiqueta, con la acción que lleva cada uno.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import { ABIERTOS, PLANES_VISTOS, Panel, type Api } from "./estado";
import type { Openable, Outcome, Snapshot } from "./protocol";
import type { Decision, Run } from "./runs";
import { parseWatch } from "./runs";
import type { Accion } from "./vista";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
// PIZ-9 con su recorrido: en curso, con implementar rehaciendo ST-1, y entregado.
const [enCurso, entregado] = parseWatch(
  readFileSync(new URL("../test/recorrido.json", import.meta.url), "utf8"),
) as [Run, Run];
const PIZ3 = "PIZ-3-20261109-010000";
const VF2 = "VF-2-20261109-001527";

// --- Un worker y un storage simulados --------------------------------------------------------

interface Fake {
  runs?: () => Snapshot;
  abrir?: (input: { run: string; que: Openable }) => Outcome;
  decidir?: (input: { run: string; decision: Decision }) => Outcome;
  storage?: Record<string, unknown>;
}

function fakeApi(f: Fake): Api & { storage: Record<string, unknown>; pedidos: () => number } {
  const storage = f.storage ?? {};
  let pedidos = 0;
  const unknown = (name: string) => () => Promise.reject(new Error(`unknown_method: ${name}`));
  return {
    storage,
    pedidos: () => pedidos,
    runs: () => {
      pedidos += 1;
      return Promise.resolve(f.runs?.() ?? { runs, at: 0 });
    },
    abrir:
      f.abrir === undefined
        ? unknown("flowrunner.abrir")
        : (run, que) => Promise.resolve(f.abrir?.({ run, que }) as Outcome),
    decidir:
      f.decidir === undefined
        ? unknown("flowrunner.decidir")
        : (run, decision) => Promise.resolve(f.decidir?.({ run, decision }) as Outcome),
    leer: (key) => Promise.resolve(storage[key] ?? null),
    guardar: (key, value) => {
      storage[key] = value;
      return Promise.resolve();
    },
    externo: () => Promise.resolve(),
    ahora: () => 0,
  };
}

/** Abre el panel como Orca: carga lo guardado y lee los runs. */
async function abrirPanel(api: Api): Promise<Panel> {
  const panel = new Panel(api);
  await panel.cargar();
  await panel.refresh();
  return panel;
}

// --- Leer lo que se dibuja --------------------------------------------------------------------

const unesc = (t: string) =>
  t
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

/** Lo que una persona lee: el texto sin etiquetas, con los espacios juntos. */
const visible = (html: string) =>
  unesc(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

interface Control {
  readonly texto: string;
  readonly label: string | undefined;
  readonly clase: string;
  readonly disabled: boolean;
  readonly accion: Accion;
}

/** Los botones y links, con su acción. */
function controles(html: string): Control[] {
  return [...html.matchAll(/<button ([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = m[1] ?? "";
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
    return {
      texto: visible(m[2] ?? ""),
      label: ((l) => (l === undefined ? undefined : unesc(l)))(attr("aria-label")),
      clase: attr("class") ?? "",
      disabled: / disabled(?:\s|$)/.test(attrs),
      accion: JSON.parse(unesc(attr("data-accion") ?? "null")) as Accion,
    };
  });
}

type Query = string | { label: string } | { texto: string; link: boolean };

const matches = (c: Control, q: Query) =>
  typeof q === "string"
    ? c.texto === q || c.label === q
    : "label" in q
      ? c.label === q.label
      : c.texto === q.texto && c.clase.startsWith("lnk") === q.link;

const find = (panel: Panel, q: Query) => controles(panel.html()).find((c) => matches(c, q));
const findAll = (panel: Panel, q: Query) => controles(panel.html()).filter((c) => matches(c, q));

const isControl = (q: Query | Control): q is Control => typeof q === "object" && "accion" in q;

async function press(panel: Panel, q: Query | Control): Promise<void> {
  const c = isControl(q) ? q : find(panel, q);
  if (c === undefined) throw new Error(`no hay un control ${JSON.stringify(q)}`);
  if (c.disabled) throw new Error(`el control ${c.texto} está deshabilitado`);
  await panel.tocar(c.accion);
}

/** Escribe en el campo de texto, que tiene que tener esa etiqueta, y lo manda con Enter. */
async function type(panel: Panel, label: string, text: string): Promise<void> {
  const input = /<input id="fr-texto" ([^>]*)>/.exec(panel.html())?.[1];
  if (input === undefined) throw new Error("no hay campo de texto");
  assert.equal(unesc(/aria-label="([^"]*)"/.exec(input)?.[1] ?? ""), label);
  panel.escribir(text);
  const enviar = /data-enviar="([^"]*)"/.exec(input)?.[1] ?? "null";
  await panel.tocar(JSON.parse(unesc(enviar)) as Accion);
}

const approveButton = (panel: Panel) => find(panel, { texto: "Aprobar", link: false });
const disabled = (panel: Panel) => approveButton(panel)?.disabled === true;
const sees = (panel: Panel, text: string) => visible(panel.html()).includes(text);
const cards = (panel: Panel) => (panel.html().match(/<article class="tarjeta"/g) ?? []).length;

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

// --- Las tarjetas y las etapas ----------------------------------------------------------------

// Si regresiona, el panel deja de leerse de un vistazo: el estado, el tiempo y las etapas en lista.
test("cada run: su estado, el título, el tiempo y las etapas en lista; la que trabaja se mueve", async () => {
  const panel = await abrirPanel(fakeApi({}));
  const html = panel.html();
  assert.deepEqual(
    [...html.matchAll(/<span class="chip [^"]*">([^<]*)<\/span>/g)].map((m) => m[1]),
    ["TE ESPERA", "EN CURSO", "PR ABIERTA"],
  );
  assert.ok(sees(panel, "Modo oscuro"));
  assert.ok(sees(panel, "PIZ-3 · PIZ-3-20261109-010000"));
  assert.ok(sees(panel, "20:00"));
  assert.ok(sees(panel, "Verificar"));
  assert.ok(sees(panel, "te espera"));
  // La que trabaja lleva el indicador animado de su etapa, con su estado para lectores de pantalla.
  assert.match(
    html,
    /<svg class="fr-i fr-implementar t-accent" style="--fr-t:-\d+ms" role="img" aria-label="Implementar: trabajando"/,
  );
  assert.match(html, /class="fr-i fr-te-espera t-warning"[^>]*aria-label="Aprobar: te espera"/);
});

// Si regresiona, un run terminado vuelve a ocupar el panel con todas sus etapas.
test("un run terminado muestra solo su etapa actual hasta que se abre", async () => {
  const panel = await abrirPanel(fakeApi({}));
  assert.ok(sees(panel, "espera merge"));
  const count = () => (visible(panel.html()).match(/Preparar/g) ?? []).length;
  const before = count();
  await press(panel, { label: "Ver las etapas de VF-1" });
  assert.equal(count(), before + 1);
  assert.ok(find(panel, "Abrir la PR"));
});

test("abrir o cerrar una tarjeta se guarda y vale después de recargar", async () => {
  const api = fakeApi({});
  const panel = await abrirPanel(api);
  await press(panel, { label: "Ver las etapas de VF-1" });
  assert.deepEqual(api.storage[ABIERTOS], { "VF-1-20261108-211454": true });
  const again = await abrirPanel(api);
  assert.ok(find(again, { label: "Ocultar las etapas de VF-1" }));
});

// Si regresiona, no se ve qué hace la sesión que corre, o sus pasos no se abren en una pestaña.
test("las sub-tasks con su estado; Pasos y Plan piden abrir su archivo en una pestaña", async () => {
  const opened: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
  );
  assert.ok(find(panel, "ST-1 Tabla de precios · integrada"));
  assert.match(panel.html(), /class="fr-i fr-tarea-lista t-success"/);
  assert.ok(sees(panel, "▸ Edit src/precio.ts · ctx 52k"));
  await press(panel, { label: "Pasos de implementar-ST-2-1" });
  await press(panel, { texto: "Plan", link: false });
  assert.deepEqual(opened, [
    { run: VF2, que: { tipo: "pasos", sesion: "implementar-ST-2-1" } },
    { run: PIZ3, que: { tipo: "plan" } },
  ]);
});

// Si regresiona, un plan ya aprobado no se puede volver a ver desde el panel.
test("tocar Aprobar abre el plan, también el de un run que ya lo aprobó", async () => {
  const opened: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
  );
  // PIZ-3 espera aprobación; VF-2 ya pasó de planificar. Los dos tienen plan para ver.
  const links = findAll(panel, { texto: "Aprobar", link: true });
  assert.equal(links.length, 2);
  for (const link of links) await press(panel, link);
  assert.deepEqual(opened, [
    { run: PIZ3, que: { tipo: "plan" } },
    { run: VF2, que: { tipo: "plan" } },
  ]);
});

// Si regresiona, el detalle de una etapa no se puede abrir desde el panel, o se ofrece en una que
// todavía no arrancó.
test("tocar una etapa que arrancó abre su detalle; una pendiente no es un link", async () => {
  const opened: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
  );
  await press(panel, { texto: "Implementar", link: true });
  assert.deepEqual(opened, [{ run: VF2, que: { tipo: "etapa", fase: "implementar" } }]);
  // Ningún run en vista llegó a verificar: la etapa es texto, no un link.
  assert.equal(findAll(panel, { texto: "Verificar", link: true }).length, 0);
  assert.ok(sees(panel, "Verificar"));
});

// Si regresiona, un archivo que no se pudo abrir falla en silencio.
test("si no se puede abrir, lo dice en el run", async () => {
  const panel = await abrirPanel(
    fakeApi({ abrir: () => ({ ok: false, mensaje: "Orca no abrió el archivo" }) }),
  );
  await press(panel, { label: "Pasos de implementar-ST-2-1" });
  assert.ok(sees(panel, "Orca no abrió el archivo"));
});

// --- Las decisiones ---------------------------------------------------------------------------

// Si regresiona, aprobar desde el panel no llega a flowrunner, o aprueba sin confirmar.
test("aprobar pide confirmación; Cambios manda el motivo escrito", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const panel = await abrirPanel(
    fakeApi({
      abrir: () => ({ ok: true, mensaje: "abierto" }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
  );
  await press(panel, { texto: "Plan", link: false });
  await press(panel, { texto: "Aprobar", link: false });
  assert.deepEqual(sent, []);
  await press(panel, "Sí, confirmar");
  assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar", plan: `${PIZ3}#1` } }]);
  await press(panel, "Cambios");
  await type(panel, "Qué cambiar del plan", "separá la validación");
  assert.deepEqual(sent[1], {
    run: PIZ3,
    decision: { accion: "cambios", motivo: "separá la validación" },
  });
});

test("un texto vacío no se manda: Enviar está deshabilitado y Enter no hace nada", async () => {
  const sent: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
  );
  await press(panel, "Cambios");
  assert.equal(find(panel, "Enviar")?.disabled, true);
  await type(panel, "Qué cambiar del plan", "   ");
  assert.deepEqual(sent, []);
});

// Si regresiona, un run que se detuvo con una pregunta no se puede responder desde el panel.
test("un run detenido muestra Arreglar ST-n, que pide qué corregir y lo manda", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const asked = runs.map((r): Run =>
    r.id === VF2
      ? {
          ...r,
          status: "detenido",
          motivo: "verificar: AC-2 sigue en rojo",
          siguiente: `flowrunner fix ${VF2} --unidad ST-2 "<qué cambiar>"`,
          unidades: ["ST-2"],
          opciones: [
            {
              comando: `flowrunner fix ${VF2} --unidad ST-2 "<qué cambiar>"`,
              que: "que ST-2 lo corrija",
            },
            { comando: `flowrunner fix ${VF2} --auto`, que: "formateador y lint" },
            { comando: `flowrunner fix ${VF2} --yo`, que: "lo arreglás vos" },
            { comando: `flowrunner accept ${VF2} "<por qué>"`, que: "seguir igual" },
            { comando: `flowrunner abort ${VF2}`, que: "cortar el run" },
          ],
        }
      : r,
  );
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: asked, at: 0 }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "arreglando ST-2" };
      },
    }),
  );
  assert.ok(sees(panel, "Parece ser de: ST-2"));
  // «Lo arreglo yo» quedó solo en el CLI: en el panel lo reemplaza Autofix (ADR 0026).
  assert.ok(find(panel, "Autofix"));
  assert.equal(find(panel, "Lo arreglo yo"), undefined);
  assert.ok(find(panel, "Seguir igual"));
  await press(panel, "Arreglar ST-2");
  assert.deepEqual(sent, []);
  await type(panel, "Qué tiene que corregir ST-2", "el CSV lleva BOM");
  assert.deepEqual(sent, [
    { run: VF2, decision: { accion: "arreglar", unidad: "ST-2", instruccion: "el CSV lleva BOM" } },
  ]);
});

// Si regresiona, la persona tiene que escribir el arreglo que flowrunner ya trae (PIZ-3), o tocarlo
// no lo manda: elegirlo es la confirmación, como en el CLI.
test("un arreglo escrito se manda con un toque, con su texto, y Arreglar ST-n sigue para escribir otro", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const instruccion = "Subí `engines.node` a `>=24` en package.json";
  const asked = runs.map((r): Run =>
    r.id === VF2
      ? {
          ...r,
          status: "detenido",
          motivo: "revisar: unpdf pide Node 24",
          siguiente: `flowrunner fix ${VF2} --unidad ST-2 'x'`,
          unidades: ["ST-2"],
          opciones: [
            {
              comando: `flowrunner fix ${VF2} --unidad ST-2 'x'`,
              que: `que ST-2 lo corrija así: ${instruccion}`,
              arreglo: { unidad: "ST-2", instruccion },
            },
            {
              comando: `flowrunner fix ${VF2} --unidad ST-2 "<qué cambiar>"`,
              que: "que ST-2 lo corrija",
            },
            { comando: `flowrunner fix ${VF2} --auto`, que: "formateador y lint" },
            { comando: `flowrunner abort ${VF2}`, que: "cortar el run" },
          ],
        }
      : r,
  );
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: asked, at: 0 }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "arreglando ST-2" };
      },
    }),
  );
  assert.equal(findAll(panel, "Arreglar ST-2").length, 1);
  await press(panel, `ST-2 · ${instruccion}`);
  assert.deepEqual(sent, [
    { run: VF2, decision: { accion: "arreglar", unidad: "ST-2", instruccion } },
  ]);
});

// Si regresiona, un run vivo no se puede abortar desde el panel, o se aborta sin confirmar.
test("cada run vivo tiene «Abortar el run» al pie, que pide confirmación antes de mandarlo", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const panel = await abrirPanel(
    fakeApi({
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "abortado; las ramas quedan" };
      },
    }),
  );
  const buttons = findAll(panel, "Abortar el run");
  assert.equal(buttons.length, runs.length);
  // Al pie de la tarjeta, después de las etapas, no entre ellas.
  const drawn = visible(panel.html());
  assert.ok(drawn.lastIndexOf("Abortar el run") > drawn.lastIndexOf("Aprender"));
  const first = buttons[0];
  if (first === undefined) throw new Error("sin botón Abortar");
  await press(panel, first);
  assert.deepEqual(sent, []);
  const clave = /¿Abortar el run ([A-Z]+-\d+)\?/.exec(visible(panel.html()))?.[1];
  assert.ok(sees(panel, "borra sus worktrees. La rama y la PR quedan."));
  await press(panel, "Sí, abortar el run");
  assert.deepEqual(sent, [
    { run: runs.find((r) => r.clave === clave)?.id, decision: { accion: "abortar" } },
  ]);
});

// Si regresiona, el panel aprueba un plan que cambia lo que ya existe sin mostrarlo, o flowrunner
// rechaza la aprobación porque el panel no manda que la persona lo aceptó.
test("aprobar un plan que cambia lo existente muestra los cambios y manda que se aceptaron", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const cambio = { que: "el alta rechaza otro dominio", donde: "a.ts:42", criterio: "AC-1" };
  const withChanges = runs.map((r) => (r.id === PIZ3 ? { ...r, cambiaLoExistente: [cambio] } : r));
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: withChanges, at: 0 }),
      abrir: () => ({ ok: true, mensaje: "abierto" }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
  );
  assert.ok(sees(panel, "⚠ El plan cambia lo que ya existe (1): miralo"));
  await press(panel, { texto: "Plan", link: false });
  await press(panel, { texto: "Aprobar", link: false });
  assert.ok(sees(panel, "• el alta rechaza otro dominio (a.ts:42) ← AC-1"));
  assert.equal(find(panel, "Sí, confirmar"), undefined);
  assert.deepEqual(sent, []);
  await press(panel, "Acepto los cambios y apruebo");
  assert.deepEqual(sent, [
    { run: PIZ3, decision: { accion: "aprobar", plan: `${PIZ3}#1`, aceptoCambios: true } },
  ]);
});

// Si regresiona, se aprueba desde Orca un plan que nadie abrió: en VF-6, cuatro aprobaciones a
// segundos del plan listo, y la de las 01:08 costó unos US$ 6 (D3).
test("Aprobar está deshabilitado hasta abrir el plan de ese run en Orca", async () => {
  const sent: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      abrir: () => ({ ok: true, mensaje: "abierto" }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
  );
  assert.ok(approveButton(panel));
  assert.equal(disabled(panel), true);
  assert.ok(sees(panel, "Abrí el plan para poder aprobar."));
  await press(panel, { texto: "Plan", link: false });
  assert.equal(disabled(panel), false);
  assert.equal(sees(panel, "Abrí el plan para poder aprobar."), false);
  await press(panel, { texto: "Aprobar", link: false });
  await press(panel, "Sí, confirmar");
  // Manda la versión que abrió: el worker no aprueba si el plan cambió desde entonces.
  assert.deepEqual(sent, [{ run: PIZ3, decision: { accion: "aprobar", plan: `${PIZ3}#1` } }]);
});

test("si el plan no se pudo abrir, Aprobar sigue deshabilitado", async () => {
  const panel = await abrirPanel(
    fakeApi({ abrir: () => ({ ok: false, mensaje: "Orca no abrió el archivo" }) }),
  );
  await press(panel, { texto: "Plan", link: false });
  assert.ok(sees(panel, "Orca no abrió el archivo"));
  assert.equal(disabled(panel), true);
});

test("un plan nuevo después de pedir cambios hay que abrirlo de nuevo", async () => {
  let current = runs;
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: current, at: 0 }),
      abrir: () => ({ ok: true, mensaje: "abierto" }),
    }),
  );
  // El link de la etapa Aprobar también abre el plan, y también cuenta.
  const link = findAll(panel, { texto: "Aprobar", link: true })[0];
  if (link === undefined) throw new Error("sin el link de la etapa Aprobar");
  await press(panel, link);
  assert.equal(disabled(panel), false);
  current = replanned;
  await panel.refresh();
  assert.equal(disabled(panel), true);
  assert.ok(sees(panel, "Abrí el plan para poder aprobar."));
});

// Si regresiona, un «Aprobar» que se tocó sobre un plan y quedó sin confirmar aprueba el plan corregido
// que llegó después, sin que nadie lo abra.
test("una aprobación a medio confirmar no vale para el plan corregido que llegó después", async () => {
  let current = runs;
  const sent: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: current, at: 0 }),
      abrir: () => ({ ok: true, mensaje: "abierto" }),
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "hecho" };
      },
    }),
  );
  await press(panel, { texto: "Plan", link: false });
  await press(panel, { texto: "Aprobar", link: false });
  assert.ok(find(panel, "Sí, confirmar"));
  current = replanned;
  await panel.refresh();
  assert.equal(find(panel, "Sí, confirmar"), undefined);
  assert.equal(disabled(panel), true);
  // Abrir el plan corregido no hace volver la confirmación del anterior: hay que tocar Aprobar.
  await press(panel, { texto: "Plan", link: false });
  assert.equal(find(panel, "Sí, confirmar"), undefined);
  assert.equal(disabled(panel), false);
  assert.deepEqual(sent, []);
});

// Si regresiona, recargar el panel o reiniciar Orca obliga a abrir de nuevo un plan ya abierto.
test("después de recargar el panel, un plan ya abierto sigue habilitando Aprobar", async () => {
  const api = fakeApi({ abrir: () => ({ ok: true, mensaje: "abierto" }) });
  const panel = await abrirPanel(api);
  assert.equal(disabled(panel), true);
  await press(panel, { texto: "Plan", link: false });
  assert.equal(disabled(panel), false);
  const again = await abrirPanel(api);
  assert.equal(disabled(again), false);
});

test("lo guardado por otra versión, con otra forma, no rompe el panel", async () => {
  const api = fakeApi({
    storage: { [PLANES_VISTOS]: ["no", "es", "un objeto"], [ABIERTOS]: { x: "sí" } },
  });
  const panel = await abrirPanel(api);
  assert.equal(disabled(panel), true);
  assert.equal(cards(panel), runs.length);
});

// Si regresiona, lo que el panel guarda de los planes abiertos crece con cada run, o una lectura que
// falla hace olvidar un plan ya abierto.
test("el plan abierto de un run que ya no está activo se olvida; una lectura con error no olvida nada", async () => {
  let current: Snapshot = { runs, at: 0 };
  const api = fakeApi({ runs: () => current, abrir: () => ({ ok: true, mensaje: "abierto" }) });
  const panel = await abrirPanel(api);
  await press(panel, { texto: "Plan", link: false });
  assert.deepEqual(api.storage[PLANES_VISTOS], { [PIZ3]: `${PIZ3}#1` });
  current = { runs: [], at: 1, error: "timeout" };
  await panel.refresh();
  assert.deepEqual(api.storage[PLANES_VISTOS], { [PIZ3]: `${PIZ3}#1` });
  current = { runs: runs.filter((r) => r.id !== PIZ3), at: 2 };
  await panel.refresh();
  assert.deepEqual(api.storage[PLANES_VISTOS], {});
});

// Si regresiona, cambiar de proyecto en Orca y volver obliga a abrir otra vez el plan de un run que
// sigue esperando: la lectura filtrada por proyecto no trae los runs activos de los demás.
test("al cambiar de proyecto, el plan abierto de un run del otro sigue recordado; uno cerrado se olvida", async () => {
  let current: Snapshot = { runs, at: 0, proyecto: "pizarra", otros: 0 };
  const api = fakeApi({ runs: () => current, abrir: () => ({ ok: true, mensaje: "abierto" }) });
  const panel = await abrirPanel(api);
  await press(panel, { texto: "Plan", link: false });
  current = { runs: [], at: 1, proyecto: "otro", otros: runs.length };
  await panel.refresh();
  assert.deepEqual(api.storage[PLANES_VISTOS], { [PIZ3]: `${PIZ3}#1` });
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
  assert.deepEqual(api.storage[PLANES_VISTOS], {});
});

// --- La lectura -------------------------------------------------------------------------------

// Regresión: una lectura que fallaba dejaba el panel sin runs hasta la siguiente, y todo parpadeaba.
test("si una lectura falla, los runs que se veían quedan, con el error arriba", async () => {
  let fail = false;
  const panel = await abrirPanel(
    fakeApi({ runs: () => (fail ? { runs: [], error: "timeout", at: 1 } : { runs, at: 0 }) }),
  );
  assert.ok(sees(panel, "Modo oscuro"));
  fail = true;
  await panel.refresh();
  assert.ok(sees(panel, "Modo oscuro"));
  assert.ok(sees(panel, "No se pudo leer flowrunner: timeout"));
});

test("si el worker no contesta, los runs que se veían quedan, con el motivo arriba", async () => {
  let fail = false;
  const api = fakeApi({});
  const ok = api.runs;
  api.runs = () => (fail ? Promise.reject(new Error("timeout del worker")) : ok());
  const panel = await abrirPanel(api);
  fail = true;
  await panel.refresh();
  assert.ok(sees(panel, "Modo oscuro"));
  assert.ok(sees(panel, "No se pudo leer flowrunner: timeout del worker"));
});

// Si regresiona, después de mergear la PR hay que esperar el chequeo de cada 10 minutos para aprender.
test("Aprender ahora, en un run con la PR abierta, aprende sin esperar y muestra lo que dijo", async () => {
  const sent: { run: string; decision: Decision }[] = [];
  const panel = await abrirPanel(
    fakeApi({
      decidir: (input) => {
        sent.push(input);
        return { ok: true, mensaje: "la PR sigue abierta" };
      },
    }),
  );
  await press(panel, "Aprender ahora");
  assert.deepEqual(sent, [{ run: "VF-1-20261108-211454", decision: { accion: "aprender" } }]);
  assert.ok(sees(panel, "la PR sigue abierta"));
});

// Si regresiona, el run desaparece del panel al cerrarse y la persona no ve cómo terminó.
test("cuando un run con la PR abierta se cierra, su informe se abre solo, una vez", async () => {
  let current = runs;
  const opened: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: current, at: 0 }),
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
  );
  // VF-1 estaba entregado; el chequeo vio el merge y lo cerró: ya no está entre los activos.
  current = runs.filter((r) => r.clave !== "VF-1");
  await panel.refresh();
  await panel.refresh();
  assert.deepEqual(opened, [{ run: "VF-1-20261108-211454", que: { tipo: "informe" } }]);
});

// Si regresiona, cambiar de proyecto en Orca abre el informe de cada run entregado del proyecto anterior,
// como si se hubiera cerrado.
test("al cambiar de proyecto, los runs del anterior se dejan de ver sin abrir su informe", async () => {
  let current: Snapshot = { runs, at: 0, proyecto: "videoFactory", otros: 0 };
  const opened: unknown[] = [];
  const panel = await abrirPanel(
    fakeApi({
      runs: () => current,
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "abierto" };
      },
    }),
  );
  assert.ok(sees(panel, "videoFactory"));
  current = { runs: [], at: 1, proyecto: "pizarra-en-vivo", otros: runs.length };
  await panel.refresh();
  assert.deepEqual(opened, []);
  assert.ok(sees(panel, "No hay runs activos en pizarra-en-vivo"));
  assert.ok(
    sees(panel, "3 runs activos en otros proyectos: cambiá de proyecto en Orca para verlos."),
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
  const panel = await abrirPanel(
    fakeApi({
      runs: () => ({ runs: [], cerrados: [closed], at: 0 }),
      abrir: (input) => {
        opened.push(input);
        return { ok: true, mensaje: "" };
      },
    }),
  );
  assert.ok(sees(panel, "CERRADOS · 1"));
  assert.equal(find(panel, `VF-0 · ${closed.titulo}`), undefined);
  await press(panel, { label: "Ver los runs cerrados" });
  assert.ok(find(panel, `VF-0 · ${closed.titulo}`));
  assert.ok(sees(panel, "abortado · 01/11 10:25 · 8:47 · $5.22"));
  assert.equal(cards(panel), 0);
  await press(panel, `VF-0 · ${closed.titulo}`);
  assert.deepEqual(opened, [{ run: closed.id, que: { tipo: "informe" } }]);
  // Desplegado: solo las etapas que corrieron, ninguna trabajando, y sin abortar.
  await press(panel, { label: "Ver las etapas de VF-0" });
  assert.ok(sees(panel, "Preparar"));
  assert.equal(sees(panel, "Implementar"), false);
  assert.equal(sees(panel, "trabajando"), false);
  assert.equal(panel.html().includes('aria-label="Aprobar: trabajando"'), false);
  assert.ok(sees(panel, "cortada"));
  assert.equal(find(panel, "Abortar el run"), undefined);
});

// Si regresiona, un flowrunner roto o sin runs deja el panel vacío sin decir por qué.
test("sin runs lo dice", async () => {
  const panel = await abrirPanel(fakeApi({ runs: () => ({ runs: [], at: 0 }) }));
  assert.ok(sees(panel, "No hay runs activos"));
});

// Si regresiona, al cambiar de proyecto la pestaña queda casi en blanco hasta que llegan los runs.
test("antes de la primera lectura muestra la nave en camino", () => {
  const panel = new Panel(fakeApi({}));
  assert.match(panel.html(), /<img src="\.\.\/assets\/nave\.png"/);
  assert.ok(sees(panel, "Leyendo los runs…"));
});

// Si regresiona, al cambiar de proyecto se ven los runs del anterior hasta el próximo refresco.
test("al cambiar de workspace lee enseguida; un cambio de sus terminales no cuenta", async () => {
  let proyecto = "uno";
  const api = fakeApi({ runs: () => ({ runs: proyecto === "uno" ? runs : [], at: 0, proyecto }) });
  const panel = await abrirPanel(api);
  await panel.workspace({ displayName: "uno", branch: "main" });
  assert.ok(cards(panel) > 0);
  const antes = api.pedidos();
  await panel.workspace({ displayName: "uno", branch: "main" });
  assert.equal(api.pedidos(), antes);
  proyecto = "dos";
  await panel.workspace({ displayName: "dos", branch: "main" });
  assert.equal(api.pedidos(), antes + 1);
  assert.equal(cards(panel), 0);
  assert.ok(sees(panel, "No hay runs activos en dos"));
});

// --- Lo que viene de flowrunner es texto -------------------------------------------------------

// Si regresiona, un título de feature con HTML se ejecuta en el panel en vez de leerse.
test("el texto de un run se muestra escapado, también dentro de una acción", async () => {
  const evil = runs.map((r): Run =>
    r.id === PIZ3 ? { ...r, titulo: `<img src=x onerror="alert(1)">`, clave: `PIZ-3"><b>` } : r,
  );
  const panel = await abrirPanel(fakeApi({ runs: () => ({ runs: evil, at: 0 }) }));
  const html = panel.html();
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes('"><b>'), false);
  assert.ok(sees(panel, `<img src=x onerror="alert(1)">`));
});

// --- El recorrido -------------------------------------------------------------------------------

// Si regresiona, la tarjeta vuelve a ser una foto de nueve etapas, o el detalle de ahora se repite.
test("el recorrido: cada paso con su hora, la vuelta con lo que pasó adentro, y ahora una sola vez", async () => {
  const panel = await abrirPanel(fakeApi({ runs: () => ({ runs: [enCurso], at: 0 }) }));
  const html = panel.html();
  for (const text of [
    "Aprobaste el plan",
    "Verificar volvió 2 veces → ST-1",
    "Autofix",
    "→ ST-1 · AC-9 sigue en rojo",
    "Verificar · Revisar · Probar · Entregar · Aprender",
  ])
    assert.ok(sees(panel, text), text);
  assert.match(visible(html), /Preparar \d\d:\d\d · 0:41/);
  assert.equal(html.includes('class="etapa'), false);
  assert.equal((html.match(/class="actual"/g) ?? []).length, 1);
  // Ahora va bajo el último paso: implementar, que rehace ST-1.
  assert.ok(html.indexOf('class="actual"') > html.lastIndexOf("Implementar"));
  assert.match(html, /class="vuelta abierta viva"/);
});

// Si regresiona, lo que plegaste se vuelve a abrir en el refresco o al recargar el panel.
test("plegar una vuelta la deja en una línea, y se guarda", async () => {
  const api = fakeApi({ runs: () => ({ runs: [enCurso], at: 0 }) });
  const panel = await abrirPanel(api);
  await press(panel, { label: "Plegar la vuelta de Verificar" });
  assert.deepEqual(api.storage[ABIERTOS], { [`${enCurso.id}:v1`]: false });
  assert.equal(sees(panel, "Autofix"), false);
  assert.ok(sees(panel, "Verificar volvió 2 veces → ST-1 · 4 pasos"));
  const again = await abrirPanel(api);
  assert.ok(find(again, { label: "Abrir la vuelta de Verificar" }));
  // Plegada la vuelta del paso que corre, ahora sigue a la vista: ahí están las decisiones.
  assert.equal((again.html().match(/class="actual"/g) ?? []).length, 1);
});

// Si regresiona, no se llega a las sub-tasks ni a las sesiones de una corrida terminada.
test("implementar se abre en sus sub-tasks, y cada sub-task en sus sesiones", async () => {
  const panel = await abrirPanel(fakeApi({ runs: () => ({ runs: [entregado], at: 0 }) }));
  await press(panel, { label: "Ver las etapas de PIZ-9" });
  const [first] = findAll(panel, { label: "Ver las sub-tasks de Implementar" });
  assert.ok(first);
  await press(panel, first);
  assert.ok(sees(panel, "ST-2 Conexiones en el frontend"));
  await press(panel, { label: "Ver las sesiones de ST-1" });
  assert.ok(find(panel, { label: "Pasos de implementar-ST-1-1" }));
  assert.ok(find(panel, { label: "Pasos de implementar-ST-1-2" }));
  assert.equal(find(panel, { label: "Pasos de implementar-ST-1-3" }), undefined);
});

// Si regresiona, un run cerrado se despliega en la lista de antes o con «Abortar el run».
test("un run cerrado se despliega en su recorrido, sin pendientes ni ahora", async () => {
  const closed = {
    ...entregado,
    status: "cerrado",
    recorrido: entregado.recorrido?.filter((p) => p.tipo !== "pendiente"),
  } as Run;
  const panel = await abrirPanel(
    fakeApi({ runs: () => ({ runs: [], cerrados: [closed], at: 0 }) }),
  );
  await press(panel, { label: "Ver los runs cerrados" });
  await press(panel, { label: "Ver las etapas de PIZ-9" });
  assert.ok(sees(panel, "Aprobaste el plan"));
  assert.ok(sees(panel, "PR #12"));
  // Las vueltas de un run que terminó arrancan plegadas: se ve la línea, no lo de adentro.
  assert.ok(sees(panel, "Probar falló · 2 pasos"));
  assert.equal(sees(panel, "Aceptaste seguir"), false);
  await press(panel, { label: "Abrir la vuelta de Probar" });
  assert.ok(sees(panel, "Aceptaste seguir"));
  assert.equal(panel.html().includes('class="actual"'), false);
  assert.equal(find(panel, "Abortar el run"), undefined);
});

// Si regresiona, Orca con un flowrunner anterior, que no manda el recorrido, deja la tarjeta vacía.
test("sin recorrido, la tarjeta muestra las nueve etapas en lista", async () => {
  const panel = await abrirPanel(fakeApi({}));
  assert.equal(
    runs.every((r) => r.recorrido === undefined),
    true,
  );
  assert.ok(panel.html().includes('class="etapa'));
  assert.equal(panel.html().includes('class="recorrido"'), false);
});
