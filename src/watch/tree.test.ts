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
      ["probar", "pendiente"],
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

  // Regresión de VF-6: rehecho desde planificar, el plan nuevo esperaba aprobación, pero implementar
  // y verificar seguían «falló» con el motivo de la corrida anterior, sus sub-tasks «integrada», y el
  // panel repetía el motivo y los botones de aprobar debajo de las tres etapas.
  test("rehacer desde una fase anterior deja pendientes las que siguen, con sus sub-tasks", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
        {
          tipo: "unidad",
          at: at(250),
          fase: "implementar",
          unidad: "ST-1",
          estado: "integrada",
          sha: "a",
        },
        { tipo: "accion_terminada", at: at(300), fase: "implementar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(300), fase: "verificar" },
        {
          tipo: "accion_terminada",
          at: at(320),
          fase: "verificar",
          resultado: { tipo: "falla", clase: "entorno", motivo: "el plan no se puede cumplir" },
        },
        { tipo: "rehacer", at: at(400), desde: "planificar" },
        { tipo: "accion_iniciada", at: at(400), fase: "planificar" },
        { tipo: "accion_terminada", at: at(500), fase: "planificar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(500), fase: "aprobar" },
        { tipo: "accion_terminada", at: at(500), fase: "aprobar", resultado: { tipo: "espera" } },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 600_000,
    });
    expect(tree.status).toBe("esperando_aprobacion");
    expect(tree.fases.filter((f) => !["ok", "pendiente"].includes(f.estado))).toEqual([
      expect.objectContaining({ fase: "aprobar", estado: "espera" }),
    ]);
    const verificar = tree.fases.find((f) => f.fase === "verificar");
    expect(verificar).toMatchObject({
      estado: "pendiente",
      nota: "falló en una corrida anterior; el run se rehízo desde planificar",
    });
    expect(verificar?.detalle).toBeUndefined();
    expect(tree.fases.find((f) => f.fase === "implementar")?.estado).toBe("pendiente");
    expect(tree.fases.find((f) => f.fase === "implementar")?.unidades[0]?.estado).toBe("pendiente");
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
  test("tokens nuevos: en vivo suma cada mensaje una vez sin las relecturas de caché, y al terminar usa el resultado", () => {
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
    // 2 mensajes distintos de 10 de entrada y 90 de salida; los 1000 leídos de caché no son nuevos.
    expect(live.fases[1]?.sesiones[0]).toMatchObject({
      tokens: 200,
      contexto: 1010,
      ventana: 1_000_000,
    });
    // Sonnet 5.5: 10 × $2 + 1000 × $0.10 + 90 × $10 por millón, dos veces.
    expect(live.fases[1]?.sesiones[0]?.costoEstimado).toBeCloseTo(0.00204, 6);
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
    expect(done.fases[1]?.sesiones[0]?.tokens).toBe(600);
  });

  // Regresión: CUENTAS-1 se abortó a mitad de planificar y de implementar. Horas después, el panel
  // seguía mostrando «trabajando», con el reloj de la fase en 5:28:22 y el costo de una sesión viva.
  test("un run abortado a mitad de una fase no la muestra corriendo, ni a su sub-task ni a su sesión", () => {
    const viva = session(
      [
        line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
        tool("Write", { file_path: "a.ts" }),
      ],
      200,
      230,
    );
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(170), fase: "implementar" },
        {
          tipo: "unidad",
          at: at(200),
          fase: "implementar",
          unidad: "ST-1",
          estado: "iniciada",
          sha: "a",
        },
        { tipo: "abortado", at: at(600) },
      ],
      tasks,
      titulo: "x",
      sessions: new Map([["implementar-ST-1-1", viva]]),
      now: T0 + 20_000_000,
    });
    const implementar = tree.fases.find((f) => f.fase === "implementar");
    expect(implementar).toMatchObject({ estado: "cortada", segundos: 430 });
    expect(implementar?.unidades[0]).toMatchObject({ id: "ST-1", estado: "cortada" });
    expect(implementar?.unidades[0]?.sesiones[0]).toMatchObject({
      corriendo: false,
      segundos: 400,
    });
  });

  // Si regresiona, un run cerrado hace horas sigue sumando minutos en watch.
  // Si regresiona, la tarjeta de un run que ya se va a pausar no lo dice, y Orca lo ofrece de nuevo.
  test("un run con la pausa pedida lo dice hasta que para", () => {
    const tree = (events: RunEvent[]) =>
      runTree({ events, tasks, titulo: "x", sessions: new Map(), now: T0 + 600_000 });
    expect(tree(base).pausaPedida).toBe(false);
    // `base` termina con aprobar empezado: la pausa espera a que termine.
    expect(tree([...base, { tipo: "pausa_pedida", at: at(170) }])).toMatchObject({
      status: "en_curso",
      pausaPedida: true,
    });
  });

  test("un run cerrado cuenta su tiempo hasta el último evento", () => {
    const tree = runTree({
      events: [...base, { tipo: "abortado", at: at(600) }],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 9_000_000,
    });
    expect(tree).toMatchObject({ status: "abortado", segundos: 600, haceSegundos: 8_400 });
  });

  // Si regresiona, un run entregado sigue sumando el tiempo que tarda tu merge (VF-2 marcaba 1:02:02),
  // o el panel no sabe que la PR ya se mergeó y sigue diciendo «espera merge».
  test("un run entregado para el reloj en la entrega y sabe si su PR ya se mergeó", () => {
    const delivered: RunEvent[] = [
      ...base,
      { tipo: "accion_terminada", at: at(200), fase: "aprobar", resultado: { tipo: "ok" } },
      { tipo: "accion_iniciada", at: at(200), fase: "entregar" },
      { tipo: "pr", at: at(290), url: "https://github.com/o/r/pull/4", numero: 4 },
      { tipo: "accion_terminada", at: at(300), fase: "entregar", resultado: { tipo: "ok" } },
    ];
    const open = runTree({
      events: delivered,
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 3_600_000,
    });
    expect(open).toMatchObject({
      status: "entregado",
      segundos: 300,
      prMergeada: false,
      haceSegundos: undefined,
    });
    const merged = runTree({
      events: [...delivered, { tipo: "pr_cerrada", at: at(900), mergeada: true }],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 3_600_000,
    });
    expect(merged).toMatchObject({ segundos: 300, prMergeada: true });
  });

  // Si regresiona, una fase que no corrió se ve con ✓, como si hubiera probado la feature.
  test("una fase salteada se ve salteada, con su motivo, y una que corrió se ve lista", () => {
    const motivo = "el repo no dice cómo levantar el entorno";
    const probar = (resultado: Extract<RunEvent, { tipo: "accion_terminada" }>["resultado"]) =>
      runTree({
        events: [
          ...base,
          { tipo: "accion_iniciada", at: at(200), fase: "probar" },
          { tipo: "accion_terminada", at: at(201), fase: "probar", resultado },
        ],
        tasks,
        titulo: "x",
        sessions: new Map(),
        now: T0 + 300_000,
      }).fases.find((f) => f.fase === "probar");
    expect(probar({ tipo: "ok", salteada: motivo })).toMatchObject({
      estado: "salteada",
      detalle: motivo,
    });
    expect(probar({ tipo: "ok" })).toMatchObject({ estado: "ok", detalle: undefined });
  });

  // Si regresiona, watch muestra el modelo sin el esfuerzo con que corrió cada fase.
  test("cada sesión lleva el esfuerzo configurado para su fase", () => {
    const tree = runTree({
      events: base,
      tasks,
      titulo: "x",
      sessions: new Map([["planificar-1", planSession]]),
      esfuerzos: { planificar: "high", implementar: "medium" },
      now: T0 + 300_000,
    });
    expect(tree.fases[1]?.sesiones[0]?.esfuerzo).toBe("high");
    expect(tree.haceSegundos).toBeUndefined();
  });

  // Si regresiona, durante la espera de un corte de red la sub-task se ve fallida, y la persona
  // rehace o aborta un run que solo esperaba la red.
  test("una sub-task cortada por la red se ve cortada, no fallida", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "aprobado", at: at(200) },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
        { tipo: "unidad", at: at(201), fase: "implementar", unidad: "ST-1", estado: "iniciada" },
        {
          tipo: "unidad",
          at: at(210),
          fase: "implementar",
          unidad: "ST-1",
          estado: "fallida",
          motivo: "la sesión implementar-ST-1-1 falló: getaddrinfo ENOTFOUND api.anthropic.com",
          corte_de_red: true,
        },
        {
          tipo: "accion_terminada",
          at: at(210),
          fase: "implementar",
          resultado: { tipo: "falla", clase: "infra", motivo: "getaddrinfo ENOTFOUND" },
        },
      ],
      tasks,
      titulo: "Cambios de un toque",
      sessions: new Map(),
      now: T0 + 220_000,
    });
    const impl = tree.fases.find((f) => f.fase === "implementar");
    expect(impl?.unidades.find((u) => u.id === "ST-1")?.estado).toBe("cortada");
  });

  // Si regresiona, watch muestra como fallado algo que el run ya resolvió y siguió adelante.
  test("una fase que falló pero que el run dejó atrás se ve resuelta, y su sub-task integrada también", () => {
    const tree = runTree({
      events: [
        ...base,
        { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
        { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
        {
          tipo: "unidad",
          at: at(210),
          fase: "implementar",
          unidad: "ST-1",
          estado: "integrada",
          sha: "a",
        },
        {
          tipo: "unidad",
          at: at(260),
          fase: "implementar",
          unidad: "ST-1",
          estado: "fallida",
          motivo: "sin cambios",
        },
        {
          tipo: "accion_terminada",
          at: at(300),
          fase: "implementar",
          resultado: { tipo: "falla", clase: "gate", motivo: "ST-1 no salió en 3 intentos" },
        },
        { tipo: "rehacer", at: at(400), desde: "verificar" },
        { tipo: "accion_iniciada", at: at(400), fase: "verificar" },
        { tipo: "accion_terminada", at: at(440), fase: "verificar", resultado: { tipo: "ok" } },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 500_000,
    });
    const impl = tree.fases.find((f) => f.fase === "implementar");
    expect(impl).toMatchObject({
      estado: "ok",
      nota: "falló en una corrida anterior; el run siguió desde verificar",
    });
    expect(impl?.unidades[0]?.estado).toBe("integrada");
  });

  // Si regresiona, la fila del planificador dice Haiku cuando lanza un explorador, o mide su contexto.
  test("el modelo es el del arranque y el contexto el de la sesión principal, aunque corra un subagente", () => {
    const main = line({
      type: "assistant",
      message: {
        id: "m",
        model: "claude-opus-5-5",
        content: [],
        usage: { cache_read_input_tokens: 170_000 },
      },
    });
    const sub = line({
      type: "assistant",
      parent_tool_use_id: "t1",
      message: {
        id: "s",
        model: "claude-haiku-5-5",
        content: [],
        usage: { cache_read_input_tokens: 9_000 },
      },
    });
    const tree = runTree({
      events: base,
      tasks,
      titulo: "x",
      sessions: new Map([
        [
          "planificar-1",
          session(
            [line({ type: "system", subtype: "init", model: "claude-opus-5-5" }), main, sub],
            40,
            60,
          ),
        ],
      ]),
      now: T0 + 100_000,
    });
    expect(tree.fases[1]?.sesiones[0]).toMatchObject({
      modelo: "claude-opus-5-5",
      contexto: 170_000,
    });
  });

  // Si regresiona, el total de una sesión terminada deja afuera a sus exploradores y no coincide con lo
  // que se veía en vivo: en VF-1, 487k en vivo y 348k al terminar.
  test("al terminar, los tokens nuevos suman todos los modelos de la sesión, subagentes incluidos", () => {
    const result = line({
      type: "result",
      total_cost_usd: 5.5,
      usage: { input_tokens: 92, cache_creation_input_tokens: 229_211, output_tokens: 118_425 },
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 92,
          outputTokens: 118_425,
          cacheCreationInputTokens: 229_211,
          cacheReadInputTokens: 5_907_833,
        },
        "claude-haiku-5-5": {
          inputTokens: 4_417,
          outputTokens: 69_300,
          cacheCreationInputTokens: 260_009,
          cacheReadInputTokens: 1_655_886,
        },
      },
    });
    const tree = runTree({
      events: base,
      tasks,
      titulo: "x",
      sessions: new Map([
        [
          "planificar-1",
          session(
            [line({ type: "system", subtype: "init", model: "claude-opus-5-5" }), result],
            40,
            60,
          ),
        ],
      ]),
      now: T0 + 100_000,
    });
    expect(tree.fases[1]?.sesiones[0]?.tokens).toBe(
      92 + 118_425 + 229_211 + 4_417 + 69_300 + 260_009,
    );
  });
});

describe("detenido con pregunta", () => {
  const first = base[0];
  if (first?.tipo !== "run_creado") throw new Error("base empieza con run_creado");
  const created: RunEvent = { ...first, vueltas: 0 };
  const through = (until: number): RunEvent[] => [
    created,
    ...base.slice(1),
    { tipo: "accion_terminada", at: at(161), fase: "aprobar", resultado: { tipo: "ok" } },
    { tipo: "accion_iniciada", at: at(200), fase: "implementar" },
    ...(until > 0
      ? ([
          { tipo: "accion_terminada", at: at(300), fase: "implementar", resultado: { tipo: "ok" } },
          { tipo: "accion_iniciada", at: at(300), fase: "verificar" },
        ] as RunEvent[])
      : []),
  ];

  // Si regresiona, watch y el panel de Orca no saben qué responderle a un run detenido.
  test("el árbol de un run detenido trae sus opciones y sus sub-tasks", () => {
    const tree = runTree({
      events: [
        ...through(1),
        {
          tipo: "accion_terminada",
          at: at(320),
          fase: "verificar",
          resultado: { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-2 sigue en rojo" },
        },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 400_000,
    });
    expect(tree.status).toBe("detenido");
    expect(tree.unidades).toEqual(["ST-2"]);
    expect(tree.opciones?.map((o) => o.comando)).toEqual([
      'flowrunner fix PIZ-1-x --unidad ST-2 "<qué cambiar>"',
      "flowrunner fix PIZ-1-x --auto",
      "flowrunner fix PIZ-1-x --yo",
      'flowrunner accept PIZ-1-x "<por qué>"',
      "flowrunner rerun PIZ-1-x --desde planificar",
      "flowrunner abort PIZ-1-x",
    ]);
    expect(tree.siguiente).toBe('flowrunner fix PIZ-1-x --unidad ST-2 "<qué cambiar>"');
    // Un run que no está detenido no trae opciones.
    const running = runTree({
      events: through(1),
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 400_000,
    });
    expect(running.opciones).toBeUndefined();
    expect(running.unidades).toBeUndefined();
  });

  // Si regresiona, una sub-task trabada se ve como si implementar hubiera terminado bien.
  test("una pregunta de implementar se ve como falla de esa fase, con su motivo", () => {
    const tree = runTree({
      events: [
        ...through(0),
        {
          tipo: "accion_terminada",
          at: at(300),
          fase: "implementar",
          resultado: {
            tipo: "pregunta",
            motivo: "ST-1 no cambió ningún archivo",
            unidades: ["ST-1", "ST-3"],
          },
        },
      ],
      tasks,
      titulo: "x",
      sessions: new Map(),
      now: T0 + 400_000,
    });
    expect(tree.fases.find((f) => f.fase === "implementar")).toMatchObject({
      estado: "falla",
      detalle: "ST-1 no cambió ningún archivo",
    });
    expect(tree.unidades).toEqual(["ST-1", "ST-3"]);
  });
});
