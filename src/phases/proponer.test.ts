import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PLAN } from "../../test/helpers/plan-fixtures.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { loadRepoConfig } from "../config/load.ts";
import type { RunEvent } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import {
  archivoDePropuestas,
  cuantasLecciones,
  formatLessons,
  frictions,
  partesDePropuestas,
  proposalFile,
  proposalSchema,
  proposeLessons,
} from "./proponer.ts";

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

  // Si regresiona, lo que no te gustó de la PR no llega nunca al cerebro: no hay merge del que aprender.
  test("tu feedback sobre la PR es una fricción, con su propio origen", () => {
    expect(
      frictions([
        { tipo: "feedback_pedido", at: AT, texto: "separar con ;", origen: "orca" },
        vuelve("revisar", "falta el encabezado"),
      ]),
    ).toEqual([
      { origen: "tu feedback sobre la PR 1", texto: "separar con ;" },
      { origen: "revisar, vuelta 1", texto: "falta el encabezado" },
    ]);
  });

  // Si regresiona, el aprendizaje vuelve a depender solo de las vueltas: un run derecho no deja nada
  // aunque haya descubierto algo, y lo que la persona decidió al responder no llega al cerebro.
  test("suma lo que descubrió implementar, las preguntas respondidas y las decisiones de revisar (flowrunner 2.0)", () => {
    const found = frictions([
      {
        tipo: "descubrimiento",
        at: AT,
        fase: "implementar",
        unidad: "ST-2",
        que: "Excalidraw descarta un pointermove en window",
        donde: "src/Conectar.tsx:52",
        como: "la vista previa no llegaba",
      },
      {
        tipo: "accion_terminada",
        at: AT,
        fase: "planificar",
        resultado: { tipo: "pregunta", motivo: "¿la paleta viaja entera?" },
      },
      { tipo: "respondido", at: AT, respuesta: "sí, entera", origen: "claude" },
      {
        tipo: "accion_terminada",
        at: AT,
        fase: "revisar",
        resultado: { tipo: "pregunta", motivo: "unpdf pide Node 24", unidades: ["ST-1"] },
      },
      { tipo: "aceptado", at: AT, fase: "revisar", motivo: "subir a node 24", origen: "orca" },
    ]);
    expect(found).toEqual([
      {
        origen: "implementar ST-2, descubrimiento 1",
        texto:
          "Excalidraw descarta un pointermove en window (src/Conectar.tsx:52): la vista previa no llegaba",
      },
      {
        origen: "planificar, pregunta 1",
        texto: "¿la paleta viaja entera?\nRespondiste: sí, entera",
      },
      {
        origen: "revisar, decisión 1",
        texto: "unpdf pide Node 24\nDecidiste seguir igual: subir a node 24",
      },
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
        para: "codigo",
        origen: "revisar, vuelta 1",
      },
    ],
    "PIZ-1-x",
    "2026-11-07",
  );
  expect(text).toBe(
    "\n### Grilla de la barra\n\nRegla: Sumar una columna al agregar un hijo.\n\nAplica: src/Barra.tsx\n\nPara: código\n\nOrigen: run PIZ-1-x · revisar, vuelta 1 · 2026-11-07\n",
  );
});

describe("proposalSchema", () => {
  const lesson = {
    titulo: "t",
    regla: "r",
    aplica: "src/a.ts",
    para: "plan",
    origen: "revisar, vuelta 1",
  };
  // Si regresiona, una lección no dice a quién le sirve y la skill no sabe cuáles preguntar en el
  // ping pong (flowrunner 2.0, T3.3).
  test("una lección sin para quién es no pasa", () => {
    const { para: _, ...sinPara } = lesson;
    expect(proposalSchema.safeParse({ lecciones: [sinPara] }).success).toBe(false);
    expect(proposalSchema.safeParse({ lecciones: [{ ...lesson, para: "todos" }] }).success).toBe(
      false,
    );
  });
  // Si regresiona, entran lecciones que no dicen dónde valen: las de una sola feature.
  test("una lección sin dónde aplica no pasa", () => {
    const { aplica: _, ...sinAplica } = lesson;
    expect(proposalSchema.safeParse({ lecciones: [sinAplica] }).success).toBe(false);
  });

  // Si regresiona, cada vuelta vuelve a dejar hasta tres lecciones.
  // Hasta tres desde flowrunner 2.0: además de las vueltas, aprende de preguntas y descubrimientos.
  test("pasan hasta tres lecciones, y sin sugerencias es una lista vacía", () => {
    expect(proposalSchema.parse({ lecciones: [lesson, lesson, lesson] }).sugerencias).toEqual([]);
    expect(proposalSchema.safeParse({ lecciones: [lesson, lesson, lesson, lesson] }).success).toBe(
      false,
    );
  });
});

// Si regresiona, la segunda entrega después de un feedback reemplaza las propuestas de la primera, o
// la PR dice «nada nuevo» mientras al mergear entran lecciones que ya no anuncia (ADR 0038).
describe("propuestas de una entrega anterior de la misma PR", () => {
  const PREVIA = formatLessons(
    [
      {
        titulo: "Los CSV llevan encabezado",
        regla: "r",
        aplica: "src/",
        para: "plan",
        origen: "revisar, vuelta 1",
      },
    ],
    "R1",
    "2026-11-17",
  );
  const archivo = archivoDePropuestas("SHOP-214", PREVIA, [
    "- L-3 · run R1 · revisar · 2026-11-17",
  ]);

  test("partes y archivo van y vuelven: lo nuevo se suma después de lo anterior", () => {
    const partes = partesDePropuestas(archivo);
    expect(partes).toEqual({
      lecciones: PREVIA,
      noAlcanzaron: ["- L-3 · run R1 · revisar · 2026-11-17"],
    });
    expect(cuantasLecciones(partes.lecciones)).toBe(1);
    const nueva = formatLessons(
      [
        {
          titulo: "Separar con punto y coma",
          regla: "r",
          aplica: "src/",
          para: "plan",
          origen: "tu feedback",
        },
      ],
      "R1",
      "2026-11-18",
    );
    const junto = archivoDePropuestas(
      "SHOP-214",
      `${partes.lecciones}${nueva}`,
      partes.noAlcanzaron,
    );
    expect(junto.indexOf("### Los CSV")).toBeLessThan(junto.indexOf("### Separar"));
    expect(cuantasLecciones(partesDePropuestas(junto).lecciones)).toBe(2);
    expect(partesDePropuestas("# Lecciones propuestas por X\n")).toEqual({
      lecciones: "",
      noAlcanzaron: [],
    });
  });

  test("sin nada nuevo, la sección de la PR sigue mostrando lo que ya está en la rama", async () => {
    const deps = testDeps();
    const { run, featureWt } = await plannedRun(
      PLAN,
      { "tests/ac1.mjs": "process.exit(0);\n" },
      deps,
    );
    mkdirSync(join(featureWt, ".flowrunner", "propuestas"), { recursive: true });
    writeFileSync(join(featureWt, ".flowrunner", "propuestas", "SHOP-214.md"), archivo);
    const config = loadRepoConfig(featureWt);
    await proposeLessons(contextFor(run, "entregar", deps), featureWt, config);
    const seccion = readFileSync(proposalFile(run.dir), "utf8");
    expect(seccion).toContain("### Los CSV llevan encabezado");
    expect(seccion).toContain("En esta entrega: Nada nuevo para el cerebro");
    expect(
      readLog(run.dir).events.findLast((e) => e.tipo === "lecciones_propuestas"),
    ).toMatchObject({ cantidad: 1 });
  });
});
