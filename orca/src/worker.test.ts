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

/** Las llamadas sin las lecturas de los runs. */
const decided = (calls: string[]) => calls.filter((c) => !c.startsWith("watch "));

// Si regresiona, el panel no recibe los runs de flowrunner.
test("lee los runs con el comando de la config, también los cerrados", async () => {
  const { worker } = await fakeWorker();
  const log = join(mkdtempSync(join(tmpdir(), "flowrunner-log-")), "llamadas.log");
  process.env.FAKE_LOG = log;
  try {
    const snap = await worker.request("flowrunner.runs");
    assert.equal(snap.error, undefined);
    assert.deepEqual(
      snap.runs.map((r) => r.clave),
      ["VF-1", "VF-2", "PIZ-3"],
    );
    assert.match(readFileSync(log, "utf8"), /^watch --json --cerrados$/m);
    assert.deepEqual(worker.refusals, []);
  } finally {
    delete process.env.FAKE_LOG;
    await worker.deactivate();
  }
});

// Si regresiona, cambiar de proyecto en Orca vuelve a esperar a flowrunner, aunque los runs se leyeron
// recién: solo cambia cuáles se muestran.
test("al cambiar de proyecto reusa la lectura reciente; un refresco lee de nuevo", async () => {
  const { worker, calls } = await fakeWorker();
  try {
    await worker.request("flowrunner.runs");
    const snap = await worker.request("flowrunner.runs", { reciente: true });
    assert.equal(snap.runs.length, 3);
    assert.equal(calls().filter((c) => c.startsWith("watch ")).length, 1);
    await worker.request("flowrunner.runs");
    assert.equal(calls().filter((c) => c.startsWith("watch ")).length, 2);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, el panel muestra los runs de todos los proyectos, en lugar de seguir al proyecto que
// tiene enfocado Orca como el explorador o los agentes.
test("lee solo los runs del proyecto enfocado en Orca y cuenta los demás; sin permiso, todos", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "flowrunner-proyectos-"));
  const repoA = join(tmp, "videoFactory");
  const repoB = join(tmp, "pizarra-en-vivo");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const r of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    execFileSync("git", ["-C", r, "commit", "-q", "--allow-empty", "-m", "x"], { env: gitEnv });
  }
  // Un worktree del repo A, como los que abre Orca o los de un run: es el mismo proyecto.
  const linked = join(tmp, "videoFactory-otra-rama");
  execFileSync("git", ["-C", repoA, "worktree", "add", "-q", "-b", "otra", linked]);
  const watch = join(tmp, "watch.json");
  const data = JSON.parse(readFileSync(WATCH, "utf8")) as {
    runs: { id: string; clave: string; repo: string; status: string }[];
  };
  // Un run cerrado del proyecto A: va aparte y no cuenta entre los activos de otros proyectos.
  const first = data.runs[0];
  if (first === undefined) throw new Error("watch.json sin runs");
  data.runs.push({ ...first, id: "VF-0-20261101-000000", clave: "VF-0", status: "cerrado" });
  for (const r of data.runs) r.repo = r.clave.startsWith("VF-") ? repoA : repoB;
  writeFileSync(watch, JSON.stringify(data));
  process.env.FAKE_WATCH = watch;
  process.env.ORCA_CLI = FAKE_ORCA;
  const workspaces = {
    workspaces: [
      {
        id: "a",
        kind: "worktree",
        name: "otra",
        path: linked,
        branch: "refs/heads/otra",
        hostId: "local",
      },
      {
        id: "b",
        kind: "worktree",
        name: "main",
        path: repoB,
        branch: "refs/heads/main",
        hostId: "local",
      },
    ],
    truncated: false,
  };
  const mount = async (
    context: { branch: string; displayName: string; terminals: { id: string }[] },
    capabilities?: string[],
  ) =>
    mountWorker(main, {
      host: mockHost({
        settings: { comando: FAKE },
        ...(capabilities === undefined ? {} : { capabilities }),
        results: { "workspace.readContext": context, "workspace.list": workspaces },
      }),
    });
  try {
    // Por su terminal: el CLI de Orca dice en qué worktree está.
    process.env.FAKE_TERMINAL = "term_1";
    process.env.FAKE_TERMINAL_PATH = linked;
    const byTerminal = await mount({
      branch: "otra",
      displayName: "otra",
      terminals: [{ id: "term_1" }],
    });
    const a = await byTerminal.request("flowrunner.runs");
    await byTerminal.deactivate();
    assert.deepEqual(
      a.runs.map((r) => r.clave),
      ["VF-1", "VF-2"],
    );
    assert.deepEqual([a.proyecto, a.otros], ["videoFactory", 1]);
    assert.deepEqual(
      a.cerrados?.map((r) => r.clave),
      ["VF-0"],
    );
    // Sin terminales, por nombre y rama.
    const byName = await mount({ branch: "main", displayName: "main", terminals: [] });
    const b = await byName.request("flowrunner.runs");
    await byName.deactivate();
    assert.deepEqual(
      b.runs.map((r) => r.clave),
      ["PIZ-3"],
    );
    assert.deepEqual([b.proyecto, b.otros], ["pizarra-en-vivo", 2]);
    assert.deepEqual(b.cerrados, []);
    // Sin el permiso `workspace:read`, aprobado todavía no: todos, como antes.
    const denied = await mount({ branch: "main", displayName: "main", terminals: [] }, [
      "settings:own",
    ]);
    const c = await denied.request("flowrunner.runs");
    await denied.deactivate();
    assert.equal(c.runs.length, 3);
    assert.equal(c.cerrados?.length, 1);
    assert.equal(c.proyecto, undefined);
  } finally {
    delete process.env.FAKE_TERMINAL;
    delete process.env.FAKE_TERMINAL_PATH;
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

// Si regresiona, la explicación de una detención no se abre, o el panel espera los minutos que tarda
// escribirla y Orca corta el comando a los 20 s (ADR 0037).
test("abrir la explicación corre explain --fondo: lista, la abre como pestaña; si se escribe, lo dice sin abrir", async () => {
  const { worker, calls, repo } = await fakeWorker();
  const id = "VF-2-20261109-001527";
  try {
    assert.deepEqual(
      await worker.request("flowrunner.abrir", { run: id, que: { tipo: "explicacion" } }),
      { ok: true, mensaje: "abierto" },
    );
    const file = join(repo, ".git", "flowrunner", id, "explicacion.md");
    assert.equal(readFileSync(file, "utf8"), "# Por qué se detuvo\n\nfalta pipefail\n");
    assert.ok(calls().includes(`explain ${id} --fondo --json`));
    assert.ok(calls().includes(`orca file open ${file} --worktree path:${repo} --focus`));

    process.env.FAKE_EXPLICANDO = "1";
    const before = calls().filter((c) => c.startsWith("orca file open")).length;
    assert.deepEqual(
      await worker.request("flowrunner.abrir", { run: id, que: { tipo: "explicacion" } }),
      { ok: true, mensaje: "explicando: te aviso cuando esté", explicando: true },
    );
    assert.equal(calls().filter((c) => c.startsWith("orca file open")).length, before);
  } finally {
    delete process.env.FAKE_EXPLICANDO;
    await worker.deactivate();
  }
});

// Si regresiona, pausar o priorizar desde el panel no llega a flowrunner, o un --para cualquiera
// llega al shell.
test("pausar y priorizar corren pause y prioritize con --origen orca; un --para inválido se rechaza", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "VF-2-20261109-001527";
  try {
    await worker.request("flowrunner.decidir", { run: id, decision: { accion: "pausar" } });
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "pausar", para: "VF-7-20261112-000000" },
    });
    await worker.request("flowrunner.decidir", {
      run: "VF-7-20261112-000000",
      decision: { accion: "priorizar" },
    });
    const bad = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "pausar", para: "x; rm -rf ~" },
    });
    assert.equal(bad.ok, false);
    assert.deepEqual(decided(calls()), [
      `pause ${id} --origen orca --json`,
      `pause ${id} --para VF-7-20261112-000000 --origen orca --json`,
      "prioritize VF-7-20261112-000000 --origen orca --json",
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, aprobar o pedir cambios desde el panel no llega a flowrunner, o llega distinto.
test("cada decisión corre su comando fijo, con el motivo tal cual, y devuelve lo que dijo flowrunner", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "PIZ-3-20261109-010000";
  const plan = `${id}#1`;
  try {
    assert.deepEqual(
      await worker.request("flowrunner.decidir", {
        run: id,
        decision: { accion: "aprobar", plan },
      }),
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
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", aceptoCambios: true, plan },
    });
    // Solo `true` acepta: cualquier otra cosa que llegue del panel aprueba sin aceptar nada.
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", aceptoCambios: "--force" as unknown as true, plan },
    });
    assert.deepEqual(
      await worker.request("flowrunner.decidir", { run: id, decision: { accion: "abortar" } }),
      { ok: true, mensaje: "abortado; las ramas quedan" },
    );
    // Antes de aprobar lee los runs para comparar el plan: acá cuentan los comandos de cada decisión.
    assert.deepEqual(decided(calls()), [
      `approve ${id} --origen orca --json`,
      `changes ${id} ${motivo} --origen orca --json`,
      `resume ${id} --json`,
      `learn ${id} --fondo --json`,
      `approve ${id} --acepto-cambios --origen orca --json`,
      `approve ${id} --origen orca --json`,
      `abort ${id} --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, el panel aprueba con una foto vieja un plan corregido que nadie abrió: el panel
// estaba oculto, o la lectura fallaba, mientras se pedían cambios desde la terminal (D3).
test("aprobar solo corre si el plan sigue en la versión que se abrió", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "PIZ-3-20261109-010000";
  try {
    const stale = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", plan: `${id}#0` },
    });
    assert.equal(stale.ok, false);
    assert.match(stale.mensaje, /el plan de PIZ-3 cambió desde que lo abriste/);
    const missing = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar" } as never,
    });
    assert.equal(missing.ok, false);
    assert.equal(
      calls().some((c) => c.startsWith("approve")),
      false,
    );
    const fresh = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", plan: `${id}#1` },
    });
    // Un run que ya no espera aprobación tampoco se aprueba, aunque la versión coincida.
    const running = await worker.request("flowrunner.decidir", {
      run: "VF-2-20261109-001527",
      decision: { accion: "aprobar", plan: "VF-2-20261109-001527#1" },
    });
    assert.deepEqual(running, {
      ok: false,
      mensaje: "el run VF-2-20261109-001527 ya no espera aprobación",
    });
    assert.equal(
      decided(calls()).some((c) => c.startsWith("approve VF-2")),
      false,
    );
    assert.deepEqual(fresh, { ok: true, mensaje: "aprobado: implementar arrancó" });
    assert.equal(decided(calls()).at(-1), `approve ${id} --origen orca --json`);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, una aprobación del panel queda en el log como si viniera de la terminal, y no se
// puede saber si salió del botón de Orca, como en VF-6.
test("aprobar y cambios mandan --origen orca", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "PIZ-3-20261109-010000";
  try {
    const plan = `${id}#1`;
    await worker.request("flowrunner.decidir", { run: id, decision: { accion: "aprobar", plan } });
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", aceptoCambios: true, plan },
    });
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "cambios", motivo: "separá la validación" },
    });
    assert.deepEqual(decided(calls()), [
      `approve ${id} --origen orca --json`,
      `approve ${id} --acepto-cambios --origen orca --json`,
      `changes ${id} separá la validación --origen orca --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, la respuesta del panel a un run detenido no llega, o llega sin decir que vino de Orca.
test("arreglar, Autofix y aceptar se traducen a fix y accept con --origen orca", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "VF-2-20261109-001527";
  try {
    const instruccion = "no toques el 'login' ni $(whoami)";
    const fixed = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "arreglar", unidad: "ST-2", instruccion },
    });
    assert.deepEqual(fixed, { ok: true, mensaje: "arreglando" });
    await worker.request("flowrunner.decidir", { run: id, decision: { accion: "autofix" } });
    const accepted = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aceptar", motivo: "AC-1 es flaky" },
    });
    assert.deepEqual(accepted, { ok: true, mensaje: "aceptado: revisar arrancó" });
    assert.deepEqual(calls(), [
      `fix ${id} --unidad ST-2 ${instruccion} --origen orca --json`,
      `fix ${id} --auto --origen orca --json`,
      `accept ${id} AC-1 es flaky --origen orca --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, el panel puede mandar a flowrunner una sub-task que es un comando, o un fix vacío.
test("un arreglo con una sub-task inválida o sin instrucción se rechaza", async () => {
  const { worker, calls } = await fakeWorker();
  const run = "VF-2-20261109-001527";
  try {
    const bad = [
      { accion: "arreglar" as const, unidad: "ST-1; rm -rf ~", instruccion: "x" },
      { accion: "arreglar" as const, unidad: "ST-1", instruccion: "   " },
      { accion: "arreglar" as const, unidad: "ST-1", instruccion: "x".repeat(2_001) },
      { accion: "aceptar" as const, motivo: "" },
    ];
    const answers = [];
    for (const decision of bad)
      answers.push(await worker.request("flowrunner.decidir", { run, decision }));
    assert.deepEqual(
      answers.map((a) => a.ok),
      [false, false, false, false],
    );
    assert.match(answers[0]?.mensaje ?? "", /sub-task inválida/);
    assert.match(answers[1]?.mensaje ?? "", /falta la instrucción/);
    assert.match(answers[2]?.mensaje ?? "", /demasiado larga/);
    assert.match(answers[3]?.mensaje ?? "", /falta el motivo/);
    assert.deepEqual(calls(), []);
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

// Si regresiona, el doctor del panel no muestra nada justo cuando a la máquina le falta algo: doctor
// sale 1 y su JSON vale igual.
test("el doctor lee doctor --json aunque salga 1, con la versión y las tareas", async () => {
  const { worker, calls } = await fakeWorker();
  try {
    const snap = await worker.request("flowrunner.doctor");
    assert.equal(snap.error, undefined);
    assert.equal(snap.doctor?.ok, false);
    assert.deepEqual(
      snap.doctor?.checks.map((c) => [c.nombre, c.ok]),
      [
        ["git", true],
        ["gh con sesión", false],
      ],
    );
    assert.deepEqual(snap.doctor?.version, { sha: "1a2b3c4", main: "9f8e7d6", atras: 3 });
    assert.deepEqual(decided(calls()), ["doctor --json", "tareas --json"]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, actualizar desde el panel corta a los 20 s del worker, o deja pasar otra cosa al
// shell: cada mantenimiento es un comando fijo que corre aparte.
test("cada mantenimiento corre su comando fijo con --fondo; uno desconocido no llega a flowrunner", async () => {
  const { worker, calls } = await fakeWorker();
  try {
    const update = await worker.request("flowrunner.mantener", {
      mantenimiento: { accion: "actualizar" },
    });
    assert.deepEqual(update, { ok: true, mensaje: "actualizando flowrunner a origin/main" });
    const plugin = await worker.request("flowrunner.mantener", {
      mantenimiento: { accion: "plugin" },
    });
    assert.deepEqual(plugin, { ok: true, mensaje: "cargando el plugin en Orca" });
    const bad = await worker.request("flowrunner.mantener", {
      mantenimiento: { accion: "rm -rf ~" as "plugin" },
    });
    assert.equal(bad.ok, false);
    assert.deepEqual(decided(calls()), [
      "self-update --fondo --json",
      "orca install --fondo --json",
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, saltear probar desde el panel no llega a flowrunner, llega sin motivo o sin origen
// (ADR 0036).
test("saltear probar, volver a probar y aprobar sin probar corren su comando fijo con --origen orca", async () => {
  const { worker, calls } = await fakeWorker();
  const id = "PIZ-3-20261109-010000";
  try {
    const plan = `${id}#1`;
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "saltearProbar", motivo: "solo docs" },
    });
    await worker.request("flowrunner.decidir", { run: id, decision: { accion: "volverAProbar" } });
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", plan, sinProbar: "sin entorno" },
    });
    await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", plan, aceptoCambios: true, sinProbar: "sin entorno" },
    });
    const vacio = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "saltearProbar", motivo: "  " },
    });
    assert.equal(vacio.ok, false);
    const aprobarVacio = await worker.request("flowrunner.decidir", {
      run: id,
      decision: { accion: "aprobar", plan, sinProbar: "" },
    });
    assert.equal(aprobarVacio.ok, false);
    assert.deepEqual(decided(calls()), [
      `skip-probar ${id} solo docs --origen orca --json`,
      `skip-probar ${id} --deshacer --origen orca --json`,
      `approve ${id} --sin-probar sin entorno --origen orca --json`,
      `approve ${id} --acepto-cambios --sin-probar sin entorno --origen orca --json`,
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, el panel no ve en qué quedó una actualización que corre aparte.
test("las tareas salen de flowrunner tareas --json", async () => {
  const { worker } = await fakeWorker();
  const file = join(mkdtempSync(join(tmpdir(), "flowrunner-tareas-")), "tareas.json");
  writeFileSync(
    file,
    JSON.stringify({
      ok: true,
      tareas: [
        {
          nombre: "orca-install",
          estado: "falla",
          inicio: "2026-11-17T12:00:00Z",
          fin: "2026-11-17T12:00:05Z",
          mensaje: "Orca pide aprobar el plugin",
          siguiente: "flowrunner orca install --approve ap1-test",
          pid: 1,
        },
        { nombre: "x", estado: "rara" },
      ],
    }),
  );
  process.env.FAKE_TAREAS = file;
  try {
    const snap = await worker.request("flowrunner.tareas");
    assert.equal(snap.error, undefined);
    assert.deepEqual(
      snap.tareas.map((t) => [t.nombre, t.estado, t.siguiente]),
      [["orca-install", "falla", "flowrunner orca install --approve ap1-test"]],
    );
  } finally {
    delete process.env.FAKE_TAREAS;
    await worker.deactivate();
  }
});

/** Un worker con un proyecto enfocado en Orca, encontrado por su nombre y su rama. */
async function workerEnfocado() {
  const { worker, calls, repo } = await fakeWorker();
  await worker.deactivate();
  const enfocado = await mountWorker(main, {
    host: mockHost({
      settings: { comando: FAKE },
      results: {
        "workspace.readContext": { branch: "main", displayName: "acme", terminals: [] },
        "workspace.list": {
          workspaces: [
            {
              id: "a",
              kind: "worktree",
              name: "acme",
              path: repo,
              branch: "refs/heads/main",
              hostId: "local",
            },
          ],
          truncated: false,
        },
      },
    }),
  });
  return { worker: enfocado, calls, repo };
}

// Si regresiona, el panel audita otro proyecto que el enfocado, o lo que manda llega al shell sin
// validar.
test("auditar va con la ruta del proyecto enfocado; aplicar, solo con una auditoría y decisiones válidas", async () => {
  const { worker, calls, repo } = await workerEnfocado();
  try {
    const audit = await worker.request("flowrunner.mantener", {
      mantenimiento: { accion: "auditar" },
    });
    assert.deepEqual(audit, { ok: true, mensaje: "auditando el cerebro de acme" });
    const apply = await worker.request("flowrunner.mantener", {
      mantenimiento: {
        accion: "aplicar",
        auditoria: "acme/20261117-100000",
        decisiones: ["D1", "D3"],
      },
    });
    assert.equal(apply.ok, true);
    assert.match(apply.mensaje, /pull\/9/);
    const malos = [
      { accion: "aplicar" as const, auditoria: "../../etc", decisiones: ["D1"] },
      {
        accion: "aplicar" as const,
        auditoria: "acme/20261117-100000",
        decisiones: ["D1; rm -rf ~"],
      },
      { accion: "aplicar" as const, auditoria: "acme/20261117-100000", decisiones: [] },
    ];
    for (const mantenimiento of malos)
      assert.equal((await worker.request("flowrunner.mantener", { mantenimiento })).ok, false);
    assert.deepEqual(decided(calls()), [
      `brain audit ${repo} --fondo --json`,
      "brain apply acme/20261117-100000 --decision D1 --decision D3 --json",
    ]);
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, la sección del cerebro no muestra la última auditoría, o «Ver el informe» no la abre.
test("lee la última auditoría del proyecto enfocado y abre su informe como pestaña", async () => {
  const { worker, calls, repo } = await workerEnfocado();
  try {
    const snap = await worker.request("flowrunner.cerebro");
    assert.equal(snap.error, undefined);
    assert.equal(snap.proyecto, "acme");
    assert.equal(snap.auditoria?.ref, "acme/20261117-100000");
    assert.deepEqual(
      snap.auditoria?.decisiones.map((d) => [d.id, d.aplicable, d.pr]),
      [["D1", true, null]],
    );
    const opened = await worker.request("flowrunner.informeCerebro");
    assert.deepEqual(opened, { ok: true, mensaje: "abierto" });
    const file = join(repo, ".git", "flowrunner", "cerebro", "auditoria-20261117-100000.md");
    assert.match(readFileSync(file, "utf8"), /^# Auditoría del cerebro de acme/);
    assert.ok(calls().includes(`orca file open ${file} --worktree path:${repo} --focus`));
  } finally {
    await worker.deactivate();
  }
});

// Si regresiona, sin un proyecto enfocado el panel audita cualquier cosa o se queda mudo.
test("sin un proyecto enfocado, auditar y el cerebro dicen que hay que enfocar uno", async () => {
  const { worker, calls } = await fakeWorker();
  try {
    const audit = await worker.request("flowrunner.mantener", {
      mantenimiento: { accion: "auditar" },
    });
    assert.equal(audit.ok, false);
    assert.match(audit.mensaje, /enfocá un proyecto/);
    const snap = await worker.request("flowrunner.cerebro");
    assert.match(snap.error ?? "", /enfocá un proyecto/);
    assert.deepEqual(decided(calls()), []);
  } finally {
    await worker.deactivate();
  }
});
