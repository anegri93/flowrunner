// Gate de la Fase 4: preparar, planificar y aprobar reales con el SDK simulado; el resto falso.
import { describe, expect, test } from "vitest";
import { isAlive, readLock } from "../src/store/lock.ts";
import { runCli } from "./helpers/cli.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { executions, waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

describe("Fase 4 ensamblada", () => {
  // Si regresiona, el plan que aprobás no es el que implementa el run, o el run nunca te espera.
  test("espera sin proceso, changes replanifica, el segundo plan pasa y approve lleva a entregado", async () => {
    const second = { ...PLAN, plan: "# Plan corregido\nValidación aparte." };
    const w = simWorld({
      real: ["preparar", "planificar", "aprobar"],
      scripts: [
        { calls: [WRITE_TEST], output: PLAN },
        { calls: [WRITE_TEST], output: second },
      ],
      feature: FEATURE,
      project: { config: { setup: "true", tests_globs: ["tests/**"] } },
    });
    const id = w.launch();
    await waitFor("primera espera", () => w.state(id).status === "esperando_aprobacion", 60_000);
    const holder = readLock(w.home, "acme-api");
    await waitFor("sin proceso", () => holder !== undefined && !isAlive(holder.pid), 10_000);

    expect(runCli(["changes", id, "separá la validación"], w.env).status).toBe(0);
    await waitFor(
      "segunda espera",
      () =>
        w.state(id).status === "esperando_aprobacion" &&
        w.prompts().includes("separá la validación"),
      60_000,
    );
    expect(runCli(["plan", id], w.env).stdout).toContain("Plan corregido");

    expect(runCli(["approve", id], w.env).status).toBe(0);
    await waitFor("entregado", () => w.state(id).status === "entregado", 60_000);
    expect(executions(w, id)).toEqual(["implementar", "verificar", "revisar", "entregar"]);
  }, 180_000);
});
