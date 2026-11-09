// El worker con un flowrunner y un CLI de Orca falsos: lo que lee, lo que abre como pestaña, las
// decisiones que traduce a comandos fijos, y lo que rechaza antes de llegar al shell.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, mockHost, mountWorker, test } from "orca/testing";
import * as main from "./worker";

const FAKE = fileURLToPath(new URL("../test/fake-flowrunner.sh", import.meta.url));
const FAKE_ORCA = fileURLToPath(new URL("../test/fake-orca.sh", import.meta.url));
const WATCH = fileURLToPath(new URL("../test/watch.json", import.meta.url));

/** Un worker con los falsos, un repo git de verdad para los runs, y las llamadas que les llegaron. */
async function fakeWorker() {
  const tmp = mkdtempSync(join(tmpdir(), "flowrunner-orca-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const watch = join(tmp, "watch.json");
  writeFileSync(
    watch,
    readFileSync(WATCH, "utf8").replaceAll(/"repo": "[^"]*"/g, `"repo": "${repo}"`),
  );
  const log = join(tmp, "llamadas.log");
  process.env.FAKE_LOG = log;
  process.env.FAKE_WATCH = watch;
  process.env.ORCA_CLI = FAKE_ORCA;
  process.env.FAKE_REPO = repo;
  const worker = await mountWorker(main, { host: mockHost({ settings: { comando: FAKE } }) });
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { worker, calls, repo };
}

// Si regresiona, el panel no recibe los runs de flowrunner.
test("lee los runs con el comando de la config", async () => {
  const { worker } = await fakeWorker();
  try {
    const snap = await worker.request("flowrunner.runs");
    assert.equal(snap.error, undefined);
    assert.deepEqual(
      snap.runs.map((r) => r.clave),
      ["VF-1", "VF-2", "PIZ-3"],
    );
    assert.deepEqual(worker.refusals, []);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, «Pasos» y «Plan» no abren una pestaña de Orca con el archivo, o ensucian el repo.
test("abrir escribe los pasos o el plan en el .git del repo y los abre como pestaña en su proyecto", async () => {
  const { worker, calls, repo } = await fakeWorker();
  try {
    const steps = await worker.request("flowrunner.abrir", {
      run: "VF-2-20261109-001527",
      que: { tipo: "pasos", sesion: "implementar-ST-2-1" },
    });
    assert.deepEqual(steps, { ok: true, mensaje: "abierto" });
    const stepsFile = join(
      repo,
      ".git",
      "flowrunner",
      "VF-2-20261109-001527",
      "implementar-ST-2-1.md",
    );
    assert.match(readFileSync(stepsFile, "utf8"), /^# VF-2 · pasos de implementar-ST-2-1\n/);
    const plan = await worker.request("flowrunner.abrir", {
      run: "PIZ-3-20261109-010000",
      que: { tipo: "plan" },
    });
    assert.equal(plan.ok, true);
    const planFile = join(repo, ".git", "flowrunner", "PIZ-3-20261109-010000", "plan.md");
    assert.match(readFileSync(planFile, "utf8"), /- \*\*ST-1\*\* Variables de color/);
    const opens = calls().filter((c) => c.startsWith("orca "));
    assert.deepEqual(opens, [
      `orca file open ${stepsFile} --worktree path:${repo} --focus`,
      `orca file open ${planFile} --worktree path:${repo} --focus`,
    ]);
    assert.equal(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }),
      "",
    );
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, el informe de un run que se cerró no se puede abrir: ya no está entre los activos.
test("abrir el informe de un run cerrado lo escribe en el .git de su repo y lo abre", async () => {
  const { worker, calls, repo } = await fakeWorker();
  try {
    const id = "VF-9-20261109-000000";
    assert.deepEqual(
      await worker.request("flowrunner.abrir", { run: id, que: { tipo: "informe" } }),
      { ok: true, mensaje: "abierto" },
    );
    const file = join(repo, ".git", "flowrunner", id, "informe.md");
    assert.match(readFileSync(file, "utf8"), /- \*\*Estado:\*\* cerrado/);
    assert.ok(calls().includes(`orca file open ${file} --worktree path:${repo} --focus`));
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, tocar una sub-task en el panel no abre lo que implementó.
test("abrir una sub-task pide su informe a flowrunner y lo abre como pestaña en el proyecto del run", async () => {
  const { worker, calls, repo } = await fakeWorker();
  try {
    const id = "VF-2-20261109-001527";
    assert.deepEqual(
      await worker.request("flowrunner.abrir", {
        run: id,
        que: { tipo: "unidad", unidad: "ST-2" },
      }),
      { ok: true, mensaje: "abierto" },
    );
    const file = join(repo, ".git", "flowrunner", id, "ST-2.md");
    assert.match(readFileSync(file, "utf8"), /^# ST-2\n\n```diff\n\+precio\n```\n$/);
    assert.ok(calls().includes(`report ${id} --unidad ST-2 --json`));
    assert.ok(calls().includes(`orca file open ${file} --worktree path:${repo} --focus`));
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, tocar una etapa en el panel no abre su detalle.
test("abrir una etapa pide su detalle a flowrunner y lo abre como pestaña en el proyecto del run", async () => {
  const { worker, calls, repo } = await fakeWorker();
  try {
    const id = "VF-2-20261109-001527";
    assert.deepEqual(
      await worker.request("flowrunner.abrir", {
        run: id,
        que: { tipo: "etapa", fase: "verificar" },
      }),
      { ok: true, mensaje: "abierto" },
    );
    const file = join(repo, ".git", "flowrunner", id, "etapa-verificar.md");
    assert.equal(readFileSync(file, "utf8"), "# verificar\n\nok\n");
    assert.ok(calls().includes(`report ${id} --fase verificar --json`));
    assert.ok(calls().includes(`orca file open ${file} --worktree path:${repo} --focus`));
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
      { ok: true, mensaje: "aprobado: implementar arrancó" },
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
    const learned = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprender" },
    });
    assert.deepEqual(learned, { ok: true, mensaje: "la PR sigue abierta" });
    assert.deepEqual(calls(), [
      `approve ${id} --json`,
      `changes ${id} ${motivo} --json`,
      `resume ${id} --json`,
      `learn ${id} --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, lo que llega del panel puede terminar como otro comando en el shell o en otra ruta.
test("rechaza un id, una fase, un motivo, una sesión, una sub-task o una etapa inválidos sin llamar a flowrunner", async () => {
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
    const path = await worker.request("flowrunner.abrir", {
      run: "VF-2-20261109-001527",
      que: { tipo: "pasos", sesion: "../../etc/passwd" },
    });
    assert.equal(path.ok, false);
    assert.match(path.mensaje, /sesión inválida/);
    const unit = await worker.request("flowrunner.abrir", {
      run: "VF-2-20261109-001527",
      que: { tipo: "unidad", unidad: "ST-1; rm -rf ~" },
    });
    assert.equal(unit.ok, false);
    assert.match(unit.mensaje, /sub-task inválida/);
    const stage = await worker.request("flowrunner.abrir", {
      run: "VF-2-20261109-001527",
      que: { tipo: "etapa", fase: "todo; rm -rf ~" },
    });
    assert.equal(stage.ok, false);
    assert.match(stage.mensaje, /etapa inválida/);
    assert.deepEqual(calls(), []);
  } finally {
    await worker.deactivate();
  }
});

// Regresión: Orca lanza el worker con un entorno recortado, sin USER ni LOGNAME y con
// ELECTRON_RUN_AS_NODE. Un run aprobado desde el panel lo heredaba, y Claude no encontraba la sesión
// del Keychain: «Claude rechazó la credencial de la sesión» en VF-3 y VF-4.
test("los comandos corren con tu usuario y sin las variables de Orca", async () => {
  const saved = { ...process.env };
  const { worker } = await fakeWorker();
  const envLog = join(mkdtempSync(join(tmpdir(), "flowrunner-env-")), "env.log");
  try {
    delete process.env.USER;
    delete process.env.LOGNAME;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_CHANNEL_FD = "3";
    process.env.FAKE_ENV_LOG = envLog;
    await worker.request("flowrunner.runs");
    assert.equal(
      readFileSync(envLog, "utf8").trim(),
      `USER=${userInfo().username} LOGNAME=${userInfo().username} ELECTRON_RUN_AS_NODE= NODE_CHANNEL_FD=`,
    );
  } finally {
    process.env = saved;
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
