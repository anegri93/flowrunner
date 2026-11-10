import { describe, expect, test } from "vitest";
import { checkConserva, conservadas, type ConservaInput } from "./conserva.ts";
import type { Subtask } from "./plan.ts";

const st = (id: string, alcance: string[], extra: Partial<Subtask> = {}): Subtask => ({
  id,
  titulo: `tarea ${id}`,
  descripcion: id,
  alcance,
  dependencias: [],
  depende_de: [],
  ...extra,
});

const ST1 = st("ST-1", ["src/s1/"]);
const ST2 = st("ST-2", ["src/s2/"], { depende_de: ["ST-1"] });

/** Un replan que conserva todo lo de antes, sin pedidos ni llamadores; cada test cambia una cosa. */
function input(over: Partial<ConservaInput> = {}): ConservaInput {
  return {
    plan: {
      subtareas: [
        { ...ST1, conserva: true },
        { ...ST2, conserva: true },
      ],
      cambia_lo_existente: [],
    },
    anteriores: [ST1, ST2],
    candidatas: [
      { id: "ST-1", shas: ["a1"] },
      { id: "ST-2", shas: ["b1", "b2"] },
    ],
    pedidos: [],
    llamadores: new Map(),
    ...over,
  };
}

describe("checkConserva", () => {
  // Si regresiona, un replan reimplementa lo que el plan nuevo no cambió (VF-6: unos US$ 9).
  test("una sub-task con el mismo alcance, sin pedidos ni llamadores, se conserva", () => {
    // El mismo alcance escrito distinto («./», barra final) es el mismo alcance.
    const plan = {
      subtareas: [
        { ...st("ST-1", ["./src/s1"]), conserva: true },
        { ...ST2, conserva: true },
      ],
      cambia_lo_existente: [],
    };
    expect(checkConserva(input({ plan }))).toEqual([]);
    expect(conservadas(input({ plan }))).toEqual(["ST-1", "ST-2"]);
  });

  // Si regresiona, se marca como integrada una sub-task que no tiene código, y nadie la implementa.
  test("conserva sin estar implementada es un problema", () => {
    const i = input({ candidatas: [{ id: "ST-1", shas: ["a1"] }] });
    expect(checkConserva(i)).toEqual([
      "ST-2 tiene conserva: true pero no estaba implementada: sacale conserva o dejala como nueva",
    ]);
    expect(conservadas(i)).toEqual(["ST-1"]);
  });

  // Si regresiona, queda el código de un alcance que el plan nuevo cambió, sin lo que le falta.
  test("un alcance distinto no se conserva", () => {
    const plan = {
      subtareas: [{ ...st("ST-1", ["src/s1/", "src/otra/"]), conserva: true }],
      cambia_lo_existente: [],
    };
    const i = input({ plan });
    expect(checkConserva(i)).toEqual([
      "ST-1 cambió su alcance (antes: src/s1; ahora: src/s1, src/otra): no se puede conservar",
    ]);
    expect(conservadas(i)).toEqual([]);
  });

  // Si regresiona, la sub-task que motivó el replan se conserva tal cual, con lo que estaba mal.
  test("una sub-task que nombran los pedidos o el motivo del replan no se conserva", () => {
    const plan = {
      subtareas: [{ ...st("ST-6", ["src/s6/"]), conserva: true }],
      cambia_lo_existente: [],
    };
    const base = {
      plan,
      anteriores: [st("ST-6", ["src/s6/"])],
      candidatas: [{ id: "ST-6", shas: ["f1"] }],
    };
    expect(checkConserva(input({ ...base, pedidos: ["ST-6 no pudo escribir CLAUDE.md"] }))).toEqual(
      ["ST-6 la nombran los pedidos de cambios o el motivo del replan: no se puede conservar"],
    );
    // Un número que solo empieza igual no la nombra.
    expect(checkConserva(input({ ...base, pedidos: ["ST-60 y XST-6x no son ST-6x"] }))).toEqual([]);
  });

  // Si regresiona, se conserva código que llama a una función cuya firma cambia el plan nuevo.
  test("una sub-task que llama a una función que el plan cambia no se conserva", () => {
    const plan = {
      subtareas: [
        { ...st("ST-1", ["src/trabajos/"]), conserva: true },
        { ...st("ST-2", ["src/s2/"]), conserva: true },
      ],
      cambia_lo_existente: [
        {
          que: "tomar devuelve otra cosa",
          donde: "src/cola.ts:3",
          criterio: "AC-1",
          simbolo: "tomar",
        },
      ],
    };
    const i = input({
      plan,
      anteriores: [st("ST-1", ["src/trabajos/"]), st("ST-2", ["src/s2/"])],
      llamadores: new Map([["tomar", ["src/trabajos/cola.ts"]]]),
    });
    expect(checkConserva(i)).toEqual([
      "ST-1 llama a tomar, que el plan cambia (src/trabajos/cola.ts): no se puede conservar",
    ]);
    expect(conservadas(i)).toEqual(["ST-2"]);
  });

  // Si regresiona, un graft que no pudo responder (un nombre muy usado corta el grep) pasa como
  // «nadie lo llama» y se conserva código que el plan puede romper (ADR 0022).
  test("si no se pudo saber quién llama a un símbolo que el plan cambia, no se conserva nada", () => {
    const plan = {
      subtareas: [
        { ...ST1, conserva: true },
        { ...ST2, conserva: true },
      ],
      cambia_lo_existente: [
        { que: "git tira otra cosa", donde: "src/git.ts:19", criterio: "AC-1", simbolo: "git" },
      ],
    };
    const i = input({
      plan,
      sinLlamadores: new Map([["git", 'graft grep cortó la búsqueda de "git"']]),
    });
    expect(checkConserva(i)).toEqual([
      'ST-1 no se puede conservar: no se pudo comprobar quién llama a git, que el plan cambia (graft grep cortó la búsqueda de "git")',
      'ST-2 no se puede conservar: no se pudo comprobar quién llama a git, que el plan cambia (graft grep cortó la búsqueda de "git")',
      "ST-2 depende de ST-1, que no se conserva: no se puede conservar",
    ]);
    expect(conservadas(i)).toEqual([]);
  });

  // Si regresiona, queda conservado código que se apoya en una sub-task que se reimplementa distinta.
  test("una sub-task que depende de una no conservada no se conserva", () => {
    const ST3 = st("ST-3", ["src/s3/"], { depende_de: ["ST-2"] });
    const plan = {
      subtareas: [ST1, { ...ST2, conserva: true }, { ...ST3, conserva: true }],
      cambia_lo_existente: [],
    };
    const i = input({
      plan,
      anteriores: [ST1, ST2, ST3],
      candidatas: [
        { id: "ST-1", shas: ["a1"] },
        { id: "ST-2", shas: ["b1"] },
        { id: "ST-3", shas: ["c1"] },
      ],
    });
    expect(checkConserva(i)).toEqual([
      "ST-2 depende de ST-1, que no se conserva: no se puede conservar",
      // Transitivamente: ST-3 → ST-2 → ST-1.
      "ST-3 depende de ST-1, que no se conserva: no se puede conservar",
    ]);
    expect(conservadas(i)).toEqual([]);
  });

  test("sin conserva, ni conserva: false, no hay nada que chequear", () => {
    const plan = {
      subtareas: [{ ...st("ST-9", ["src/s9/"]), conserva: false }, st("ST-8", ["x/"])],
      cambia_lo_existente: [],
    };
    expect(checkConserva(input({ plan }))).toEqual([]);
    expect(conservadas(input({ plan }))).toEqual([]);
  });
});
