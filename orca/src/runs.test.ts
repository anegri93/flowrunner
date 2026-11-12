// Lo que el panel arma de `flowrunner watch --json`, sin Orca.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import {
  canAbort,
  decisionsFor,
  duration,
  fixUnits,
  headlineOf,
  isFinished,
  nowOf,
  offers,
  pasoView,
  type PasoEtapa,
  parseWatch,
  planMarkdown,
  planVersion,
  stepsMarkdown,
  rerunPhase,
  runChip,
  stageRows,
  clock,
  sortRuns,
  stationsOf,
  suggestedFixes,
  tokenCount,
  type Run,
} from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const byKey = (clave: string): Run => {
  const run = runs.find((r) => r.clave === clave);
  assert.ok(run !== undefined);
  return run;
};
const states = (run: Run) => stationsOf(run).map((s) => `${s.nombre}:${s.estado}`);

// Si regresiona, un run viejo y entregado queda arriba y tapa al que está trabajando.
test("los runs más recientes van arriba, y un run con la PR abierta cuenta como terminado", () => {
  assert.deepEqual(
    sortRuns(runs).map((r) => r.clave),
    ["PIZ-3", "VF-2", "VF-1"],
  );
  assert.equal(isFinished(byKey("VF-1")), true);
  assert.equal(isFinished(byKey("VF-2")), false);
});

// Si regresiona, el panel inventa pasos que no son los del flujo.
test("las nueve etapas del flujo, con su nombre y el estado de su fase en flowrunner", () => {
  assert.deepEqual(states(byKey("PIZ-3")), [
    "Preparar:ok",
    "Planificar:ok",
    "Aprobar:espera",
    "Implementar:pendiente",
    "Verificar:pendiente",
    "Revisar:pendiente",
    "Probar:pendiente",
    "Entregar:pendiente",
    "Aprender:pendiente",
  ]);
  assert.deepEqual(states(byKey("VF-2")).slice(0, 5), [
    "Preparar:ok",
    "Planificar:ok",
    "Aprobar:pendiente",
    "Implementar:corriendo",
    "Verificar:pendiente",
  ]);
});

// Si regresiona, la frase no dice en qué etapa está ni con las palabras de `flowrunner watch`.
test("la frase nombra la etapa actual y su estado, como el diagrama y watch", () => {
  assert.deepEqual(headlineOf(byKey("PIZ-3")), {
    emoji: "🟡",
    texto: "Aprobar — te espera",
    tone: "warning",
  });
  assert.equal(headlineOf(byKey("VF-2")).texto, "Implementar — trabajando · 1 de 2 integradas");
  assert.equal(headlineOf(byKey("VF-1")).texto, "Aprender — espera merge");
  const stopped: Run = {
    ...byKey("VF-2"),
    status: "detenido",
    fases: byKey("VF-2").fases.map((p) =>
      p.fase === "implementar" ? { ...p, estado: "falla", detalle: "ST-2 falló" } : p,
    ),
  };
  assert.deepEqual(headlineOf(stopped), {
    emoji: "🔴",
    texto: "Implementar — falló · 1 de 2 integradas",
    tone: "danger",
  });
  assert.equal(nowOf(stopped).detalle, "ST-2 falló");
});

// Si regresiona, un run en cola se ve trabajando o esperándote, cuando espera un lugar del repo.
test("un run en cola dice en qué etapa espera su lugar, sin decisiones que tomar", () => {
  const queued: Run = { ...byKey("VF-2"), status: "en_cola" };
  assert.deepEqual(headlineOf(queued), {
    emoji: "⚪",
    texto: "Implementar — en cola",
    tone: "neutral",
  });
  assert.deepEqual(runChip(queued), { texto: "EN COLA", tone: "neutral" });
  assert.deepEqual(decisionsFor(queued), []);
});

// Si regresiona, el detalle no muestra las sub-tasks ni qué hace la sesión que corre.
test("el detalle: las sub-tasks con su estado y la sesión que corre primero", () => {
  const now = nowOf(byKey("VF-2"));
  assert.deepEqual(
    now.tareas.map((t) => `${t.mark} ${t.texto}`),
    ["✓ ST-1 Tabla de precios · integrada", "● ST-2 Comando /precio · trabajando"],
  );
  assert.deepEqual(now.actividad[0], {
    sesion: "implementar-ST-2-1",
    texto: "implementar-ST-2-1 · sonnet-5-5 · 40k · ≥ $0.25",
    ahora: "▸ Edit src/precio.ts · ctx 52k",
  });
  assert.equal(now.meta, "≥ $2.95");
});

// Si regresiona, la lista de etapas pierde el tiempo o los intentos, o no marca cuál es la actual.
test("cada etapa como fila: su estado, sus intentos si hubo más de uno, su tiempo, y cuál es la actual", () => {
  const withRetries: Run = {
    ...byKey("VF-2"),
    fases: byKey("VF-2").fases.map((p) =>
      p.fase === "planificar"
        ? { ...p, sesiones: [...p.sesiones, ...p.sesiones, ...p.sesiones, ...p.sesiones] }
        : p,
    ),
  };
  const rows = stageRows(withRetries);
  assert.deepEqual(
    rows.slice(0, 5).map((r) => [r.nombre, r.mark, r.texto, r.meta, r.actual]),
    [
      ["Preparar", "✓", "listo", "0:16", false],
      ["Planificar", "✓", "listo", "4 intentos · 6:12", false],
      ["Aprobar", "○", "pendiente", "", false],
      ["Implementar", "●", "trabajando", "3:20", true],
      ["Verificar", "○", "pendiente", "", false],
    ],
  );
  assert.equal(clock(3_725), "1:02:05");
});

// Regresión (PIZ-9): verificar devolvió ST-1 e implementar la rehace. Las dos eran la actual, y la
// tarjeta repetía el motivo, las sub-tasks y la sesión debajo de cada una.
test("con implementar rehaciendo lo que verificar devolvió, la actual es solo implementar", () => {
  const back: Run = {
    ...byKey("VF-2"),
    fases: byKey("VF-2").fases.map((p) =>
      p.fase === "verificar" ? { ...p, estado: "vuelve", detalle: "AC-9 sigue en rojo" } : p,
    ),
  };
  const rows = stageRows(back);
  assert.deepEqual(
    rows.filter((r) => r.actual).map((r) => r.fase),
    ["implementar"],
  );
  assert.equal(rows.find((r) => r.fase === "verificar")?.texto, "volvió");
});

// Regresión: con la PR de VF-2 ya mergeada, el panel seguía diciendo «PR ABIERTA» y «espera merge».
test("un run entregado con la PR mergeada no dice que espera tu merge", () => {
  const merged: Run = { ...byKey("VF-1"), prMergeada: true };
  assert.deepEqual(runChip(byKey("VF-1")), { texto: "PR ABIERTA", tone: "success" });
  assert.deepEqual(runChip(merged), { texto: "PR MERGEADA", tone: "success" });
  assert.equal(stageRows(byKey("VF-1")).at(-1)?.texto, "espera merge");
  assert.equal(stageRows(merged).at(-1)?.texto, "aprende al próximo chequeo");
  assert.equal(headlineOf(merged).texto, "Aprender — aprende al próximo chequeo");
});

// Si regresiona, el panel ofrece aprobar un run que no espera, o no ofrece rehacer uno detenido.
test("las decisiones dependen del estado del run", () => {
  assert.deepEqual(decisionsFor(byKey("PIZ-3")), ["aprobar", "cambios"]);
  assert.deepEqual(decisionsFor(byKey("VF-2")), []);
  // Con la PR abierta o recién mergeada, aprender ya, sin esperar el chequeo de cada 10 minutos.
  assert.deepEqual(decisionsFor(byKey("VF-1")), ["aprender"]);
  const stopped: Run = {
    ...byKey("VF-2"),
    status: "detenido",
    siguiente: "flowrunner rerun VF-2-20261109-001527 --desde verificar",
  };
  assert.deepEqual(decisionsFor(stopped), ["reanudar", "rehacer"]);
  assert.equal(rerunPhase(stopped), "verificar");
  assert.equal(
    rerunPhase({ ...stopped, siguiente: "flowrunner rerun X --desde `rm -rf`" }),
    undefined,
  );
});

const ID = "VF-2-20261109-001527";
const asked: Run = {
  ...byKey("VF-2"),
  status: "detenido",
  motivo: "verificar: AC-2 sigue en rojo",
  siguiente: `flowrunner fix ${ID} --unidad ST-2 "<qué cambiar>"`,
  unidades: ["ST-2", "ST-10"],
  opciones: [
    { comando: `flowrunner fix ${ID} --unidad ST-2 "<qué cambiar>"`, que: "que ST-2 lo corrija" },
    { comando: `flowrunner fix ${ID} --unidad ST-10 "<qué cambiar>"`, que: "que ST-10 lo corrija" },
    { comando: `flowrunner fix ${ID} --auto`, que: "formateador y lint" },
    { comando: `flowrunner fix ${ID} --yo`, que: "lo arreglás vos" },
    { comando: `flowrunner accept ${ID} "<por qué>"`, que: "seguir a revisar igual" },
    { comando: `flowrunner rerun ${ID} --desde planificar`, que: "replanificar" },
    { comando: `flowrunner abort ${ID}`, que: "cortar el run" },
  ],
};

// Si regresiona, el panel no ofrece las respuestas que el run espera, u ofrece una que rechaza.
// «Lo arreglo yo» quedó solo en el CLI: en el panel lo reemplaza Autofix (ADR 0026).
test("un run detenido con opciones ofrece arreglar por sub-task, Autofix y seguir igual", () => {
  assert.deepEqual(decisionsFor(asked), ["arreglar", "autofix", "aceptar", "rehacer"]);
  assert.equal(rerunPhase(asked), "planificar");
  assert.equal(offers(asked, "fix --auto"), true);
  assert.equal(offers(asked, "accept"), true);
  assert.equal(offers(asked, "resume"), false);
  // Esperando el arreglo a mano: retomar, o Autofix si la persona no llegó a tocar nada.
  const byHand: Run = {
    ...asked,
    siguiente: `flowrunner resume ${ID}`,
    opciones: [
      { comando: `flowrunner resume ${ID}`, que: "commitear tu cambio a mano" },
      { comando: `flowrunner fix ${ID} --auto`, que: "formateador y lint" },
      { comando: `flowrunner abort ${ID}`, que: "cortar el run" },
    ],
  };
  assert.deepEqual(decisionsFor(byHand), ["autofix", "reanudar"]);
  // Un run de un flowrunner anterior, sin Autofix entre sus opciones: no se ofrece.
  assert.deepEqual(
    decisionsFor({
      ...byHand,
      opciones: byHand.opciones?.filter((o) => !o.comando.includes("--auto")),
    }),
    ["reanudar"],
  );
  // Un snapshot de un flowrunner anterior, sin opciones: lo de antes.
  const { opciones: _sin, ...old } = asked;
  assert.deepEqual(decisionsFor({ ...old, siguiente: `flowrunner resume ${ID}` }), ["reanudar"]);
});

// Si regresiona, el panel arma un botón por una sub-task que el run no ofrece, o pierde una.
test("fixUnits saca las sub-tasks de las opciones", () => {
  assert.deepEqual(fixUnits(asked), ["ST-2", "ST-10"]);
  assert.deepEqual(fixUnits({ ...asked, opciones: [] }), []);
  const { opciones: _sin, ...old } = asked;
  assert.deepEqual(fixUnits(old), []);
});

// Si regresiona, el panel pide escribir un arreglo que flowrunner ya trae escrito (PIZ-3), o duplica
// el botón «Arreglar ST-n» por cada arreglo de esa sub-task.
test("los arreglos escritos van aparte del Arreglar genérico, en el orden de las opciones", () => {
  const instruccion = "Subí `engines.node` a `>=24` en package.json";
  const withFixes: Run = {
    ...asked,
    opciones: [
      {
        comando: `flowrunner fix ${ID} --unidad ST-2 'Subí \`engines.node\` a \`>=24\` en package.json'`,
        que: `que ST-2 lo corrija así: ${instruccion}`,
        arreglo: { unidad: "ST-2", instruccion },
      },
      {
        comando: `flowrunner fix ${ID} --unidad ST-10 'Usá unpdf 1'`,
        que: "que ST-10 lo corrija así: Usá unpdf 1",
        arreglo: { unidad: "ST-10", instruccion: "Usá unpdf 1" },
      },
      ...(asked.opciones ?? []),
    ],
  };
  assert.deepEqual(suggestedFixes(withFixes), [
    { unidad: "ST-2", instruccion },
    { unidad: "ST-10", instruccion: "Usá unpdf 1" },
  ]);
  assert.deepEqual(fixUnits(withFixes), ["ST-2", "ST-10"]);
  assert.deepEqual(suggestedFixes(asked), []);
  // Solo arreglos escritos, sin el genérico: igual se ofrece arreglar.
  const onlyWritten: Run = {
    ...withFixes,
    opciones: withFixes.opciones?.filter(
      (o) => o.arreglo !== undefined || !o.comando.includes("--unidad"),
    ),
  };
  assert.deepEqual(fixUnits(onlyWritten), []);
  assert.equal(decisionsFor(onlyWritten).includes("arreglar"), true);
});

// Si regresiona, un run vivo no se puede abortar desde el panel, o se ofrece abortar uno terminado.
test("se puede abortar todo run vivo, en cualquier estado, y ninguno cerrado o abortado", () => {
  for (const r of runs) assert.equal(canAbort(r), true, r.clave);
  for (const status of ["detenido", "pausado_por_limite", "entregado"] as const)
    assert.equal(canAbort({ ...byKey("VF-2"), status }), true, status);
  for (const status of ["cerrado", "abortado"] as const)
    assert.equal(canAbort({ ...byKey("VF-2"), status }), false, status);
});

// Si regresiona, la pestaña del plan muestra «AC-2 → run», como si fuera una sub-task.
test("un criterio del run se muestra como del run en la pestaña del plan", () => {
  const md = planMarkdown("PIZ-3", {
    plan: "p",
    subtareas: [{ id: "ST-1", titulo: "Variables", alcance: ["src/theme.ts"], depende_de: [] }],
    criterios: [
      { id: "AC-1", comando: "npm test", subtarea: "ST-1" },
      { id: "AC-2", comando: "./.flowrunner/verify.sh", subtarea: "run" },
    ],
  });
  assert.ok(md.includes("- **AC-1** → ST-1: `npm test`"));
  assert.ok(
    md.includes("- **AC-2** → del run (lo comprueba verificar): `./.flowrunner/verify.sh`"),
  );
});

// Si regresiona, la pestaña del plan no trae lo que hace falta para decidir: las sub-tasks con su
// alcance, los criterios, lo que cambió y el plan entero.
test("el plan como Markdown para su pestaña, y los pasos de una sesión", () => {
  const md = planMarkdown("PIZ-3", {
    plan: "# Enfoque\nVariables de color.",
    subtareas: [{ id: "ST-1", titulo: "Variables", alcance: ["src/theme.ts"], depende_de: [] }],
    criterios: [{ id: "AC-1", comando: "npm test", subtarea: "ST-1" }],
    cambios: { tests_quitados: ["test/a.test.ts"], subtareas_agregadas: [] },
  });
  assert.match(md, /^# PIZ-3 · plan\n/);
  assert.ok(md.includes("## Contra el plan anterior\n\n- Tests que ya no están: test/a.test.ts"));
  assert.ok(md.includes("- **ST-1** Variables — `src/theme.ts`"));
  assert.ok(md.includes("- **AC-1** → ST-1: `npm test`"));
  assert.ok(md.includes("# Enfoque\nVariables de color."));
  assert.equal(
    stepsMarkdown("VF-4", "planificar-1", "Read a.ts\n"),
    "# VF-4 · pasos de planificar-1\n\n```text\nRead a.ts\n```\n",
  );
});

// Si regresiona, la pestaña del plan esconde lo que el plan cambia de lo existente debajo de todo,
// y la persona aprueba sin verlo.
test("el plan que cambia lo que ya existe lo dice arriba de todo en su pestaña", () => {
  const md = planMarkdown("CUENTAS-1", {
    plan: "Enfoque.",
    subtareas: [],
    criterios: [],
    cambia_lo_existente: [
      {
        que: "el alta rechaza otro dominio; después lo acepta",
        donde: "a.ts:42",
        criterio: "AC-1",
      },
    ],
  });
  assert.match(
    md,
    /^# CUENTAS-1 · plan\n\n## ⚠ Cambia lo que ya existe \(1\)\n\n.*\n\n- el alta rechaza otro dominio; después lo acepta \(a\.ts:42\) ← AC-1\n/,
  );
  assert.ok(!planMarkdown("PIZ-3", { plan: "x" }).includes("Cambia lo que ya existe"));
});

// Si regresiona, la pestaña del plan no avisa que otro run toca los mismos archivos.
test("el plan que se pisa con otro run lo avisa con el run, su PR y los archivos", () => {
  const md = planMarkdown("VF-5", {
    plan: "x",
    se_pisa_con: [{ run: "VF-4-1", status: "entregado", pr: 70, archivos: ["src/a.ts", "src/b/"] }],
  });
  assert.match(md, /## ⚠ Se pisa con otros runs del proyecto \(1\)/);
  assert.match(md, /- \*\*VF-4-1\*\* \(entregado, PR #70\): `src\/a\.ts`, `src\/b\/`/);
  assert.ok(!planMarkdown("VF-6", { plan: "x", se_pisa_con: [] }).includes("Se pisa"));
});

test("una salida que no es JSON da un error legible", () => {
  assert.throws(() => parseWatch("zsh: command not found: flowrunner"), /no devolvió JSON/);
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(duration(3_725), "1h02m");
});

// Si regresiona, aprobar un plan corregido no pide abrirlo: el panel lo confunde con el que ya viste.
test("la versión del plan cambia cuando planificar vuelve a correr", () => {
  const piz3 = byKey("PIZ-3");
  const planificar = piz3.fases.find((p) => p.fase === "planificar");
  assert.ok(planificar !== undefined);
  assert.equal(planificar.sesiones.length, 1);
  const replanned: Run = {
    ...piz3,
    fases: piz3.fases.map((p) =>
      p.fase === "planificar" ? { ...p, sesiones: [...p.sesiones, ...p.sesiones] } : p,
    ),
  };
  assert.notEqual(planVersion(replanned), planVersion(piz3));
  // Un snapshot sin sesiones de planificar, de un flowrunner viejo, también tiene versión.
  assert.equal(planVersion({ ...piz3, fases: [] }), `${piz3.id}#0`);
});

// Si regresiona, un probar que no corrió se ve con ✓, o pasa a ser la etapa actual y tapa a la que
// de verdad espera.
test("una etapa salteada dice salteada, no listo, y no es la actual", () => {
  const revisar = byKey("VF-1").fases.find((p) => p.fase === "revisar");
  assert.ok(revisar !== undefined);
  const skipped: Run = {
    ...byKey("VF-1"),
    fases: [
      ...byKey("VF-1").fases,
      { ...revisar, fase: "probar", estado: "salteada", detalle: "sin `probar` en la config" },
    ],
  };
  const probar = stageRows(skipped).find((r) => r.fase === "probar");
  assert.deepEqual(
    [probar?.mark, probar?.texto, probar?.tone, probar?.actual],
    ["–", "salteada", "warning", false],
  );
  assert.equal(headlineOf(skipped).texto, "Aprender — espera merge");
});

// Si regresiona, la fila que junta los chequeos del merge no dice cuántos fueron.
test("un paso que junta varios chequeos dice cuántos fueron en su nombre", () => {
  const run = byKey("VF-1");
  const aprender: PasoEtapa = {
    tipo: "etapa",
    clave: "p40",
    fase: "aprender",
    inicio: "2026-11-12T15:05:00Z",
    segundos: 10,
    costoUsd: 0,
    resultado: "ok",
    unidades: [],
    sesiones: [],
    subtareas: [],
    abierto: false,
    chequeos: 9,
  };
  assert.equal(pasoView(aprender, run).titulo, "Aprender · 9 chequeos");
  assert.equal(pasoView({ ...aprender, chequeos: 1 }, run).titulo, "Aprender");
});
