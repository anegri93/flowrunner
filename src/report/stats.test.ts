import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import type { NewEvent, Outcome, Phase } from "../store/events.ts";
import { appendEvent } from "../store/run-log.ts";
import { createRun } from "../store/runs.ts";
import { motiveKey, stats } from "./stats.ts";

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
