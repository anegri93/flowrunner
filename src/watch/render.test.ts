import { describe, expect, test } from "vitest";
import { duration, modelName, renderBoard, renderDetail, tokenCount } from "./render.ts";
import type { PhaseNode, RunTree, SessionNode } from "./tree.ts";

const session = (nombre: string, extra: Partial<SessionNode> = {}): SessionNode => ({
  nombre,
  modelo: "claude-sonnet-5-5",
  corriendo: false,
  costoUsd: 0.15,
  tokens: 100_000,
  segundos: 40,
  pasos: 8,
  ultimo: undefined,
  ...extra,
});

const phase = (fase: PhaseNode["fase"], extra: Partial<PhaseNode> = {}): PhaseNode => ({
  fase,
  estado: "pendiente",
  segundos: undefined,
  costoUsd: 0,
  detalle: undefined,
  sesiones: [],
  unidades: [],
  ...extra,
});

const tree: RunTree = {
  id: "PIZ-1-x",
  clave: "PIZ-1",
  titulo: "Cambios de un toque",
  proyecto: "pizarra-en-vivo",
  status: "en_curso",
  costoUsd: 1.24,
  segundos: 540,
  motivo: undefined,
  siguiente: undefined,
  fases: [
    phase("planificar", {
      estado: "ok",
      segundos: 120,
      costoUsd: 0.93,
      sesiones: [
        session("planificar-1", { modelo: "claude-opus-5-5", costoUsd: 0.93, tokens: 737_540 }),
      ],
    }),
    phase("aprobar", { estado: "ok", segundos: 180 }),
    phase("implementar", {
      estado: "corriendo",
      segundos: 200,
      costoUsd: 0.31,
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
            session("implementar-ST-2-1", { costoUsd: 0.16 }),
            session("implementar-ST-2-2", {
              corriendo: true,
              costoUsd: undefined,
              tokens: 20_000,
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
    }),
    phase("verificar"),
  ],
};

const waiting: RunTree = {
  ...tree,
  id: "API-7-x",
  clave: "API-7",
  titulo: "Exportar CSV",
  proyecto: "api",
  status: "esperando_aprobacion",
  siguiente: "flowrunner plan API-7-x",
  fases: [phase("aprobar", { estado: "espera", segundos: 30 })],
};

// eslint-disable-next-line no-control-regex
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
const rowOf = (lines: string[], text: string) => lines.find((l) => l.includes(text)) ?? "";
const cols = (row: string) => row.trim().split(/ {2,}/);

describe("renderBoard", () => {
  // Si regresiona, la vista no dice de un vistazo cuánto costó cada etapa, quién trabaja ni quién te espera.
  test("resumen por estado, columnas, y cada fase y sub-task con modelo, tokens, USD, tiempo y estado", () => {
    const { lines } = renderBoard([tree, waiting], { width: 140, color: false });
    expect(lines[0]).toBe("● 1 en curso  ⏸ 1 te espera");
    expect(cols(lines[1] ?? "")).toEqual(["MODELO", "TOKENS", "≈ USD", "TIEMPO", "ESTADO"]);
    expect(lines).toContain("pizarra-en-vivo");
    expect(lines).toContain("api");
    expect(cols(rowOf(lines, "PIZ-1"))).toEqual([
      "● PIZ-1",
      "Cambios de un toque",
      "958k",
      "1.24",
      "9m",
      "en curso",
    ]);
    expect(cols(rowOf(lines, "planificar"))).toEqual([
      "├─ ✓ planificar",
      "Opus 5.5",
      "738k",
      "0.93",
      "2m",
      "listo",
    ]);
    const st2 = rowOf(lines, "ST-2 Lista");
    expect(st2).toContain("│  ├─ ● ST-2 Lista de pedidos ×2");
    expect(cols(st2).slice(-5)).toEqual([
      "Sonnet 5.5",
      "120k",
      "0.16",
      "1m",
      "▸ Edit src/Fichas.tsx",
    ]);
    expect(rowOf(lines, "ST-3")).toMatch(/espera a ST-2$/);
    expect(lines.some((l) => l.endsWith("esperando tu aprobación"))).toBe(true);
    expect(lines).toContain("   Para seguir: flowrunner plan API-7-x");
  });

  // Si regresiona, en una terminal angosta las líneas se parten y la tabla se vuelve ilegible.
  test("ninguna línea pasa el ancho; con poco ancho se pierden el modelo y después los tokens", () => {
    for (const width of [140, 90, 70]) {
      const { lines } = renderBoard([tree, waiting], {
        width,
        color: true,
        selected: "PIZ-1-x:ST-2",
      });
      for (const l of lines) expect(Array.from(strip(l)).length).toBeLessThanOrEqual(width);
    }
    const header = (width: number) => renderBoard([tree], { width, color: false }).lines[1] ?? "";
    expect(header(100)).toContain("MODELO");
    expect(header(90)).not.toContain("MODELO");
    expect(header(90)).toContain("TOKENS");
    expect(header(70)).not.toContain("TOKENS");
  });

  // Si regresiona, un motivo de varias líneas rompe la tabla, o texto de un modelo controla la terminal.
  test("el texto de un modelo sale en una línea y sin caracteres de control", () => {
    const hostile: RunTree = {
      ...tree,
      fases: [
        phase("revisar", {
          estado: "vuelve",
          segundos: 60,
          detalle: "bloqueantes:\n- ST-2 \x1b[2J\x1b]0;x\x07borra",
        }),
      ],
    };
    const { lines } = renderBoard([hostile], { width: 200, color: false });
    expect(rowOf(lines, "revisar")).toContain("volvió: bloqueantes: - ST-2");
    // eslint-disable-next-line no-control-regex
    expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  test("se eligen las filas con sesiones, en orden, y la elegida se marca", () => {
    const { lines, selectable } = renderBoard([tree], {
      width: 140,
      color: false,
      selected: "PIZ-1-x:ST-1",
    });
    expect(selectable.map((s) => s.key)).toEqual([
      "PIZ-1-x:planificar",
      "PIZ-1-x:ST-1",
      "PIZ-1-x:ST-2",
    ]);
    expect(selectable[2]?.sessions).toEqual(["implementar-ST-2-1", "implementar-ST-2-2"]);
    const plain = renderBoard([tree], { width: 140, color: false }).lines;
    const marked = lines.filter((l) => l.startsWith("›"));
    expect(marked).toEqual([`›${rowOf(plain, "ST-1").slice(1)}`]);
  });

  test("sin runs lo dice", () => {
    expect(renderBoard([], { width: 80, color: false }).lines).toEqual(["no hay runs activos"]);
  });
});

describe("renderDetail", () => {
  test("cada sesión con sus números y los últimos pasos que entran", () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      tipo: "herramienta" as const,
      texto: `Read paso-${String(i)}`,
    }));
    const lines = renderDetail(
      "PIZ-1 · ST-2",
      [
        { node: session("implementar-ST-2-1"), steps },
        {
          node: session("implementar-ST-2-2", { tokens: 1500, costoUsd: undefined }),
          steps: steps.slice(0, 1),
        },
      ],
      { width: 100, height: 7, color: false },
    );
    expect(lines[0]).toBe("PIZ-1 · ST-2");
    expect(lines[1]).toBe("  … 4 líneas antes");
    expect(lines.slice(2)).toEqual([
      "  ▸ Read paso-3",
      "  ▸ Read paso-4",
      "  ▸ Read paso-5",
      "implementar-ST-2-2  Sonnet 5.5 · 2k tokens · ≈ USD – · 40s",
      "  ▸ Read paso-0",
    ]);
  });
});

test("duration, tokenCount y modelName", () => {
  expect([duration(38), duration(540), duration(3_900)]).toEqual(["38s", "9m", "1h5m"]);
  expect([tokenCount(0), tokenCount(950), tokenCount(737_540), tokenCount(1_900_000)]).toEqual([
    "–",
    "950",
    "738k",
    "1.9M",
  ]);
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
});
