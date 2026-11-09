// Lo que el panel arma de `flowrunner watch --json`, sin Orca.
import { readFileSync } from "node:fs";
import { assert, test } from "orca/testing";
import { duration, parseWatch, runRows, runSummary, tokenCount } from "./runs";

const runs = parseWatch(readFileSync(new URL("../test/watch.json", import.meta.url), "utf8"));
const run = runs[0];

// Si regresiona, el panel pierde las sub-tasks o las sesiones y no se ve qué está haciendo el run.
test("las fases van en orden, cada una seguida de sus sesiones y sub-tasks", () => {
  assert.ok(run !== undefined);
  assert.deepEqual(
    runRows(run).map((r) => r.title),
    [
      "preparar",
      "planificar",
      "└ planificar-1",
      "implementar",
      "└ ST-1 Tabla de precios",
      "  └ implementar-ST-1-1",
      "└ ST-2 Comando /precio",
      "  └ implementar-ST-2-1",
      "verificar",
    ],
  );
});

// Si regresiona, lo que corre se ve como terminado o sin costo, como en VF-1 antes del costo en vivo.
test("lo que corre muestra su herramienta, su contexto y un costo mínimo", () => {
  assert.ok(run !== undefined);
  const rows = runRows(run);
  const st2 = rows.find((r) => r.sesion === "implementar-ST-2-1");
  assert.equal(
    st2?.description,
    "sonnet-5-5 · 40k tokens · ≥ USD 0.25 · 50s · ▸ Edit src/precio.ts · contexto 52k",
  );
  assert.equal(
    rows.find((r) => r.title === "implementar")?.description,
    "trabajando · ≥ USD 1.25 · 3m20s",
  );
  assert.equal(rows.find((r) => r.title === "verificar")?.icon, "more");
  assert.equal(runSummary(run), "en curso · ≥ USD 2.95 · 20m00s");
});

test("una salida que no es JSON da un error legible", () => {
  assert.throws(() => parseWatch("zsh: command not found: flowrunner"), /no devolvió JSON/);
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(duration(3_725), "1h02m");
});
