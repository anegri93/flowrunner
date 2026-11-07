import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { runTree, tidyStep, type SessionFile } from "./tree.ts";

const T0 = Date.parse("2026-11-07T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const base: RunEvent[] = [
  {
    tipo: "run_creado",
    at: at(0),
    run_id: "PIZ-1-x",
    clave: "PIZ-1",
    proyecto: "pizarra",
    repo: "/r",
    budget_usd: 25,
  },
  { tipo: "accion_iniciada", at: at(0), fase: "preparar" },
  { tipo: "accion_terminada", at: at(40), fase: "preparar", resultado: { tipo: "ok" } },
  { tipo: "accion_iniciada", at: at(40), fase: "planificar" },
  {
    tipo: "uso",
    at: at(160),
    fase: "planificar",
    sesion: "planificar-1",
    modelo: "claude-opus-5-5",
    costo_usd: 0.93,
    tokens_entrada: 1,
    tokens_salida: 1,
    duracion_ms: 120_000,
  },
  { tipo: "accion_terminada", at: at(160), fase: "planificar", resultado: { tipo: "ok" } },
  { tipo: "accion_iniciada", at: at(160), fase: "aprobar" },
];

const tasks = [
  { id: "ST-1", titulo: "Chips en la ficha", depende_de: [] },
  { id: "ST-2", titulo: "Lista de pedidos", depende_de: [] },
  { id: "ST-3", titulo: "Aplicar al tocar", depende_de: ["ST-1", "ST-2"] },
];

const line = (o: object) => JSON.stringify(o);
const tool = (name: string, input: object) =>
  line({
    type: "assistant",
    message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", name, input }] },
  });
const session = (lines: string[], birth: number, mtime: number): SessionFile => ({
  jsonl: lines.join("\n"),
  birthMs: T0 + birth * 1000,
  mtimeMs: T0 + mtime * 1000,
});
const planSession = session(
  [
    line({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
    line({ type: "result", total_cost_usd: 0.93 }),
  ],
  40,
  160,
);

describe("runTree", () => {
  // Si regresiona, watch no muestra que el run está parado esperándote, que es lo más urgente.
  test("esperando aprobación: las fases hechas con su sesión, aprobar en espera, el resto pendiente", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "espera" } },
      ],
      tasks,
      titulo: "Cambios de un toque",
      sessions: new Map([["planificar-1", planSession]]),
      now: T0 + 300_000,
    });
    expect(tree).toMatchObject({ clave: "PIZ-1", status: "esperando_aprobacion", costoUsd: 0.93 });
    expect(tree.fases.map((f) => [f.fase, f.estado])).toEqual([
      ["preparar", "ok"],
      ["planificar", "ok"],
      ["aprobar", "espera"],
      ["implementar", "pendiente"],
      ["verificar", "pendiente"],
      ["revisar", "pendiente"],
      ["entregar", "pendiente"],
      ["aprender", "pendiente"],
    ]);
    expect(tree.fases[1]?.sesiones).toEqual([
      expect.objectContaining({
        nombre: "planificar-1",
        modelo: "claude-opus-5-5",
        corriendo: false,
        costoUsd: 0.93,
        segundos: 120,
      }),
    ]);
    expect(tree.siguiente).toBe("flowrunner plan PIZ-1-x");
  });

  // Si regresiona, mirar watch durante implementar no dice qué sub-task corre ni qué está haciendo,
  // o muestra como integrada una sub-task que volvió y se está rehaciendo.
  test("implementando: cada sub-task con su estado, y la sesión que corre con su última herramienta", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "aprobado", at: at(200) },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
        { tipo: "unidad", at: at(201), fase: "implementar", unidad: "ST-1", estado: "iniciada" },
        // ST-2 quedó integrada en una vuelta anterior y revisar la devolvió: su sesión nueva corre.
        {
          tipo: "unidad",
          at: at(190),
          fase: "implementar",
          unidad: "ST-2",
          estado: "integrada",
          sha: "old",
        },
        {
          tipo: "unidad",
          at: at(300),
          fase: "implementar",
          unidad: "ST-1",
          estado: "integrada",
          sha: "abc",
        },
      ],
      tasks,
      titulo: "Cambios de un toque",
      sessions: new Map([
        ["planificar-1", planSession],
        [
          "implementar-ST-1-1",
          session(
            [
              tool("Write", { file_path: "/w/compartido/a.ts" }),
              line({ type: "result", total_cost_usd: 0.41 }),
            ],
            201,
            300,
          ),
        ],
        [
          "implementar-ST-2-1",
          session(
            [
              tool("Read", { file_path: "/w/src/Fichas.tsx" }),
              tool("Bash", { command: "npm test -- compartido" }),
            ],
            202,
            290,
          ),
        ],
      ]),
      now: T0 + 320_000,
    });
    const impl = tree.fases.find((f) => f.fase === "implementar");
    expect(impl?.estado).toBe("corriendo");
    expect(impl?.unidades.map((u) => [u.id, u.estado])).toEqual([
      ["ST-1", "integrada"],
      ["ST-2", "corriendo"],
      ["ST-3", "pendiente"],
    ]);
    const running = impl?.unidades[1]?.sesiones[0];
    expect(running).toMatchObject({
      corriendo: true,
      pasos: 2,
      ultimo: "Bash npm test -- compartido",
      segundos: 118,
    });
    expect(impl?.unidades[2]?.dependeDe).toEqual(["ST-1", "ST-2"]);
  });

  test("una vuelta de verificar y un run detenido muestran el motivo y cómo seguir", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
        { tipo: "accion_terminada", at: at(300), fase: "implementar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(300), fase: "verificar" },
        {
          tipo: "accion_terminada",
          at: at(320),
          fase: "verificar",
          resultado: { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-2 falla" },
        },
        { tipo: "accion_iniciada", at: at(320), fase: "implementar" },
        {
          tipo: "accion_terminada",
          at: at(330),
          fase: "implementar",
          resultado: { tipo: "falla", clase: "entorno", motivo: "npm ci salió 1" },
        },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 400_000,
    });
    expect(tree.fases.find((f) => f.fase === "verificar")).toMatchObject({
      estado: "vuelve",
      detalle: "AC-2 falla",
    });
    expect(tree.fases.find((f) => f.fase === "implementar")).toMatchObject({
      estado: "falla",
      detalle: "npm ci salió 1",
    });
    expect(tree).toMatchObject({ status: "detenido", siguiente: "flowrunner resume PIZ-1-x" });
  });

  // Si regresiona, un plan ya aprobado sigue apareciendo como si te esperara.
  test("aprobar queda hecho cuando la persona aprueba después de la espera", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "espera" } },
        { tipo: "aprobado", at: at(200) },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 300_000,
    });
    expect(tree.fases.find((f) => f.fase === "aprobar")?.estado).toBe("ok");
  });

  // Si regresiona, el detalle de una sesión muestra JSON crudo y rutas del worktree en vez de lo que hizo.
  test("tidyStep: la herramienta en una línea y las rutas relativas al repo", () => {
    const wt = "/h/.flowrunner/worktrees/PIZ-1-x";
    expect(
      tidyStep(
        { tipo: "herramienta", texto: `Read {"file_path":"${wt}/ST-1/compartido/objetivo.ts"}` },
        wt,
      ),
    ).toEqual({ tipo: "herramienta", texto: "Read compartido/objetivo.ts" });
    expect(
      tidyStep({ tipo: "herramienta", texto: 'Bash {"command":"npx vitest run a.test.ts"}' }, wt),
    ).toEqual({
      tipo: "herramienta",
      texto: "Bash npx vitest run a.test.ts",
    });
    expect(
      tidyStep({ tipo: "resultado", texto: `File created at: ${wt}/feature/src/a.ts` }, wt).texto,
    ).toBe("File created at: src/a.ts");
  });

  // Si regresiona, watch no dice cuántos tokens lleva una sesión hasta que termina, o los cuenta doble.
  test("tokens: en vivo suma cada mensaje una vez, y al terminar usa el total del resultado", () => {
    const usage = { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 90 };
    const msg = (id: string) =>
      line({ type: "assistant", message: { id, model: "claude-sonnet-5-5", content: [], usage } });
    const live = runTree({
      events: base,
      tasks,
      titulo: "x",
      sessions: new Map([["planificar-1", session([msg("a"), msg("a"), msg("b")], 40, 60)]]),
      now: T0 + 100_000,
    });
    expect(live.fases[1]?.sesiones[0]?.tokens).toBe(2200);
    const done = runTree({
      events: base,
      tasks,
      titulo: "x",
      sessions: new Map([
        [
          "planificar-1",
          session(
            [
              msg("a"),
              line({
                type: "result",
                total_cost_usd: 0.5,
                usage: { ...usage, cache_creation_input_tokens: 500 },
              }),
            ],
            40,
            60,
          ),
        ],
      ]),
      now: T0 + 100_000,
    });
    expect(done.fases[1]?.sesiones[0]?.tokens).toBe(1600);
  });

  // Si regresiona, un run cerrado hace horas sigue sumando minutos en watch.
  test("un run cerrado cuenta su tiempo hasta el último evento", () => {
    const tree = runTree({
      events: [...base, { tipo: "abortado", at: at(600) }],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 9_000_000,
    });
    expect(tree).toMatchObject({ status: "abortado", segundos: 600 });
  });
});
