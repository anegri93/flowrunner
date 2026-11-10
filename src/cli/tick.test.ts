import { expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { waitingReason } from "./tick.ts";

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
    "PR mergeada: aprende cuando otro run del proyecto termine de publicar sus lecciones",
  );
});
