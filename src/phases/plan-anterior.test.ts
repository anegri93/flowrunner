import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { planChanges, replanOf, replanText } from "./plan-anterior.ts";

const at = "2026-11-08T10:00:00Z";
const start = { tipo: "accion_iniciada", at, fase: "planificar" } as const;

describe("replanOf", () => {
  // Si regresiona, la tercera vuelta solo ve el último pedido y pierde lo que corrigió el primero:
  // en VF-1 se perdió la entrada en CAMBIOS.md.
  test("junta todos los pedidos de cambios del run, en orden", () => {
    const events: RunEvent[] = [
      start,
      { tipo: "cambios_pedidos", at, motivo: "agregá la entrada en CAMBIOS.md" },
      start,
      { tipo: "cambios_pedidos", at, motivo: "la tabla se llama costos" },
      start,
    ];
    expect(replanOf(events, "la tabla se llama costos")).toEqual({
      pedidos: ["agregá la entrada en CAMBIOS.md", "la tabla se llama costos"],
      motivo: "la tabla se llama costos",
    });
  });

  // Si regresiona, un rerun desde planificar arranca sin saber por qué se detuvo el run.
  test("en un rerun desde planificar, el motivo es el de la detención", () => {
    const events: RunEvent[] = [
      {
        tipo: "run_creado",
        at,
        run_id: "R",
        clave: "K",
        proyecto: "p",
        repo: "/r",
        budget_usd: undefined,
      },
      start,
      {
        tipo: "accion_terminada",
        at,
        fase: "planificar",
        resultado: { tipo: "falla", clase: "invariante", motivo: "el test no pasa el formato" },
      },
      { tipo: "rehacer", at, desde: "planificar" },
      start,
    ];
    expect(replanOf(events, undefined).motivo).toBe("planificar: el test no pasa el formato");
    // Un intento posterior dentro del mismo rerun ya no repite la detención.
    expect(replanOf([...events, start], undefined).motivo).toBeUndefined();
  });
});

test("replanText: sin plan anterior es solo el motivo; con plan, los pedidos y el plan", () => {
  expect(replanText(undefined, { pedidos: [], motivo: undefined })).toBe("");
  const text = replanText(
    { plan: "# Plan\nUna tabla costos.", subtareas: [], criterios: [], locked: {} },
    { pedidos: ["primero", "segundo"], motivo: "segundo" },
  );
  expect(text).toContain("1. primero\n2. segundo");
  expect(text).toContain("Una tabla costos.");
  expect(text).not.toContain("## El motivo de este intento");
});

// Si regresiona, la persona no ve que la nueva vuelta perdió una sub-task o un test.
test("planChanges: sub-tasks renombradas, alcances y tests agregados y quitados", () => {
  const task = (id: string, titulo: string, alcance: string[]) => ({
    id,
    titulo,
    descripcion: "d",
    alcance,
    dependencias: [],
    depende_de: [],
  });
  const before = {
    subtareas: [task("ST-1", "Tabla costos", ["src/db/"]), task("ST-2", "CAMBIOS", ["fabrica/"])],
    locked: { "tests/a.test.ts": "h", "tests/b.test.ts": "h" },
  };
  const after = {
    subtareas: [task("ST-1", "Tabla gastos", ["src/db/", "src/gastos/"])],
    locked: { "tests/a.test.ts": "h", "tests/c.test.ts": "h" },
  };
  expect(planChanges(before, after)).toEqual({
    subtareas_agregadas: ["ST-1 Tabla gastos"],
    subtareas_quitadas: ["ST-1 Tabla costos", "ST-2 CAMBIOS"],
    alcance_agregado: ["src/gastos/"],
    alcance_quitado: ["fabrica/"],
    tests_agregados: ["tests/c.test.ts"],
    tests_quitados: ["tests/b.test.ts"],
  });
});
