import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import type { NewEvent, Outcome, Phase } from "../store/events.ts";
import { appendEvent } from "../store/run-log.ts";
import { createRun } from "../store/runs.ts";
import { describeStatsPorRun, motiveKey, stats, statsPorRun } from "./stats.ts";

function run(home: string, project: string, steps: [Phase, Outcome][], extra: NewEvent[] = []) {
  const r = createRun(
    home,
    { clave: "SHOP-1", proyecto: project, repo: "/r", budgetUsd: 25, featureText: "x" },
    new Date(),
  );
  for (const [fase, resultado] of steps) {
    appendEvent(r.dir, { tipo: "accion_iniciada", fase });
    appendEvent(r.dir, { tipo: "accion_terminada", fase, resultado });
  }
  for (const e of extra) appendEvent(r.dir, e);
}
const ok: Outcome = { tipo: "ok" };
const gate = (motivo: string): Outcome => ({ tipo: "falla", clase: "gate", motivo });

describe("stats", () => {
  // Si regresiona, la persona mejora la pieza equivocada de la fábrica.
  test("la fase con más reintentos encabeza y los motivos se agrupan aunque cambien rutas y números", () => {
    const home = tempDir("stats-");
    run(home, "acme", [
      [
        "planificar",
        gate("AC-1 ya pasa antes de implementar: `node tests/ac1.mjs` tiene que fallar"),
      ],
      ["planificar", ok],
      ["implementar", ok],
    ]);
    run(home, "acme", [
      [
        "planificar",
        gate("AC-3 ya pasa antes de implementar: `node tests/otro/ac3.mjs` tiene que fallar"),
      ],
      ["planificar", ok],
      ["verificar", { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-2 sigue en rojo" }],
    ]);
    const s = stats(home);
    expect(s.fases[0]).toMatchObject({ fase: "planificar", reintentos: 2 });
    expect(s.motivos[0]).toEqual({
      motivo:
        "planificar · gate: <id> ya pasa antes de implementar: `node <ruta>` tiene que fallar",
      veces: 2,
    });
  });

  test("un run detenido cuenta su costo parcial; un directorio sin eventos no rompe el total", () => {
    const home = tempDir("stats-");
    run(
      home,
      "acme",
      [["planificar", { tipo: "falla", clase: "entorno", motivo: "base roja" }]],
      [
        {
          tipo: "uso",
          fase: "planificar",
          sesion: "p",
          modelo: "m",
          costo_usd: 1.5,
          tokens_entrada: 1,
          tokens_salida: 1,
          duracion_ms: 1,
        },
      ],
    );
    mkdirSync(join(home, "runs", "VACIO-1"), { recursive: true });
    const s = stats(home);
    expect(s.runs).toBe(1);
    expect(s.fases.find((f) => f.fase === "planificar")?.costoUsd).toBe(1.5);
  });

  test("filtra por proyecto y suma las lecciones", () => {
    const home = tempDir("stats-");
    run(
      home,
      "acme",
      [["preparar", ok]],
      [{ tipo: "lecciones", url: "u", numero: 1, cantidad: 2, auto_merge: true }],
    );
    run(
      home,
      "otro",
      [["preparar", ok]],
      [{ tipo: "lecciones", url: "u", numero: 2, cantidad: 5, auto_merge: true }],
    );
    expect(stats(home, "acme")).toMatchObject({ runs: 1, lecciones: 2 });
    expect(stats(home)).toMatchObject({ runs: 2, lecciones: 7 });
  });

  test("motiveKey quita rutas, ids y números", () => {
    expect(motiveKey("src/billing/x.ts está fuera del alcance de ST-12")).toBe(
      "<ruta> está fuera del alcance de <id>",
    );
  });
});

/** Un run con relojes a mano: cada evento se escribe `ms` después del anterior. */
function runAt(
  home: string,
  inicio: number,
  pasos: [ms: number, event: NewEvent][],
  { clave = "SHOP-1", proyecto = "acme" } = {},
): string {
  let t = inicio;
  const r = createRun(
    home,
    { clave, proyecto, repo: "/r", budgetUsd: 25, featureText: "x" },
    new Date(t),
  );
  for (const [ms, event] of pasos) {
    t += ms;
    const now = new Date(t);
    appendEvent(r.dir, event, () => now);
  }
  return r.dir;
}
const SEG = 1000;
const MIN = 60 * SEG;
const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const inicia = (fase: Phase): NewEvent => ({ tipo: "accion_iniciada", fase });
const termina = (fase: Phase, resultado: Outcome = ok): NewEvent => ({
  tipo: "accion_terminada",
  fase,
  resultado,
});
const uso = (fase: Phase, costo: number): NewEvent => ({
  tipo: "uso",
  fase,
  sesion: "s",
  modelo: "m",
  costo_usd: costo,
  tokens_entrada: 1,
  tokens_salida: 1,
  duracion_ms: 1,
});
const rechazo = (herramienta: string): NewEvent => ({
  tipo: "rechazo",
  fase: "implementar",
  herramienta,
  motivo: "no",
});
/** Un run de `minutos` activos, con `costo` de planificar, sin fallas ni vueltas. */
const sencillo = (home: string, inicio: number, minutos: number, costo: number) =>
  runAt(home, inicio, [
    [0, inicia("planificar")],
    [0, uso("planificar", costo)],
    [minutos * MIN, termina("planificar")],
  ]);

describe("stats por run", () => {
  // Si regresiona, el tiempo de un run incluye las horas que esperó a la persona y la línea de base
  // mide la paciencia de quien aprueba, no la fábrica.
  test("stats por run suma el tiempo activo de las acciones, no las esperas", () => {
    const home = tempDir("stats-");
    runAt(home, T0, [
      [0, inicia("planificar")],
      [60 * SEG, termina("planificar")],
      [0, inicia("aprobar")],
      [0, termina("aprobar", { tipo: "espera" })],
      [10 * MIN, { tipo: "aprobado" }],
      [0, inicia("implementar")],
      [60 * SEG, termina("implementar")],
    ]);
    expect(statsPorRun(home).runs[0]?.activoMin).toBe(2);
  });

  // Si regresiona, un proceso cortado en el medio no suma lo que llevaba trabajado.
  test("una acción sin terminar cuenta hasta el último evento", () => {
    const home = tempDir("stats-");
    runAt(home, T0, [
      [0, inicia("implementar")],
      [3 * MIN, uso("implementar", 1)],
    ]);
    expect(statsPorRun(home).runs[0]?.activoMin).toBe(3);
  });

  // Si regresiona, la cuenta de runs derechos, la que dice si el plan mejoró algo, miente.
  test("un run sin fallas ni vueltas es derecho; con una vuelta, no", () => {
    const home = tempDir("stats-");
    runAt(home, T0, [
      [0, inicia("planificar")],
      [MIN, termina("planificar")],
      [0, inicia("verificar")],
      [MIN, termina("verificar")],
    ]);
    runAt(home, T0 + MIN, [
      [0, inicia("verificar")],
      [MIN, termina("verificar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "rojo" })],
      [0, inicia("implementar")],
      [MIN, termina("implementar")],
    ]);
    runAt(home, T0 + 2 * MIN, [
      [0, inicia("planificar")],
      [MIN, termina("planificar", gate("AC-1 ya pasa"))],
    ]);
    const [derecho, conVuelta, conFalla] = statsPorRun(home).runs;
    expect(derecho).toMatchObject({ derecho: true, vueltas: 0, fallas: 0 });
    expect(conVuelta).toMatchObject({ derecho: false, vueltas: 1, fallas: 0 });
    expect(conFalla).toMatchObject({ derecho: false, vueltas: 0, fallas: 1 });
  });

  // Si regresiona, los rechazos de comandos (PR 03) se confunden con los de rutas protegidas.
  test("cuenta los planes, y los rechazos de Bash aparte de los de escritura", () => {
    const home = tempDir("stats-");
    runAt(home, T0, [
      [0, inicia("planificar")],
      [MIN, termina("planificar", gate("AC-1 ya pasa"))],
      [0, inicia("planificar")],
      [MIN, termina("planificar")],
      [0, inicia("implementar")],
      [0, rechazo("Bash")],
      [0, rechazo("Bash")],
      [0, rechazo("Write")],
      [0, rechazo("Edit")],
      [0, rechazo("MultiEdit")],
      [0, rechazo("NotebookEdit")],
      [0, rechazo("Read")],
      [MIN, termina("implementar")],
    ]);
    expect(statsPorRun(home).runs[0]).toMatchObject({
      planes: 2,
      rechazosBash: 2,
      rechazosEscritura: 4,
    });
  });

  // Si regresiona, no se puede medir si el contexto de graft (PR 04) le ahorra lecturas a planificar.
  test("de las sesiones de planificar cuenta turnos, Read y graft, y salta una línea cortada", () => {
    const home = tempDir("stats-");
    const dir = runAt(home, T0, [
      [0, inicia("planificar")],
      [MIN, termina("planificar")],
    ]);
    mkdirSync(join(dir, "sesiones"));
    const linea = (o: object) => JSON.stringify(o);
    const toolUse = (name: string) => ({ type: "tool_use", id: name, name, input: {} });
    writeFileSync(
      join(dir, "sesiones", "planificar-1.jsonl"),
      [
        linea({ type: "system", subtype: "init" }),
        linea({
          type: "assistant",
          message: { content: [{ type: "text", text: "miro" }, toolUse("Read")] },
        }),
        linea({ type: "user", message: { content: [{ type: "tool_result" }] } }),
        linea({
          type: "assistant",
          message: { content: [toolUse("mcp__graft__graft_file_api")] },
        }),
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Re',
      ].join("\n"),
    );
    // Las sesiones de otras fases no son de planificar.
    writeFileSync(
      join(dir, "sesiones", "implementar-ST-1-1.jsonl"),
      `${linea({ type: "assistant", message: { content: [toolUse("Read")] } })}\n`,
    );
    expect(statsPorRun(home).runs[0]?.graftPlanificar).toEqual({
      llamadas: 1,
      reads: 1,
      turnos: 2,
    });
  });

  // Si regresiona, la mediana con la que se decide la fase 6 se corre con un número de runs par.
  test("el resumen da las medianas, con pares e impares", () => {
    expect(statsPorRun(tempDir("stats-")).resumen).toEqual({
      runs: 0,
      medianaActivoMin: 0,
      medianaCostoUsd: 0,
      planificarPct: 0,
      planesPorRun: 0,
      rechazosBashPorRun: 0,
      derechos: 0,
    });
    const home = tempDir("stats-");
    sencillo(home, T0, 10, 1);
    sencillo(home, T0 + MIN, 2, 3);
    runAt(home, T0 + 2 * MIN, [
      [0, inicia("planificar")],
      [0, uso("planificar", 2)],
      [0, rechazo("Bash")],
      [3 * MIN, termina("planificar")],
      [0, inicia("implementar")],
      [0, uso("implementar", 4)],
      [0, rechazo("Bash")],
      [3 * MIN, termina("implementar", gate("lint"))],
    ]);
    expect(statsPorRun(home).resumen).toEqual({
      runs: 3,
      medianaActivoMin: 6,
      medianaCostoUsd: 3,
      planificarPct: 60,
      planesPorRun: 1,
      rechazosBashPorRun: 2 / 3,
      derechos: 2,
    });
    sencillo(home, T0 + 3 * MIN, 1, 2);
    expect(statsPorRun(home).resumen).toMatchObject({
      runs: 4,
      medianaActivoMin: 4,
      medianaCostoUsd: 2.5,
    });
  });

  // Si regresiona, la tabla sale en el orden del nombre y no en el que se crearon los runs.
  test("el texto da una fila por run, en el orden en que se crearon, y el resumen debajo", () => {
    const home = tempDir("stats-");
    sencillo(home, T0, 1, 1);
    runAt(home, T0 + MIN, [], { clave: "AAA-1", proyecto: "otro" });
    const s = statsPorRun(home);
    expect(s.runs.map((r) => r.id.split("-")[0])).toEqual(["SHOP", "AAA"]);
    expect(statsPorRun(home, "otro").runs.map((r) => r.proyecto)).toEqual(["otro"]);
    const lines = describeStatsPorRun(s).split("\n");
    expect(lines[0]).toMatch(
      /^\| id +\| activo +\| US\$ +\| planes +\| rechazos +\| vueltas +\| derecho +\|$/,
    );
    expect(lines.filter((l) => l.startsWith("| SHOP-1") || l.startsWith("| AAA-1"))).toHaveLength(
      2,
    );
    expect(lines.at(-6)).toMatch(/activo/);
  });
});
