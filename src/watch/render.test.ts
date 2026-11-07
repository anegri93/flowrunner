import { describe, expect, test } from "vitest";
import { duration, modelName, renderSession, renderTree, sessionOrder } from "./render.ts";
import type { RunTree, SessionNode } from "./tree.ts";

const session = (nombre: string, extra: Partial<SessionNode> = {}): SessionNode => ({
  nombre,
  modelo: "claude-sonnet-5-5",
  corriendo: false,
  costoUsd: 0.41,
  segundos: 190,
  pasos: 14,
  ultimo: undefined,
  ...extra,
});

const tree: RunTree = {
  id: "PIZ-1-x",
  clave: "PIZ-1",
  titulo: "Cambios de un toque",
  proyecto: "pizarra-en-vivo",
  status: "en_curso",
  costoUsd: 1.8,
  budgetUsd: 25,
  segundos: 540,
  motivo: undefined,
  siguiente: undefined,
  fases: [
    {
      fase: "planificar",
      estado: "ok",
      segundos: 120,
      costoUsd: 0.93,
      detalle: undefined,
      sesiones: [session("planificar-1", { modelo: "claude-opus-5-5", costoUsd: 0.93 })],
      unidades: [],
    },
    {
      fase: "implementar",
      estado: "corriendo",
      segundos: 200,
      costoUsd: 0.41,
      detalle: undefined,
      sesiones: [],
      unidades: [
        {
          id: "ST-1",
          titulo: "Chips en la ficha",
          estado: "integrada",
          dependeDe: [],
          sesiones: [session("implementar-ST-1-1")],
        },
        {
          id: "ST-2",
          titulo: "Lista de pedidos",
          estado: "corriendo",
          dependeDe: [],
          sesiones: [
            session("implementar-ST-2-1", {
              corriendo: true,
              costoUsd: undefined,
              ultimo: "Edit src/Fichas.tsx",
            }),
          ],
        },
        {
          id: "ST-3",
          titulo: "Aplicar al tocar",
          estado: "pendiente",
          dependeDe: ["ST-1", "ST-2"],
          sesiones: [],
        },
      ],
    },
    {
      fase: "verificar",
      estado: "pendiente",
      segundos: undefined,
      costoUsd: 0,
      detalle: undefined,
      sesiones: [],
      unidades: [],
    },
  ],
};

describe("renderTree", () => {
  // Si regresiona, watch muestra el árbol pero no lo que importa: quién corre, qué hace y a quién espera.
  test("muestra cada sub-task, la sesión que corre con su última herramienta y a quién espera la pendiente", () => {
    const text = renderTree(tree, { width: 200, color: false }).join("\n");
    expect(text).toContain(
      "PIZ-1 · Cambios de un toque · pizarra-en-vivo   en curso · USD 1.80 de 25 · 9m",
    );
    expect(text).toContain("├─ ✓ planificar");
    expect(text).toContain("planificar-1  Opus 5.5 · 14 pasos · USD 0.93 · 3m");
    expect(text).toContain("● implementar  1/3 sub-tasks");
    expect(text).toContain("implementar-ST-2-1  Sonnet 5.5 · 14 pasos · 3m  ▸ Edit src/Fichas.tsx");
    expect(text).toContain("○ ST-3  Aplicar al tocar  espera a ST-2");
    expect(text).toContain("└─ ○ verificar");
  });

  // Si regresiona, en una terminal angosta las líneas se parten y el árbol se vuelve ilegible.
  test("ninguna línea pasa el ancho, con o sin color", () => {
    for (const color of [false, true]) {
      for (const l of renderTree(tree, { width: 40, color, selected: "implementar-ST-2-1" })) {
        // eslint-disable-next-line no-control-regex
        expect(Array.from(l.replace(/\x1b\[[0-9;]*m/g, "")).length).toBeLessThanOrEqual(40);
      }
    }
  });

  // Si regresiona, un motivo de varias líneas rompe el árbol, o texto de un modelo controla la terminal.
  test("el texto de un modelo sale en una línea y sin caracteres de control", () => {
    const phase = tree.fases[0];
    if (phase === undefined) throw new Error("sin fase");
    const hostile: RunTree = {
      ...tree,
      fases: [
        { ...phase, estado: "vuelve", detalle: "bloqueantes:\n- ST-2 \x1b[2J\x1b]0;x\x07borra" },
      ],
    };
    const lines = renderTree(hostile, { width: 200, color: false });
    const line = lines.find((l) => l.includes("bloqueantes"));
    expect(line).toContain("bloqueantes: - ST-2");
    // eslint-disable-next-line no-control-regex
    expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  test("la sesión elegida se marca, y el orden para elegir sigue el árbol", () => {
    const lines = renderTree(tree, { width: 200, color: false, selected: "implementar-ST-1-1" });
    expect(lines.filter((l) => l.startsWith("› "))).toEqual([
      expect.stringContaining("implementar-ST-1-1"),
    ]);
    expect(sessionOrder(tree)).toEqual([
      "planificar-1",
      "implementar-ST-1-1",
      "implementar-ST-2-1",
    ]);
  });
});

describe("renderSession", () => {
  test("muestra los últimos pasos que entran y cuántos quedaron antes", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      tipo: "herramienta" as const,
      texto: `Read paso-${String(i)}`,
    }));
    const lines = renderSession(session("implementar-ST-1-1"), steps, {
      width: 80,
      height: 6,
      color: false,
    });
    expect(lines[0]).toContain("implementar-ST-1-1");
    expect(lines[1]).toBe("  … 6 pasos antes");
    expect(lines.slice(2)).toEqual([
      "▸ Read paso-6",
      "▸ Read paso-7",
      "▸ Read paso-8",
      "▸ Read paso-9",
    ]);
  });
});

test("duration y modelName", () => {
  expect([duration(38), duration(540), duration(3_900)]).toEqual(["38s", "9m", "1h5m"]);
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
});
