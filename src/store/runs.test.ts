import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Outcome, Phase } from "./events.ts";
import { appendEvent } from "./run-log.ts";
import { createRun, holderStatus, listRunIds, runPaths } from "./runs.ts";

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

describe("holderStatus", () => {
  // Si regresiona, otro run toma el repo mientras el plan de este espera tu aprobación.
  test("un run esperando aprobación conserva el lock aunque no tenga proceso", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-home-"));
    const id = runIn(home, ["preparar", ok], ["planificar", ok], ["aprobar", { tipo: "espera" }]);
    expect(holderStatus(home, id)).toBe("esperando");
  });

  test("un run entregado ya soltó el repo; uno en curso es activo", () => {
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
    expect(holderStatus(home, delivered)).toBe("terminado");
    const running = runIn(home, ["preparar", ok]);
    expect(holderStatus(home, running)).toBe("activo");
  });

  test("un run que no existe cuenta como terminado", () => {
    expect(holderStatus(mkdtempSync(join(tmpdir(), "fr-home-")), "NO-1")).toBe("terminado");
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
});
