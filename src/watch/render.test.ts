import { describe, expect, test } from "vitest";
import { duration, modelTag, renderBoard, renderDetail, tokenCount } from "./render.ts";
import type { PhaseNode, RunTree, SessionNode } from "./tree.ts";

const session = (nombre: string, extra: Partial<SessionNode> = {}): SessionNode => ({
  nombre,
  modelo: "claude-sonnet-5-5",
  esfuerzo: "high",
  corriendo: false,
  costoUsd: 0.15,
  tokens: 100_000,
  contexto: 0,
  ventana: undefined,
  costoEstimado: undefined,
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
  repo: "/r/pizarra-en-vivo",
  prMergeada: false,
  status: "en_curso",
  costoUsd: 1.24,
  segundos: 540,
  haceSegundos: undefined,
  motivo: undefined,
  siguiente: undefined,
  opciones: undefined,
  unidades: undefined,
  cambiaLoExistente: [],
  fases: [
    phase("planificar", {
      estado: "ok",
      segundos: 163,
      costoUsd: 0.93,
      sesiones: [
        session("planificar-1", { modelo: "claude-opus-5-5", costoUsd: 0.93, tokens: 700_000 }),
      ],
    }),
    phase("aprobar", { estado: "ok", segundos: 207 }),
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
              tokens: 100_000,
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

const asked: RunTree = {
  ...tree,
  id: "VF-6-x",
  clave: "VF-6",
  titulo: "Animados en la Mac",
  status: "detenido",
  motivo: "verificar: AC-12 sigue en rojo",
  siguiente: 'flowrunner fix VF-6-x --unidad ST-6 "<qué cambiar>"',
  opciones: [
    { comando: 'flowrunner fix VF-6-x --unidad ST-6 "<qué cambiar>"', que: "que ST-6 lo corrija" },
    { comando: "flowrunner fix VF-6-x --yo", que: "lo arreglás vos" },
    { comando: "flowrunner abort VF-6-x", que: "cortar el run" },
  ],
  unidades: ["ST-6"],
  fases: [phase("verificar", { estado: "vuelve", detalle: "AC-12 sigue en rojo" })],
};

describe("renderBoard", () => {
  // Si regresiona, watch dice que el run se detuvo pero no cómo responderle.
  test("un run detenido con opciones dice la primera y cuántas más hay", () => {
    const { lines } = renderBoard([asked], { width: 200, color: false });
    expect(rowOf(lines, "para seguir")).toContain(
      'para seguir: flowrunner fix VF-6-x --unidad ST-6 "<qué cambiar>" (+2 opciones: flowrunner status VF-6-x)',
    );
  });

  // Si regresiona, una fase que no corrió se ve «listo», como si hubiera probado la feature.
  test("una fase salteada dice salteada y por qué, no listo", () => {
    const skipped: RunTree = {
      ...tree,
      status: "entregado",
      fases: [
        phase("probar", {
          estado: "salteada",
          detalle: "el repo no dice cómo levantar el entorno",
        }),
      ],
    };
    const row = strip(rowOf(renderBoard([skipped], { width: 200, color: false }).lines, "probar"));
    expect(row).toContain("salteada");
    expect(row).not.toContain("listo");
    expect(renderBoard([skipped], { width: 200, color: false }).lines.join("\n")).toContain(
      "el repo no dice cómo levantar el entorno",
    );
  });

  // Si regresiona, la vista no dice de un vistazo quién te espera, quién trabaja y qué costó cada etapa.
  test("cabecera con resumen y columnas, proyectos agrupados con lo urgente primero, y cada fila con sus números", () => {
    const { lines } = renderBoard([tree, waiting], { width: 160, color: false });
    expect(cols(lines[0] ?? "")).toEqual([
      "▲ 1 te espera",
      "● 1 en curso",
      "ID",
      "MODELO (ESFUERZO)",
      "TOKENS",
      "≈ USD",
      "TIEMPO",
      "ESTADO",
    ]);
    expect(lines.indexOf("api")).toBeLessThan(lines.indexOf("pizarra-en-vivo"));
    expect(cols(rowOf(lines, "Exportar CSV"))).toEqual([
      "▲ Exportar CSV",
      "API-7",
      "–",
      "1.24",
      "9m00s",
      "te espera",
    ]);
    expect(rowOf(lines, "para seguir")).toContain("para seguir: flowrunner plan API-7-x");
    expect(cols(rowOf(lines, "planificar"))).toEqual([
      "├─ ✓ planificar",
      "opus-5-5 (high)",
      "━━━━━━──",
      "700k",
      "0.93",
      "2m43s",
      "listo",
    ]);
    const st2 = rowOf(lines, "ST-2 Lista");
    expect(st2).toContain("│  ├─ ● ST-2 Lista de pedidos ×2");
    expect(cols(st2).slice(-6)).toEqual([
      "sonnet-5-5 (high)",
      "━━──────",
      "200k",
      "≥ 0.16",
      "1m20s",
      "trabajando",
    ]);
    expect(lines[lines.indexOf(st2) + 1]?.trim()).toBe("│  │    ▸ Edit src/Fichas.tsx");
    const st3 = rowOf(lines, "ST-3");
    expect(st3).toContain("│  └─ · ST-3 Aplicar al tocar");
    expect(cols(st3).slice(-3)).toEqual(["–", "–", "espera ST-2"]);
  });

  test("un run terminado dice hace cuánto, y un modelo único se nombra una vez en la cabecera", () => {
    const closed: RunTree = {
      ...tree,
      status: "cerrado",
      haceSegundos: 1_360,
      fases: [tree.fases[0] ?? phase("planificar")],
    };
    const { lines } = renderBoard([closed], { width: 160, color: false });
    expect(lines[0]).toMatch(/^✓ 1 cerrado {2}· opus-5-5 \(high\)/);
    expect(lines[0]).not.toContain("MODELO");
    expect(rowOf(lines, "Cambios de un toque")).toMatch(/hace 22m40s {2}cerrado$/);
  });

  // Si regresiona, en una terminal angosta las líneas se parten y la tabla se vuelve ilegible.
  test("ninguna línea pasa el ancho; con poco lugar se pierde el modelo antes que el nombre", () => {
    for (const width of [160, 100, 70]) {
      const { lines } = renderBoard([tree, waiting], {
        width,
        color: true,
        selected: "PIZ-1-x:ST-2",
      });
      for (const l of lines) expect(Array.from(strip(l)).length).toBeLessThanOrEqual(width);
    }
    expect(renderBoard([tree], { width: 160, color: false }).lines[0]).toContain("MODELO");
    expect(renderBoard([tree], { width: 100, color: false }).lines[0]).not.toContain("MODELO");
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
    expect(rowOf(lines, "revisar")).toMatch(/volvió$/);
    expect(rowOf(lines, "bloqueantes")).toContain("bloqueantes: - ST-2");
    // eslint-disable-next-line no-control-regex
    expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  test("se eligen las filas con sesiones, en orden, y la elegida va resaltada entera", () => {
    const { selectable } = renderBoard([tree], { width: 160, color: false });
    expect(selectable.map((s) => s.key)).toEqual([
      "PIZ-1-x:planificar",
      "PIZ-1-x:ST-1",
      "PIZ-1-x:ST-2",
    ]);
    expect(selectable[2]?.sessions).toEqual(["implementar-ST-2-1", "implementar-ST-2-2"]);
    const plain = renderBoard([tree], { width: 160, color: false }).lines;
    const colored = renderBoard([tree], {
      width: 160,
      color: true,
      selected: "PIZ-1-x:ST-1",
    }).lines;
    const marked = colored.filter((l) => l.startsWith("\x1b[30;46m"));
    expect(marked.map(strip).map((l) => l.trimEnd())).toEqual([rowOf(plain, "ST-1")]);
  });

  // Si regresiona, la fase más cara se ve sin costo hasta que termina, como planificar en VF-1.
  test("lo que corre suma su costo estimado y dice cuánto contexto arrastra", () => {
    const planning: RunTree = {
      ...tree,
      costoUsd: 0,
      fases: [
        phase("planificar", {
          estado: "corriendo",
          segundos: 394,
          sesiones: [
            session("planificar-1", {
              modelo: "claude-opus-5-5",
              corriendo: true,
              costoUsd: undefined,
              costoEstimado: 4.4,
              tokens: 435_000,
              contexto: 174_000,
              ventana: 1_000_000,
              ultimo: "Grep videoUrl",
            }),
          ],
        }),
      ],
    };
    const { lines } = renderBoard([planning], { width: 160, color: false });
    // En vivo el costo es un mínimo: la salida de cada mensaje se conoce recién al terminar.
    expect(cols(rowOf(lines, "Cambios de un toque")).slice(-4)).toEqual([
      "435k",
      "≥ 4.40",
      "9m00s",
      "en curso",
    ]);
    const row = rowOf(lines, "planificar");
    expect(cols(row).slice(-4)).toEqual(["435k", "≥ 4.40", "6m34s", "trabajando"]);
    expect(lines[lines.indexOf(row) + 1]?.trim()).toBe("▸ Grep videoUrl · contexto 174k de 1M");
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
      "PIZ-1 › ST-2",
      [
        { node: session("implementar-ST-2-1"), steps },
        {
          node: session("implementar-ST-2-2", { tokens: 1500, costoUsd: undefined }),
          steps: steps.slice(0, 1),
        },
      ],
      { width: 100, height: 7, color: false },
    );
    expect(lines[0]).toBe("PIZ-1 › ST-2");
    expect(lines[1]).toBe("  … 4 líneas antes");
    expect(lines.slice(2)).toEqual([
      "  ▸ Read paso-3",
      "  ▸ Read paso-4",
      "  ▸ Read paso-5",
      "implementar-ST-2-2 · sonnet-5-5 (high) · 2k tokens nuevos · contexto – · ≈ USD – · 40s",
      "  ▸ Read paso-0",
    ]);
  });
});

test("duration, tokenCount y modelTag", () => {
  expect([duration(38), duration(163), duration(3_900), duration(200_000)]).toEqual([
    "38s",
    "2m43s",
    "1h05m",
    "2d07h",
  ]);
  expect([tokenCount(0), tokenCount(950), tokenCount(737_540), tokenCount(1_900_000)]).toEqual([
    "–",
    "950",
    "738k",
    "1.9M",
  ]);
  expect([modelTag("claude-opus-5-5", "high"), modelTag(undefined)]).toEqual([
    "opus-5-5 (high)",
    "–",
  ]);
});

// Si regresiona, watch dice «espera merge» de un run cuya PR ya se mergeó, y la persona no sabe qué
// está esperando.
test("un run entregado con la PR mergeada dice que aprende al próximo chequeo, no que espera merge", () => {
  const delivered = (prMergeada: boolean): RunTree => ({
    ...tree,
    status: "entregado",
    prMergeada,
    fases: [phase("entregar", { estado: "ok" }), phase("aprender", { estado: "espera" })],
  });
  const text = (t: RunTree) => renderBoard([t], { width: 140, color: false }).lines.join("\n");
  expect(text(delivered(false))).toContain("espera merge");
  expect(text(delivered(false))).toContain("PR abierta");
  expect(text(delivered(true))).toContain("aprende al próximo chequeo");
  expect(text(delivered(true))).toContain("PR mergeada");
  expect(text(delivered(true))).not.toContain("espera merge");
});
