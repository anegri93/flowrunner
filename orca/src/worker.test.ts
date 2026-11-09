// El worker con un flowrunner falso en vez del real: lo que lee, las decisiones que traduce a
// comandos fijos, y lo que rechaza antes de llegar al shell.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, mockHost, mountWorker, test } from "orca/testing";
import * as main from "./worker";

const FAKE = fileURLToPath(new URL("../test/fake-flowrunner.sh", import.meta.url));

/** Un worker con el flowrunner falso, y las llamadas que le llegaron. */
async function fakeWorker() {
  const log = join(mkdtempSync(join(tmpdir(), "flowrunner-orca-")), "llamadas.log");
  process.env.FAKE_LOG = log;
  const worker = await mountWorker(main, { host: mockHost({ settings: { comando: FAKE } }) });
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { worker, calls };
}

// Si regresiona, el panel no recibe los runs de flowrunner.
test("lee los runs con el comando de la config, los pasos de una sesión y el plan que espera", async () => {
  const { worker } = await fakeWorker();
  try {
    const snap = await worker.request("flowrunner.runs");
    assert.equal(snap.error, undefined);
    assert.deepEqual(
      snap.runs.map((r) => r.clave),
      ["VF-1", "VF-2", "PIZ-3"],
    );
    const steps = await worker.request("flowrunner.pasos", {
      run: "VF-2-20261109-001527",
      sesion: "implementar-ST-2-1",
    });
    assert.deepEqual(steps, { sesion: "implementar-ST-2-1", texto: "Edit src/precio.ts\nlisto" });
    const current = await worker.request("flowrunner.planActual");
    assert.equal(current.run?.clave, "PIZ-3");
    assert.deepEqual(current.plan, {
      subtareas: [{ id: "ST-1", titulo: "Variables de color" }],
      criterios: 1,
      cambios: ["sub-tasks nuevas: ST-1 Variables de color"],
      lineas: ["# Plan", "Modo oscuro con variables."],
    });
    assert.deepEqual(worker.refusals, []);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, aprobar o pedir cambios desde el panel no llega a flowrunner, o llega distinto.
test("cada decisión corre su comando fijo, con el motivo tal cual, y devuelve lo que dijo flowrunner", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "PIZ-3-20261109-010000";
  try {
    assert.deepEqual(
      await worker.request("flowrunner.decidir", { run: id, decision: { accion: "aprobar" } }),
      {
        ok: true,
        mensaje: "aprobado: implementar arrancó",
      },
    );
    const motivo = "no toques el 'login' ni $(whoami)";
    const changed = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "cambios", motivo },
    });
    assert.equal(changed.ok, true);
    const resumed = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "reanudar" },
    });
    assert.deepEqual(resumed, {
      ok: false,
      mensaje: `el run ${id} está en_curso, no detenido\nPara seguir: flowrunner status ${id}`,
    });
    assert.deepEqual(calls(), [
      `approve ${id} --json`,
      `changes ${id} ${motivo} --json`,
      `resume ${id} --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, «Plan» no abre la pestaña del plan, o la abre con otro run.
test("ver un plan abre su pestaña con el CLI de Orca y la pestaña muestra ese run", async () => {
  const { worker, calls } = await fakeWorker();
  process.env.ORCA_CLI = fileURLToPath(new URL("../test/fake-orca.sh", import.meta.url));
  try {
    const opened = await worker.request("flowrunner.verPlan", { run: "VF-2-20261109-001527" });
    assert.equal(opened.ok, true);
    assert.ok(calls().includes("orca plugin open local.flowrunner --panel plan"));
    const current = await worker.request("flowrunner.planActual");
    assert.equal(current.run?.clave, "VF-2");
  } finally {
    delete process.env.ORCA_CLI;
    await worker.deactivate();
  }
});

// Si regresiona, lo que llega del panel puede terminar como otro comando en el shell.
test("rechaza un id de run, una fase o un motivo inválidos sin llamar a flowrunner", async () => {
  const { worker, calls } = await fakeWorker();
  try {
    const bad = [
      { run: "x; touch /tmp/pwned", decision: { accion: "aprobar" as const } },
      { run: "VF-2-1", decision: { accion: "rehacer" as const, desde: "todo" as "verificar" } },
      { run: "VF-2-1", decision: { accion: "cambios" as const, motivo: "   " } },
    ];
    const answers = [];
    for (const input of bad) answers.push(await worker.request("flowrunner.decidir", input));
    assert.deepEqual(
      answers.map((a) => a.ok),
      [false, false, false],
    );
    assert.match(answers[0]?.mensaje ?? "", /id de run inválido/);
    assert.match(answers[1]?.mensaje ?? "", /fase inválida/);
    assert.match(answers[2]?.mensaje ?? "", /falta el motivo/);
    assert.deepEqual(calls(), []);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, un flowrunner que no está en el PATH deja el panel cargando para siempre.
test("si flowrunner falla, devuelve el error y ningún run", async () => {
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { comando: "/no/existe/flowrunner" } }),
  });
  try {
    const snap = await worker.request("flowrunner.runs");
    assert.deepEqual(snap.runs, []);
    assert.match(snap.error ?? "", /no such file|not found/i);
  } finally {
    await worker.deactivate();
  }
});
