// T4.3: el run espera la aprobación sin proceso; plan, approve y changes desde el CLI real.
import { describe, expect, test } from "vitest";
import { planViewSchema } from "../src/cli/approval.ts";
import { isAlive, readLock } from "../src/store/lock.ts";
import { runCli } from "./helpers/cli.ts";
import { waitFor } from "./helpers/runs.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { simWorld } from "./helpers/sim-world.ts";

const world = () =>
  simWorld({
    real: ["preparar", "planificar", "aprobar"],
    scripts: [{ calls: [WRITE_TEST], output: PLAN }],
    feature: FEATURE,
    project: { config: { setup: "true", tests_globs: ["tests/**"] } },
  });

describe("aprobar", () => {
  // Si regresiona, el run deja un proceso vivo durante horas esperando que vuelvas.
  test("al llegar a la espera el proceso termina, el aviso dice qué pedirle a Claude y el lock queda", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    const holder = readLock(w.home, "acme-api");
    await waitFor("proceso terminado", () => holder !== undefined && !isAlive(holder.pid), 10_000);
    expect(readLock(w.home, "acme-api")?.run_id).toBe(id);
    expect(w.notices()).toContain(
      "SHOP-214: el plan espera tu aprobación. Pedile a Claude que te lo muestre.",
    );
  });

  test("plan --json muestra sub-tasks, criterios y el diff de los tests", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    const view = planViewSchema.parse(JSON.parse(runCli(["plan", id, "--json"], w.env).stdout));
    expect(view.subtareas.map((t) => t.id)).toEqual(["ST-1"]);
    expect(view.diff_tests).toContain("+process.exit(existsSync(");
    expect(runCli(["plan", id], w.env).stdout).toContain("ST-1  Serializador CSV  src/export/");
  });

  test("approve sobre un run que no espera sale 1 con su estado; changes sin motivo sale 1", async () => {
    const w = world();
    const id = w.launch();
    const early = runCli(["approve", id], w.env);
    expect(early.status).toBe(1);
    expect(early.stderr).toMatch(/no esperando aprobación/);
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    expect(runCli(["changes", id], w.env).status).toBe(1);
  });

  // Si regresiona, pedir cambios se pierde o te quema los intentos del plan corregido.
  test("changes con motivo vuelve a planificar con el motivo en el prompt y sin gastar intentos", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    expect(runCli(["changes", id, "separá", "la", "validación"], w.env).status).toBe(0);
    await waitFor(
      "esperando otra vez",
      () => {
        const s = w.state(id);
        return s.status === "esperando_aprobacion" && w.prompts().includes("separá la validación");
      },
      60_000,
    );
    expect(w.state(id).intentos).toBe(0);
  });
});
