import { describe, expect, test } from "vitest";
import { describeInit, type Paso } from "./init.ts";

const result = (pasos: Paso[]) => ({ ok: true, repo: "/r", proyecto: "r", pasos });
const HINT = "flowrunner init <repo> --aplicar";

describe("describeInit", () => {
  // Si regresiona, init le pide a la persona que aplique algo que ya está hecho.
  test("sin pasos pendientes no sugiere --aplicar; con uno pendiente, sí", () => {
    const listo: Paso[] = [{ que: "proyecto", estado: "ya estaba", detalle: "" }];
    expect(describeInit(result(listo), false)).not.toContain(HINT);
    const falta: Paso[] = [...listo, { que: "job de launchd", estado: "pendiente", detalle: "" }];
    expect(describeInit(result(falta), false)).toContain(HINT);
  });
});
