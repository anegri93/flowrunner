import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PHASES, type RunEvent } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { runPaths } from "../store/runs.ts";
import { learnRun, waitingReason } from "./tick.ts";

const at = "2026-11-09T04:00:00Z";

// Regresión: con la PR de VF-2 ya mergeada, el log del chequeo seguía diciendo «la PR sigue abierta»,
// cuando lo que esperaba era que VF-3 liberara el proyecto. Desde el ADR 0019 lo que espera es el
// turno de lecciones, que tiene otro run del proyecto.
test("un run entregado espera tu merge, o con la PR mergeada, que otro run publique sus lecciones", () => {
  const delivered: RunEvent[] = [
    { tipo: "pr", at, url: "https://github.com/o/r/pull/4", numero: 4 },
  ];
  expect(waitingReason(delivered)).toBe("la PR sigue abierta");
  expect(waitingReason([...delivered, { tipo: "pr_cerrada", at, mergeada: true }])).toBe(
    "PR mergeada: aprende cuando se mergee la PR de lecciones de otro run del proyecto",
  );
});

// Si regresiona, «Aprender ahora» y «Rehacer con feedback» casi juntos corren dos aprender a la vez:
// los dos evalúan el feedback y el segundo `reentrar`, ya sin feedback, detiene el run a la mitad del
// rehecho (revisión de la PR #feedback).
test("aprender con el candado tomado no corre si un feedback ya puso el run a trabajar", async () => {
  const home = mkdtempSync(join(tmpdir(), "fr-tick-"));
  const { dir } = runPaths(home, "R1");
  mkdirSync(dir, { recursive: true });
  appendEvent(dir, {
    tipo: "run_creado",
    run_id: "R1",
    clave: "SHOP-1",
    proyecto: "acme",
    repo: "/no-existe",
  });
  for (const fase of PHASES.filter((f) => f !== "aprender")) {
    appendEvent(dir, { tipo: "accion_iniciada", fase });
    appendEvent(dir, { tipo: "accion_terminada", fase, resultado: { tipo: "ok" } });
  }
  appendEvent(dir, { tipo: "feedback_pedido", texto: "otra cosa", origen: "orca" });
  const antes = readLog(dir).events.length;
  expect(await learnRun(home, "R1", { HOME: home })).toBe("ya no espera su merge: está en_curso");
  expect(readLog(dir).events).toHaveLength(antes);
});
