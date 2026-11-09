// Lo que el panel arma de `flowrunner watch --json`, sin Orca.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import {
  decisionsFor,
  duration,
  headlineOf,
  isFinished,
  nowOf,
  parseWatch,
  planView,
  rerunPhase,
  runChip,
  stageRows,
  clock,
  sortRuns,
  stationsOf,
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
test("las ocho etapas del flujo, con su nombre y el estado de su fase en flowrunner", () => {
  assert.deepEqual(states(byKey("PIZ-3")), [
    "Preparar:ok",
    "Planificar:ok",
    "Aprobar:espera",
    "Implementar:pendiente",
    "Verificar:pendiente",
    "Revisar:pendiente",
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

// Regresión: el plan de VF-3 pasaba los 16 KiB que Orca dibuja por texto, y el panel se trababa.
test("el plan se muestra entero, línea por línea, ninguna sobre el límite de Orca", () => {
  const view = planView({
    plan: `# Plan\n\n${"una línea larga del plan. ".repeat(1_500)}\n- otra`,
    subtareas: [{ id: "ST-1", titulo: "Variables", alcance: ["src/"] }],
    criterios: [{ id: "AC-1" }, { id: "AC-2" }],
    cambios: { subtareas_agregadas: ["ST-1 Variables"], tests_quitados: [] },
  });
  assert.equal(view.lineas.length, 3);
  assert.equal(view.lineas[0], "# Plan");
  assert.ok(view.lineas.every((l) => Buffer.byteLength(l) < 16 * 1024));
  assert.deepEqual(view.subtareas, [{ id: "ST-1", titulo: "Variables" }]);
  assert.equal(view.criterios, 2);
  assert.deepEqual(view.cambios, ["sub-tasks nuevas: ST-1 Variables"]);
});

test("una salida que no es JSON da un error legible", () => {
  assert.throws(() => parseWatch("zsh: command not found: flowrunner"), /no devolvió JSON/);
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(duration(3_725), "1h02m");
});
