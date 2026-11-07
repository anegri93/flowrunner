import { describe, expect, test } from "vitest";
import { environmentHint } from "./diagnosticar.ts";

describe("environmentHint", () => {
  // Si regresiona, una falla del entorno se toma como código roto y se gastan reintentos en una sub-task sana.
  test("reconoce las señales típicas de entorno y devuelve la línea que la delata", () => {
    expect(environmentHint("x\nError: Cannot find package 'jsqr' imported from /w/a.ts\ny")).toBe(
      "Error: Cannot find package 'jsqr' imported from /w/a.ts",
    );
    expect(environmentHint("a.ts(1,24): error TS2307: Cannot find module 'qrcode'")).toContain(
      "TS2307",
    );
    expect(environmentHint("sh: vitest: command not found")).toBe("sh: vitest: command not found");
    expect(environmentHint("Error [ERR_MODULE_NOT_FOUND]: x")).toContain("ERR_MODULE_NOT_FOUND");
    expect(environmentHint("connect ECONNREFUSED 127.0.0.1:5432")).toContain("ECONNREFUSED");
  });

  test("un test que falla por su aserción no es entorno", () => {
    expect(environmentHint("AssertionError: expected 1 to be 2\n  at a.test.ts:3")).toBeUndefined();
  });
});
