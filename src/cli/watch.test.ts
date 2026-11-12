import { describe, expect, test } from "vitest";
import type { Selectable } from "../watch/render.ts";
import { boardKey } from "./watch.ts";

const row = (key: string, abierto: boolean | undefined, parent?: string): Selectable => ({
  key,
  run: "R",
  sessions: abierto === undefined ? ["revisar-1"] : [],
  titulo: key,
  abierto,
  parent,
});
const rows = [
  row("R", true),
  row("R:v1", false, "R"),
  row("R:p9", true, "R"),
  row("R:s/revisar-1", undefined, "R:p9"),
];
const at = (selected: string | undefined, abiertos: [string, boolean][] = []) => ({
  selected,
  abiertos: new Map(abiertos),
});

describe("boardKey", () => {
  // Si regresiona, las flechas dejan de recorrer las filas o se salen de la lista.
  test("↑ y ↓ recorren las filas, sin pasarse de los bordes", () => {
    expect(boardKey(at(undefined), "\x1b[B", rows).selected).toBe("R");
    expect(boardKey(at("R:v1"), "j", rows).selected).toBe("R:p9");
    expect(boardKey(at("R"), "\x1b[A", rows).selected).toBe("R");
  });

  // Si regresiona, una vuelta o un paso no se pueden abrir ni plegar desde el teclado.
  test("→ abre, ← pliega, y Enter alterna lo que tiene hijos", () => {
    expect(boardKey(at("R:v1"), "\x1b[C", rows).abiertos.get("R:v1")).toBe(true);
    expect(boardKey(at("R:p9"), "\x1b[D", rows).abiertos.get("R:p9")).toBe(false);
    expect(boardKey(at("R:v1"), "\r", rows).abiertos.get("R:v1")).toBe(true);
    expect(boardKey(at("R:p9"), "\r", rows).abiertos.get("R:p9")).toBe(false);
  });

  // Si regresiona, desde una fila plegada o una sesión no se puede volver a la de arriba.
  test("← en algo plegado o en una sesión sube a su padre", () => {
    expect(boardKey(at("R:v1"), "\x1b[D", rows).selected).toBe("R");
    expect(boardKey(at("R:s/revisar-1"), "\x1b[D", rows).selected).toBe("R:p9");
  });

  // Si regresiona, ya no se pueden ver los pasos de una sesión.
  test("Enter o → en una sesión abren sus pasos", () => {
    expect(boardKey(at("R:s/revisar-1"), "\r", rows).detail?.key).toBe("R:s/revisar-1");
    expect(boardKey(at("R:s/revisar-1"), "\x1b[C", rows).detail?.key).toBe("R:s/revisar-1");
    expect(boardKey(at("R:v1"), "\r", rows).detail).toBeUndefined();
  });

  // Si regresiona, lo que abriste se pierde al tocar otra tecla.
  test("lo abierto antes se conserva", () => {
    const next = boardKey(at("R:v1", [["R:p9", false]]), "\x1b[C", rows);
    expect([...next.abiertos]).toEqual([
      ["R:p9", false],
      ["R:v1", true],
    ]);
  });
});
