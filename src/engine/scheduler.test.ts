import { describe, expect, test } from "vitest";
import { blockedByFailure, readyToStart, type UnitPlan, type UnitsState } from "./scheduler.ts";

const u = (id: string, ...deps: string[]): UnitPlan => ({ id, depende_de: deps });
const state = (todo: UnitPlan[], extra: Partial<Omit<UnitsState, "todo">> = {}): UnitsState => ({
  todo,
  integrated: new Set(),
  running: new Set(),
  failed: new Set(),
  ...extra,
});

describe("readyToStart", () => {
  // Si regresiona, flowrunner abre más sesiones a la vez que las configuradas y llena la ventana de 5 h.
  test("tres independientes con max_parallel 2 arrancan dos", () => {
    expect(readyToStart(state([u("ST-1"), u("ST-2"), u("ST-3")]), 2)).toEqual(["ST-1", "ST-2"]);
  });

  test("con una corriendo y max_parallel 2 arranca una más", () => {
    expect(
      readyToStart(state([u("ST-1"), u("ST-2"), u("ST-3")], { running: new Set(["ST-1"]) }), 2),
    ).toEqual(["ST-2"]);
  });

  // Si regresiona, una sub-task arranca sobre una rama que todavía no tiene lo que necesita.
  test("una que depende de otra no integrada no arranca aunque haya lugar", () => {
    expect(readyToStart(state([u("ST-1"), u("ST-2", "ST-1")]), 3)).toEqual(["ST-1"]);
  });

  test("cuando la dependencia se integra, arranca", () => {
    expect(
      readyToStart(state([u("ST-1"), u("ST-2", "ST-1")], { integrated: new Set(["ST-1"]) }), 3),
    ).toEqual(["ST-2"]);
  });

  test("una dependencia que no es parte de esta ronda ya está integrada", () => {
    expect(readyToStart(state([u("ST-2", "ST-1")]), 3)).toEqual(["ST-2"]);
  });

  test("un diamante arranca en el orden esperado", () => {
    const todo = [u("ST-1"), u("ST-2", "ST-1"), u("ST-3", "ST-1"), u("ST-4", "ST-2", "ST-3")];
    expect(readyToStart(state(todo), 3)).toEqual(["ST-1"]);
    expect(readyToStart(state(todo, { integrated: new Set(["ST-1"]) }), 3)).toEqual([
      "ST-2",
      "ST-3",
    ]);
    expect(
      readyToStart(
        state(todo, { integrated: new Set(["ST-1", "ST-2"]), running: new Set(["ST-3"]) }),
        3,
      ),
    ).toEqual([]);
    expect(readyToStart(state(todo, { integrated: new Set(["ST-1", "ST-2", "ST-3"]) }), 3)).toEqual(
      ["ST-4"],
    );
  });
});

describe("blockedByFailure", () => {
  // Si regresiona, el run espera para siempre una sub-task que nunca va a poder arrancar.
  test("las dependientes directas e indirectas de una fallida quedan bloqueadas", () => {
    const todo = [u("ST-1"), u("ST-2", "ST-1"), u("ST-3", "ST-2"), u("ST-4")];
    const s = state(todo, { failed: new Set(["ST-1"]) });
    expect(blockedByFailure(s).sort()).toEqual(["ST-2", "ST-3"]);
    expect(readyToStart(s, 4)).toEqual(["ST-4"]);
  });
});
