// T4.3: el run espera la aprobación sin proceso; plan, approve y changes desde el CLI real.
import { describe, expect, test } from "vitest";
import { planViewSchema } from "../src/cli/approval.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { lockPid, waitFor } from "./helpers/runs.ts";
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
  // Desde el ADR 0019 esperar suelta el lugar: un plan que espera no le traba el repo a otro run.
  test("al llegar a la espera el proceso termina y suelta su lugar, y el aviso dice qué pedirle a Claude", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    await waitFor("lugar suelto", () => lockPid(w, id) === undefined, 10_000);
    // El aviso sale por osascript en segundo plano: puede escribirse después de soltar el lugar.
    await waitFor(
      "el aviso",
      () =>
        w
          .notices()
          .includes("SHOP-214: el plan espera tu aprobación. Pedile a Claude que te lo muestre."),
      10_000,
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

  // Si regresiona, la tercera vuelta del plan pierde lo que corrigió el primer pedido, y la persona no
  // ve qué cambió: en VF-1, la tercera vuelta perdió la entrada en CAMBIOS.md.
  test("dos changes seguidos: la tercera vuelta recibe los dos pedidos y el plan anterior, y plan --json trae el diff", async () => {
    const renamed = {
      ...PLAN,
      subtareas: PLAN.subtareas.map((t) => ({ ...t, titulo: "Exportador" })),
    };
    const w = simWorld({
      real: ["preparar", "planificar", "aprobar"],
      scripts: [
        { calls: [WRITE_TEST], output: PLAN },
        { calls: [], output: PLAN },
        { calls: [], output: renamed },
      ],
      feature: FEATURE,
      project: { config: { setup: "true", tests_globs: ["tests/**"] } },
    });
    const id = w.launch();
    const waiting = (n: number) =>
      waitFor(
        `esperando, vuelta ${String(n)}`,
        () =>
          w.state(id).status === "esperando_aprobacion" &&
          w.prompts().split("Sos el planificador").length - 1 === n,
        60_000,
      );
    await waiting(1);
    expect(runCli(["changes", id, "agregá la entrada en CAMBIOS.md"], w.env).status).toBe(0);
    await waiting(2);
    expect(runCli(["changes", id, "la tabla se llama costos"], w.env).status).toBe(0);
    await waiting(3);
    const third = w.prompts().split("Sos el planificador").at(-1) ?? "";
    expect(third).toContain("1. agregá la entrada en CAMBIOS.md\n2. la tabla se llama costos");
    expect(third).toContain("Un serializador en src/export/.");
    const view = planViewSchema.parse(JSON.parse(runCli(["plan", id, "--json"], w.env).stdout));
    expect(view.cambios).toMatchObject({
      subtareas_agregadas: ["ST-1 Exportador"],
      subtareas_quitadas: ["ST-1 Serializador CSV"],
      tests_quitados: [],
    });
    expect(runCli(["plan", id], w.env).stdout).toContain(
      "sub-tasks que ya no están: ST-1 Serializador CSV",
    );
  });

  // Si regresiona, no se puede saber si una aprobación vino de la terminal, de Claude o del botón de
  // Orca: en VF-6 hubo cuatro, a segundos del plan listo, y ninguna dice de dónde salió.
  test("approve y changes guardan su origen; sin --origen es terminal", async () => {
    const w = simWorld({
      real: ["preparar", "planificar", "aprobar"],
      scripts: [
        { calls: [WRITE_TEST], output: PLAN },
        { calls: [], output: PLAN },
      ],
      feature: FEATURE,
      project: { config: { setup: "true", tests_globs: ["tests/**"] } },
    });
    const id = w.launch();
    const waiting = (n: number) =>
      waitFor(
        `esperando, vuelta ${String(n)}`,
        () =>
          w.state(id).status === "esperando_aprobacion" &&
          w.prompts().split("Sos el planificador").length - 1 === n,
        60_000,
      );
    await waiting(1);
    expect(runCli(["changes", id, "x"], w.env).status).toBe(0);
    await waiting(2);
    expect(runCli(["approve", id, "--origen", "orca"], w.env).status).toBe(0);
    const decided = readLog(w.dir(id)).events.filter(
      (e) => e.tipo === "cambios_pedidos" || e.tipo === "aprobado",
    );
    expect(decided).toMatchObject([
      { tipo: "cambios_pedidos", motivo: "x", origen: "terminal" },
      { tipo: "aprobado", origen: "orca" },
    ]);
  });

  test("un origen inválido sale 1 y dice cuáles valen", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    const invalid = runCli(["approve", id, "--origen", "web"], w.env);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("--origen tiene que ser terminal, claude u orca");
    expect(w.state(id).status).toBe("esperando_aprobacion");
    expect(readLog(w.dir(id)).events.some((e) => e.tipo === "aprobado")).toBe(false);
  });
});

describe("aprobar un plan que cambia lo existente", () => {
  const CAMBIO = {
    que: "hoy el alta rechaza un correo de otro dominio; pasa a aceptarlo",
    donde: "src/alta.ts:585",
    criterio: "AC-1",
  };
  const changing = () =>
    simWorld({
      real: ["preparar", "planificar", "aprobar"],
      scripts: [{ calls: [WRITE_TEST], output: { ...PLAN, cambia_lo_existente: [CAMBIO] } }],
      feature: FEATURE,
      project: { config: { setup: "true", tests_globs: ["tests/**"] } },
    });

  // Si regresiona, un plan que afloja una regla vigente se aprueba con el mismo aviso y el mismo
  // comando que uno inofensivo, como pasó en CUENTAS-1.
  test("el aviso lo dice, plan lo muestra primero, approve sin --acepto-cambios sale 1 y con el flag sigue", async () => {
    const w = changing();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    await waitFor("el aviso", () => w.notices().includes("⚠ SHOP-214"), 10_000);
    expect(w.notices()).toContain(
      "⚠ SHOP-214: el plan cambia 1 cosa que ya existe. Pedile a Claude que te lo muestre antes de aprobar.",
    );
    const view = planViewSchema.parse(JSON.parse(runCli(["plan", id, "--json"], w.env).stdout));
    expect(view.cambia_lo_existente).toEqual([CAMBIO]);
    expect(runCli(["plan", id], w.env).stdout).toContain(
      "⚠ Cambia lo que ya existe (1). Aprobar pide --acepto-cambios:\n  - hoy el alta rechaza un correo de otro dominio; pasa a aceptarlo (src/alta.ts:585) ← AC-1",
    );

    const plain = runCli(["approve", id], w.env);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain("hoy el alta rechaza un correo de otro dominio");
    expect(plain.stderr).toContain("--acepto-cambios");
    expect(w.state(id).status).toBe("esperando_aprobacion");
    // El comando que sugiere conserva el origen: si no, la aprobación de Claude queda como terminal.
    const fromClaude = runCli(["approve", id, "--origen", "claude"], w.env);
    expect(fromClaude.status).toBe(1);
    expect(fromClaude.stderr).toContain(
      `flowrunner approve ${id} --acepto-cambios --origen claude`,
    );

    expect(runCli(["approve", id, "--acepto-cambios"], w.env).status).toBe(0);
  });

  test("un plan que no cambia nada se aprueba sin el flag, como siempre", async () => {
    const w = world();
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    expect(runCli(["approve", id], w.env).status).toBe(0);
  });
});
