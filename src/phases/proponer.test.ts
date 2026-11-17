import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { formatLessons, frictions, proposalSchema } from "./proponer.ts";

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

// Si regresiona, dos PRs de features que proponen lecciones vuelven a elegir el mismo número.
test("formatLessons escribe las lecciones sin número, con dónde aplican, el run y la fecha", () => {
  const text = formatLessons(
    [
      {
        titulo: "Grilla de la barra",
        regla: "Sumar una columna al agregar un hijo.",
        aplica: "src/Barra.tsx",
        origen: "revisar, vuelta 1",
      },
    ],
    "PIZ-1-x",
    "2026-11-07",
  );
  expect(text).toBe(
    "\n### Grilla de la barra\n\nRegla: Sumar una columna al agregar un hijo.\n\nAplica: src/Barra.tsx\n\nOrigen: run PIZ-1-x · revisar, vuelta 1 · 2026-11-07\n",
  );
});

describe("proposalSchema", () => {
  const lesson = { titulo: "t", regla: "r", aplica: "src/a.ts", origen: "revisar, vuelta 1" };
  // Si regresiona, entran lecciones que no dicen dónde valen: las de una sola feature.
  test("una lección sin dónde aplica no pasa", () => {
    const { aplica: _, ...sinAplica } = lesson;
    expect(proposalSchema.safeParse({ lecciones: [sinAplica] }).success).toBe(false);
  });

  // Si regresiona, cada vuelta vuelve a dejar hasta tres lecciones.
  test("pasan hasta dos lecciones, y sin sugerencias es una lista vacía", () => {
    expect(proposalSchema.parse({ lecciones: [lesson, lesson] }).sugerencias).toEqual([]);
    expect(proposalSchema.safeParse({ lecciones: [lesson, lesson, lesson] }).success).toBe(false);
  });
});
