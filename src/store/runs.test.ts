import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Outcome, Phase } from "./events.ts";
import { appendEvent, readLog } from "./run-log.ts";
import { colaDe, createRun, listRunIds, ocupaLugar, runPaths } from "./runs.ts";

function runIn(home: string, ...steps: [Phase, Outcome][]): string {
  const run = createRun(
    home,
    { clave: "SHOP-1", proyecto: "acme", repo: "/r", budgetUsd: 25, featureText: "x" },
    new Date("2026-11-07T10:00:00Z"),
  );
  for (const [fase, resultado] of steps) {
    appendEvent(run.dir, { tipo: "accion_iniciada", fase });
    appendEvent(run.dir, { tipo: "accion_terminada", fase, resultado });
  }
  return run.id;
}

const ok: Outcome = { tipo: "ok" };

describe("ocupaLugar y colaDe", () => {
  // Si regresiona, un plan que espera tu aprobación le traba el repo a los demás runs.
  test("un run esperando aprobación no ocupa lugar; uno en curso sí", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const waiting = runIn(
      home,
      ["preparar", ok],
      ["planificar", ok],
      ["aprobar", { tipo: "espera" }],
    );
    const running = runIn(home, ["preparar", ok]);
    expect(ocupaLugar(home, waiting)).toBe(false);
    expect(ocupaLugar(home, running)).toBe(true);
  });

  test("un run entregado, uno en cola y uno que no existe no ocupan lugar", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const phases: Phase[] = [
      "preparar",
      "planificar",
      "aprobar",
      "implementar",
      "verificar",
      "revisar",
      "entregar",
    ];
    const delivered = runIn(home, ...phases.map((f): [Phase, Outcome] => [f, ok]));
    expect(ocupaLugar(home, delivered)).toBe(false);
    const queued = runIn(home);
    appendEvent(runPaths(home, queued).dir, { tipo: "encolado" });
    expect(ocupaLugar(home, queued)).toBe(false);
    expect(ocupaLugar(home, "NO-1")).toBe(false);
  });

  // Si regresiona, una feature recién lanzada pasa antes que un run que ya esperó su plan.
  test("la cola sale por el más viejo y solo trae los runs en cola del proyecto", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const at = (iso: string) => new Date(iso);
    const make = (clave: string, proyecto: string, iso: string) =>
      createRun(home, { clave, proyecto, repo: "/r", featureText: "x" }, at(iso)).id;
    const nuevo = make("B-1", "acme", "2026-11-09T12:00:00Z");
    const viejo = make("Z-1", "acme", "2026-11-09T10:00:00Z");
    const otroProyecto = make("C-1", "otro", "2026-11-09T09:00:00Z");
    const enCurso = make("D-1", "acme", "2026-11-09T08:00:00Z");
    for (const id of [nuevo, viejo, otroProyecto])
      appendEvent(runPaths(home, id).dir, { tipo: "encolado" });
    expect(colaDe(home, "acme").map((q) => q.id)).toEqual([viejo, nuevo]);
    expect(colaDe(home, "acme").map((q) => q.id)).not.toContain(enCurso);
  });
});

describe("createRun", () => {
  test("dos runs de la misma clave en el mismo segundo tienen ids distintos", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const a = runIn(home);
    const b = runIn(home);
    expect(a).not.toBe(b);
    expect(listRunIds(home)).toEqual([a, b].sort());
    expect(runPaths(home, b).dir).toBe(join(home, "runs", b));
  });

  // Si regresiona, un run nuevo trata un corte de red como cualquier falla de infraestructura.
  test("un run nuevo congela sus reintentos de red en run_creado", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const id = runIn(home);
    expect(readLog(runPaths(home, id).dir).events[0]).toMatchObject({
      tipo: "run_creado",
      reintentos_red: 3,
    });
  });
});
