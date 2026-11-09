// Lo que el panel arma de `flowrunner watch --json`, sin Orca.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import {
  decisionsFor,
  duration,
  isFinished,
  parseWatch,
  rerunPhase,
  runSummary,
  runView,
  sortRuns,
  tokenCount,
  type Run,
} from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const byKey = (clave: string): Run => {
  const run = runs.find((r) => r.clave === clave);
  assert.ok(run !== undefined);
  return run;
};

// Si regresiona, un run viejo y entregado queda arriba y tapa al que está trabajando.
test("los runs más recientes van arriba, y un run con la PR abierta cuenta como terminado", () => {
  assert.deepEqual(
    sortRuns(runs).map((r) => r.clave),
    ["PIZ-3", "VF-2", "VF-1"],
  );
  assert.equal(isFinished(byKey("VF-1")), true);
  assert.equal(isFinished(byKey("VF-2")), false);
});

// Si regresiona, el panel vuelve a listar cada fase terminada y la etapa actual se pierde entre ellas.
test("las fases se agrupan en listas, la etapa actual con su detalle, y las que faltan", () => {
  const view = runView(byKey("VF-2"));
  assert.deepEqual(
    view.listas.map((p) => p.fase),
    ["preparar", "planificar"],
  );
  assert.deepEqual(
    view.actuales.map((p) => [p.fase, p.mark, p.estado, p.tone]),
    [["implementar", "▶", "trabajando", "accent"]],
  );
  assert.deepEqual(view.faltan, ["verificar"]);
  assert.equal(view.etapa, "implementar");
  const st2 = view.actuales[0]?.unidades.find((u) => u.id === "ST-2");
  assert.equal(st2?.texto, "▶ ST-2 Comando /precio");
  assert.deepEqual(st2?.sesiones[0], {
    nombre: "implementar-ST-2-1",
    corriendo: true,
    texto: "implementar-ST-2-1 · sonnet-5-5 · 40k · ≥ $0.25 · 50s",
    ahora: "▸ Edit src/precio.ts · ctx 52k",
  });
});

// Si regresiona, el encabezado no dice en qué etapa está ni que su costo es un mínimo.
test("el encabezado dice el estado, la etapa actual, el costo y el tiempo", () => {
  assert.equal(runSummary(byKey("VF-2")), "en curso · implementar · ≥ $2.95 · 20m00s");
  assert.equal(runSummary(byKey("VF-1")), "PR abierta · $20.18 · 2h00m");
});

// Si regresiona, el panel ofrece aprobar un run que no espera, o no ofrece rehacer uno detenido.
test("las decisiones dependen del estado del run", () => {
  assert.deepEqual(decisionsFor(byKey("PIZ-3")), ["aprobar", "cambios"]);
  assert.deepEqual(decisionsFor(byKey("VF-2")), []);
  assert.deepEqual(decisionsFor(byKey("VF-1")), []);
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

test("una salida que no es JSON da un error legible", () => {
  assert.throws(() => parseWatch("zsh: command not found: flowrunner"), /no devolvió JSON/);
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(duration(3_725), "1h02m");
});
