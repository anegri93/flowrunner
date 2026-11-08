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

  // Si regresiona, un init que no terminó se lee como uno que sí: los ✓ de la máquina tapan el ✗.
  test("con algo que falta dice qué hacer y con qué comando volver a correrlo", () => {
    const rota: Paso[] = [
      { que: "base en verde", estado: "falta", detalle: "origin/main no está en verde" },
      { que: "proyecto", estado: "hecho", detalle: "r en /r" },
    ];
    const roto = { ...result(rota), ok: false };
    expect(describeInit(roto, true)).toContain(
      "Arreglá lo marcado con ✗ y volvé a correr: flowrunner init <repo> --aplicar",
    );
    expect(describeInit(roto, false)).toMatch(
      /Arreglá lo marcado con ✗ y volvé a correr: flowrunner init <repo>$/,
    );
    expect(describeInit(result(rota.slice(1)), true)).not.toContain("Arreglá");
  });
});
