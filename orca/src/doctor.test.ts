// El doctor del panel con un worker simulado: se abre desde la cabecera, muestra la máquina y la
// versión, pide confirmar antes de actualizar y sigue la tarea hasta que termina (ADR 0039).
import { assert, test } from "orca/testing";
import type {
  AuditoriaCerebro,
  CerebroSnapshot,
  DoctorSnapshot,
  Mantenimiento,
  Tarea,
  TareasSnapshot,
} from "./doctor";
import { mantenimientoArgs, parseDoctor, parseTareas, terminadas } from "./doctor";
import { Panel, type Api } from "./estado";
import type { Outcome } from "./protocol";
import type { Accion } from "./vista";

const unesc = (t: string) =>
  t
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const visible = (html: string) =>
  unesc(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

interface Control {
  readonly texto: string;
  readonly label: string | undefined;
  readonly disabled: boolean;
  readonly accion: Accion;
}

function controles(html: string): Control[] {
  return [...html.matchAll(/<button ([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = m[1] ?? "";
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
    const label = attr("aria-label");
    return {
      texto: visible(m[2] ?? ""),
      label: label === undefined ? undefined : unesc(label),
      disabled: / disabled(?:\s|$)/.test(attrs),
      accion: JSON.parse(unesc(attr("data-accion") ?? "null")) as Accion,
    };
  });
}

const find = (panel: Panel, texto: string) =>
  controles(panel.html()).find((c) => c.texto === texto || c.label?.startsWith(texto) === true);

async function press(panel: Panel, texto: string): Promise<void> {
  const c = find(panel, texto);
  if (c === undefined) throw new Error(`no hay un control «${texto}»: ${visible(panel.html())}`);
  if (c.disabled) throw new Error(`el control ${texto} está deshabilitado`);
  await panel.tocar(c.accion);
}

const DOCTOR: DoctorSnapshot = {
  doctor: {
    ok: false,
    checks: [
      { nombre: "git", ok: true, arreglo: "instalá git" },
      { nombre: "gh con sesión", ok: false, arreglo: "corré `gh auth login`" },
    ],
    version: { sha: "1a2b3c4", main: "9f8e7d6", atras: 3 },
  },
  tareas: [],
};

const tarea = (estado: Tarea["estado"], extra: Partial<Tarea> = {}): Tarea => ({
  nombre: "self-update",
  estado,
  inicio: "2026-11-17T12:00:00Z",
  fin: estado === "corriendo" ? null : "2026-11-17T12:02:00Z",
  mensaje:
    estado === "corriendo" ? "actualizando flowrunner a origin/main" : "flowrunner en 9f8e7d6",
  siguiente: null,
  ...extra,
});

/** Un worker simulado: cada lectura de tareas devuelve la siguiente de la lista. */
function fakeApi(
  tareas: readonly (readonly Tarea[])[] = [[]],
  cerebros: readonly CerebroSnapshot[] = [{ proyecto: "acme", auditoria: null }],
) {
  const mantenidos: Mantenimiento[] = [];
  let doctorLecturas = 0;
  let c = 0;
  let informes = 0;
  let i = 0;
  const api: Api = {
    runs: () => Promise.resolve({ runs: [], at: 0 }),
    abrir: () => Promise.reject(new Error("abrir")),
    decidir: () => Promise.reject(new Error("decidir")),
    leer: () => Promise.resolve(null),
    guardar: () => Promise.resolve(),
    externo: () => Promise.resolve(),
    // Como el worker: doctor también trae las tareas de ahora.
    doctor: () => {
      doctorLecturas += 1;
      return Promise.resolve({
        ...DOCTOR,
        tareas: tareas[Math.max(0, Math.min(i, tareas.length) - 1)] ?? [],
      });
    },
    tareas: (): Promise<TareasSnapshot> => {
      const next = tareas[Math.min(i, tareas.length - 1)] ?? [];
      i += 1;
      return Promise.resolve({ tareas: next });
    },
    mantener: (m): Promise<Outcome> => {
      mantenidos.push(m);
      return Promise.resolve({ ok: true, mensaje: "actualizando flowrunner a origin/main" });
    },
    cerebro: () => {
      const next = cerebros[Math.min(c, cerebros.length - 1)] ?? { auditoria: null };
      c += 1;
      return Promise.resolve(next);
    },
    informeCerebro: () => {
      informes += 1;
      return Promise.resolve({ ok: true, mensaje: "abierto" });
    },
    ahora: () => 0,
  };
  return {
    api,
    mantenidos,
    doctorLecturas: () => doctorLecturas,
    informes: () => informes,
  };
}

// Si regresiona, la persona no tiene cómo ver desde Orca qué le falta a la máquina ni si su
// flowrunner está atrás de main.
test("el botón Doctor de la cabecera muestra los chequeos, su arreglo y la versión", async () => {
  const { api } = fakeApi();
  const panel = new Panel(api);
  await panel.refresh();
  await press(panel, "Doctor");
  const text = visible(panel.html());
  assert.match(text, /A esta máquina le falta algo/);
  assert.match(text, /✗ gh con sesión corré `gh auth login`/);
  assert.match(text, /Versión 1a2b3c4: 3 commits atrás de origin\/main/);
  await press(panel, "Volver a los runs");
  assert.match(visible(panel.html()), /No hay runs activos/);
});

// Si regresiona, un toque sin querer actualiza flowrunner con el código que siguen los runs.
test("actualizar pide confirmar; cancelar no manda nada y confirmar lanza la tarea", async () => {
  const { api, mantenidos } = fakeApi();
  const panel = new Panel(api);
  await press(panel, "Doctor");
  await press(panel, "Actualizar flowrunner");
  assert.match(visible(panel.html()), /¿Actualizar flowrunner a origin\/main\?/);
  await press(panel, "Cancelar");
  assert.deepEqual(mantenidos, []);
  await press(panel, "Actualizar el plugin de Orca");
  await press(panel, "Sí, confirmar");
  assert.deepEqual(mantenidos, [{ accion: "plugin" }]);
  assert.match(visible(panel.html()), /actualizando flowrunner a origin\/main/);
});

// Si regresiona, el panel no muestra que la actualización sigue corriendo (y deja lanzarla otra vez),
// o no se entera de que terminó y sigue mostrando la versión vieja.
test("sigue la tarea mientras corre y, al terminar, vuelve a leer el doctor", async () => {
  const { api, doctorLecturas } = fakeApi([[tarea("corriendo")], [tarea("ok")]]);
  const panel = new Panel(api);
  await press(panel, "Doctor");
  assert.equal(doctorLecturas(), 1);
  await panel.refresh();
  assert.match(visible(panel.html()), /self-update corriendo/);
  assert.equal(find(panel, "Actualizar flowrunner")?.disabled, true);
  await panel.refresh();
  assert.match(visible(panel.html()), /self-update ok flowrunner en 9f8e7d6/);
  assert.equal(doctorLecturas(), 2);
  assert.equal(find(panel, "Actualizar flowrunner")?.disabled, false);
});

// Si regresiona, Orca pide aprobar el plugin y la persona no sabe qué correr.
test("una tarea que necesita a la persona muestra el comando para la terminal", async () => {
  const { api } = fakeApi([
    [
      tarea("falla", {
        nombre: "orca-install",
        mensaje: "Orca pide aprobar el plugin",
        siguiente: "flowrunner orca install --approve ap1-test",
      }),
    ],
  ]);
  const panel = new Panel(api);
  await press(panel, "Doctor");
  await panel.refresh();
  assert.match(
    visible(panel.html()),
    /orca-install falla Orca pide aprobar el plugin En la terminal: flowrunner orca install --approve ap1-test/,
  );
});

test("parseDoctor, parseTareas y los comandos fijos", () => {
  assert.equal(parseDoctor('{"ok":true,"checks":[]}').version, undefined);
  assert.throws(() => parseDoctor("no json"), /no devolvió JSON/);
  assert.deepEqual(parseTareas('{"ok":true,"tareas":[{"nombre":"x","estado":"nada"}]}'), []);
  assert.equal(mantenimientoArgs({ accion: "actualizar" }), "self-update --fondo");
  assert.throws(() => mantenimientoArgs({ accion: "otra" as "plugin" }), /desconocido/);
  assert.deepEqual(
    terminadas([tarea("corriendo")], [tarea("ok")]).map((t) => t.estado),
    ["ok"],
  );
});

const PR = "https://example.test/o/r/pull/9";

const AUDITORIA: AuditoriaCerebro = {
  ref: "acme/20261117-100000",
  fecha: "2026-11-17T10:00:00.000Z",
  costoUsd: 0.42,
  resumen: "L1 nombra un archivo que ya no existe.",
  hallazgos: [
    {
      id: "H1",
      tipo: "obsoleta",
      archivo: ".flowrunner/lecciones.md",
      que: "L1 nombra src/viejo.ts",
    },
  ],
  decisiones: [
    {
      id: "D1",
      titulo: "Borrar L1",
      porQue: "H1",
      reduce: "nada: ordena",
      aplicable: true,
      motivo: null,
      pr: null,
    },
    {
      id: "D2",
      titulo: "Tocar el código",
      porQue: "no",
      reduce: "nada",
      aplicable: false,
      motivo: "README.md no se puede editar",
      pr: null,
    },
    {
      id: "D3",
      titulo: "Una vuelta",
      porQue: "elegiste siempre el primero",
      reduce: "verificar",
      aplicable: true,
      motivo: null,
      pr: null,
    },
  ],
};

// Si regresiona, la persona no puede elegir qué decisiones del cerebro van a la PR, o se manda una
// que no eligió o que no se puede aplicar.
test("el cerebro muestra la auditoría y abre la PR solo con las decisiones elegidas", async () => {
  const aplicada: AuditoriaCerebro = {
    ...AUDITORIA,
    decisiones: AUDITORIA.decisiones.map((d) => (d.id === "D3" ? { ...d, pr: PR } : d)),
  };
  const { api, mantenidos } = fakeApi(
    [[]],
    [
      { proyecto: "acme", auditoria: AUDITORIA },
      { proyecto: "acme", auditoria: aplicada },
    ],
  );
  const panel = new Panel(api);
  await press(panel, "Doctor");
  const text = visible(panel.html());
  assert.match(text, /CEREBRO · acme/);
  assert.match(text, /H1 · obsoleta · \.flowrunner\/lecciones\.md: L1 nombra src\/viejo\.ts/);
  assert.match(text, /D2 · Tocar el código No se puede aplicar: README\.md no se puede editar/);
  // La que no se puede aplicar no se elige.
  assert.equal(find(panel, "☐ D2 · Tocar el código"), undefined);
  assert.equal(find(panel, "Abrir PR con las elegidas")?.disabled, true);
  await press(panel, "☐ D3 · Una vuelta");
  await press(panel, "☐ D1 · Borrar L1");
  await press(panel, "☑ D1 · Borrar L1");
  await press(panel, "Abrir PR con las elegidas (1)");
  assert.deepEqual(mantenidos, [
    { accion: "aplicar", auditoria: "acme/20261117-100000", decisiones: ["D3"] },
  ]);
  // Releído: D3 ya está en su PR y no se vuelve a elegir.
  assert.ok(visible(panel.html()).includes(`✓ D3 · Una vuelta En la PR ${PR}`));
  assert.equal(find(panel, "☐ D3 · Una vuelta"), undefined);
});

// Si regresiona, un toque sin querer gasta una sesión de Claude en auditar.
test("auditar pide confirmar, y mientras corre no se puede lanzar otra", async () => {
  const corriendo = tarea("corriendo", {
    nombre: "auditar-acme",
    mensaje: "auditando el cerebro de acme",
  });
  const { api, mantenidos, informes } = fakeApi(
    [[], [corriendo]],
    [{ proyecto: "acme", auditoria: AUDITORIA }],
  );
  const panel = new Panel(api);
  await press(panel, "Doctor");
  await press(panel, "Auditar el cerebro");
  assert.match(visible(panel.html()), /¿Auditar el cerebro de este proyecto\?/);
  await press(panel, "Sí, confirmar");
  assert.deepEqual(mantenidos, [{ accion: "auditar" }]);
  await panel.refresh();
  assert.match(visible(panel.html()), /Auditando el cerebro…/);
  assert.equal(find(panel, "Auditar el cerebro"), undefined);
  await press(panel, "Ver el informe");
  assert.equal(informes(), 1);
});

test("sin proyecto enfocado, el cerebro dice qué hacer", async () => {
  const { api } = fakeApi(
    [[]],
    [{ auditoria: null, error: "enfocá un proyecto en Orca para ver su cerebro" }],
  );
  const panel = new Panel(api);
  await press(panel, "Doctor");
  assert.match(visible(panel.html()), /CEREBRO enfocá un proyecto en Orca para ver su cerebro/);
});

test("aplicar y auditar se arman solo con lo válido", () => {
  assert.equal(
    mantenimientoArgs({
      accion: "aplicar",
      auditoria: "acme/20261117-100000",
      decisiones: ["D1", "D3"],
    }),
    "brain apply acme/20261117-100000 --decision D1 --decision D3",
  );
  assert.equal(
    mantenimientoArgs({ accion: "auditar" }, "/r/it's"),
    "brain audit '/r/it'\\''s' --fondo",
  );
  assert.throws(() => mantenimientoArgs({ accion: "auditar" }), /enfocá un proyecto/);
  assert.throws(() => mantenimientoArgs({ accion: "auditar" }, "relativa"), /enfocá un proyecto/);
});
