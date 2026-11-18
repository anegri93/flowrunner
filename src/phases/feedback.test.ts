import { expect, test } from "vitest";
import type { NewEvent } from "../store/events.ts";
import type { RunPaths } from "../runner/types.ts";
import { decide, type FeedbackDecision } from "./feedback.ts";

const run: RunPaths = { id: "R1", home: "/h", dir: "/h/runs/R1", worktrees: "/h/worktrees/R1" };
const IDS = ["ST-1", "ST-2"];
const FEEDBACK = "el CSV tiene que separar con punto y coma";

function decideWith(d: Partial<FeedbackDecision>) {
  const emitted: NewEvent[] = [];
  const outcome = decide(
    {
      run,
      emit: (e) => {
        emitted.push(e);
        return { ...e, at: "2026-11-17T10:00:00.000Z" };
      },
    },
    FEEDBACK,
    { desde: "planificar", unidades: [], instruccion: "cambiar", por_que: "porque sí", ...d },
    IDS,
  );
  return { outcome, emitted };
}

// Si regresiona, lo que la sesión decidió no llega al engine, o llega sin tu feedback.
test("implementar con sub-tasks del plan reentra en implementar con tu feedback y su por qué", () => {
  const { outcome, emitted } = decideWith({
    desde: "implementar",
    unidades: ["ST-2", "ST-2"],
    instruccion: "ST-2: usar ; en src/export/csv.ts",
    por_que: "el separador vive en ST-2",
  });
  expect(outcome).toMatchObject({
    tipo: "reentrar",
    desde: "implementar",
    unidades: ["ST-2"],
    por_que: "el separador vive en ST-2",
  });
  expect(outcome.tipo === "reentrar" && outcome.instruccion).toContain(FEEDBACK);
  expect(outcome.tipo === "reentrar" && outcome.instruccion).toContain("ST-2: usar ;");
  expect(emitted).toContainEqual(
    expect.objectContaining({
      tipo: "decision",
      que: "tu feedback: rehacer ST-2 desde implementar",
      por_que: "el separador vive en ST-2",
    }),
  );
});

// Si regresiona, una respuesta inventada del modelo corre sub-tasks que no existen o el plan entero.
test("implementar sin sub-tasks válidas replanifica, que pasa por tu aprobación, con un aviso", () => {
  for (const unidades of [[], ["ST-9"]]) {
    const { outcome, emitted } = decideWith({ desde: "implementar", unidades });
    expect(outcome).toMatchObject({ tipo: "reentrar", desde: "planificar" });
    expect(emitted.some((e) => e.tipo === "aviso" && /se replanifica/.test(e.texto))).toBe(true);
  }
});

// Si regresiona, un feedback que cambia la feature se rehace sin preguntarte.
test("un feedback que cambia la feature se detiene a preguntar y dice cómo replanificar", () => {
  const { outcome } = decideWith({ desde: "feature", instruccion: "la feature pide CSV" });
  expect(outcome.tipo).toBe("pregunta");
  expect(outcome.tipo === "pregunta" && outcome.motivo).toContain(
    "flowrunner rerun R1 --desde planificar",
  );
});
