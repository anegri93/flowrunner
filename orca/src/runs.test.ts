// Lo que el panel arma de `flowrunner watch --json`, sin Orca.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import {
  decisionsFor,
  duration,
  headlineOf,
  isFinished,
  MAX_TEXT_CHARS,
  nowOf,
  parseWatch,
  planView,
  progressOf,
  rerunPhase,
  sortRuns,
  stepsOf,
  tokenCount,
  type Run,
} from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const byKey = (clave: string): Run => {
  const run = runs.find((r) => r.clave === clave);
  assert.ok(run !== undefined);
  return run;
};
const marks = (run: Run) => stepsOf(run).map((s) => `${s.label}:${s.estado}`);

// Si regresiona, un run viejo y entregado queda arriba y tapa al que está trabajando.
test("los runs más recientes van arriba, y un run con la PR abierta cuenta como terminado", () => {
  assert.deepEqual(
    sortRuns(runs).map((r) => r.clave),
    ["PIZ-3", "VF-2", "VF-1"],
  );
  assert.equal(isFinished(byKey("VF-1")), true);
  assert.equal(isFinished(byKey("VF-2")), false);
});

// Si regresiona, los cinco pasos no dicen de un vistazo dónde está el run ni qué espera de vos.
test("los cinco pasos: listos, el actual, el que te espera y los pendientes", () => {
  assert.deepEqual(marks(byKey("VF-2")), [
    "Plan:listo",
    "Tu OK:pendiente",
    "Código:ahora",
    "Control:pendiente",
    "PR:pendiente",
  ]);
  assert.deepEqual(marks(byKey("PIZ-3")), [
    "Plan:listo",
    "Tu OK:espera",
    "Código:pendiente",
    "Control:pendiente",
    "PR:pendiente",
  ]);
  assert.deepEqual(marks(byKey("VF-1")), [
    "Plan:listo",
    "Tu OK:listo",
    "Código:listo",
    "Control:listo",
    "PR:espera",
  ]);
  assert.equal(progressOf(byKey("PIZ-3")), 30);
  assert.equal(progressOf(byKey("VF-1")), 90);
});

// Si regresiona, un run detenido se ve como si siguiera trabajando.
test("un run detenido marca en rojo el paso donde se detuvo", () => {
  const stopped: Run = {
    ...byKey("VF-2"),
    status: "detenido",
    fases: byKey("VF-2").fases.map((p) =>
      p.fase === "implementar" ? { ...p, estado: "falla", detalle: "ST-2 falló" } : p,
    ),
  };
  assert.equal(stepsOf(stopped)[2]?.estado, "falla");
  assert.deepEqual(headlineOf(stopped), {
    emoji: "🔴",
    texto: "Se detuvo en implementar",
    tone: "danger",
  });
  assert.equal(nowOf(stopped).detalle, "ST-2 falló");
});

// Si regresiona, la frase del estado no dice qué pasa ni cuánto falta.
test("la frase dice qué pasa, y en implementar, cuántas sub-tasks van", () => {
  assert.deepEqual(headlineOf(byKey("VF-2")), {
    emoji: "🔵",
    texto: "Implementando · 1 de 2 sub-tasks",
    tone: "accent",
  });
  assert.equal(headlineOf(byKey("PIZ-3")).texto, "El plan te espera");
  assert.equal(headlineOf(byKey("VF-1")).texto, "PR abierta: falta tu merge");
});

// Si regresiona, el detalle no muestra qué sub-tasks faltan ni qué hace la sesión que corre.
test("el detalle: las sub-tasks como lista de tareas y la sesión que corre primero", () => {
  const now = nowOf(byKey("VF-2"));
  assert.deepEqual(
    now.tareas.map((t) => [t.mark, t.texto, t.nota]),
    [
      ["✓", "ST-1 Tabla de precios", "lista"],
      ["●", "ST-2 Comando /precio", "trabajando"],
    ],
  );
  assert.deepEqual(now.actividad[0], {
    sesion: "implementar-ST-2-1",
    texto: "implementar-ST-2-1 · sonnet-5-5 · 40k · ≥ $0.25",
    ahora: "▸ Edit src/precio.ts · ctx 52k",
  });
  assert.equal(now.meta, "≥ $2.95 · 20m00s");
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
test("el plan se recorta a lo que Orca dibuja y trae lo que cambió contra el anterior", () => {
  const view = planView({
    plan: "x".repeat(30_000),
    subtareas: [{ id: "ST-1", titulo: "Variables", alcance: ["src/"] }],
    criterios: [{ id: "AC-1" }, { id: "AC-2" }],
    cambios: { subtareas_agregadas: ["ST-1 Variables"], tests_quitados: [] },
  });
  assert.equal(view.recortado, true);
  assert.ok(Buffer.byteLength(view.texto) < 16 * 1024);
  assert.equal(view.texto.length, MAX_TEXT_CHARS + 1);
  assert.deepEqual(view.subtareas, [{ id: "ST-1", titulo: "Variables" }]);
  assert.equal(view.criterios, 2);
  assert.deepEqual(view.cambios, ["sub-tasks nuevas: ST-1 Variables"]);
});

test("una salida que no es JSON da un error legible", () => {
  assert.throws(() => parseWatch("zsh: command not found: flowrunner"), /no devolvió JSON/);
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(duration(3_725), "1h02m");
});
