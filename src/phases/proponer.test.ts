import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { formatLessons, frictions } from "./proponer.ts";

const AT = "2026-11-07T10:00:00.000Z";
const vuelve = (fase: "revisar" | "verificar", motivo: string): RunEvent => ({
  tipo: "accion_terminada",
  at: AT,
  fase,
  resultado: { tipo: "vuelve", unidades: ["ST-1"], motivo },
});

describe("frictions", () => {
  // Si regresiona, el cerebro no se entera de lo que le costó al run corregirse solo.
  test("junta las vueltas de revisar y verificar y los cambios al plan, en orden, con un origen citable", () => {
    const found = frictions([
      { tipo: "cambios_pedidos", at: AT, motivo: "sin dependencias nuevas" },
      {
        tipo: "accion_terminada",
        at: AT,
        fase: "planificar",
        resultado: { tipo: "falla", clase: "gate", motivo: "el AC-1 no falla sin el cambio" },
      },
      vuelve("verificar", "AC-1 falla"),
      vuelve("revisar", "la barra es una grilla de tres columnas"),
      vuelve("revisar", "falta el encabezado"),
    ]);
    expect(found).toEqual([
      { origen: "aprobar, cambios pedidos 1", texto: "sin dependencias nuevas" },
      { origen: "verificar, vuelta 1", texto: "AC-1 falla" },
      { origen: "revisar, vuelta 1", texto: "la barra es una grilla de tres columnas" },
      { origen: "revisar, vuelta 2", texto: "falta el encabezado" },
    ]);
  });

  test("un run sin vueltas ni cambios al plan no tiene fricción", () => {
    expect(frictions([{ tipo: "aprobado", at: AT }])).toEqual([]);
  });
});

test("formatLessons numera después de la última y cita el run y la fecha", () => {
  const text = formatLessons(
    [
      {
        titulo: "Grilla de la barra",
        regla: "Sumar una columna al agregar un hijo.",
        origen: "revisar, vuelta 1",
      },
    ],
    "# Lecciones\n\n### L-2 · Vieja\n",
    "PIZ-1-x",
    "2026-11-07",
  );
  expect(text).toBe(
    "\n### L-3 · Grilla de la barra\n\nRegla: Sumar una columna al agregar un hijo.\n\nOrigen: run PIZ-1-x · revisar, vuelta 1 · 2026-11-07\n",
  );
});
