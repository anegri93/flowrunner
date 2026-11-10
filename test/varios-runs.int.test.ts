// ADR 0019: varios runs por repo, con tope, cola y turnos. El CLI real con fases falsas.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runStartedSchema } from "../src/cli/contracts.ts";
import { isAlive } from "../src/store/lock.ts";
import { lugaresDir } from "../src/store/lugares.ts";
import { readLog } from "../src/store/run-log.ts";
import { BIN, homeWith, runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import { makeProject } from "./helpers/project.ts";
import {
  executions,
  FAKE_PHASES,
  FEATURE,
  lockPid,
  runDir,
  stateNow,
  waitFor,
  world,
  type World,
} from "./helpers/runs.ts";

const CONFIG = (extra = "") => ({
  ".flowrunner/config.yaml": `setup: "true"\ntests_globs: [tests/**]\n${extra}`,
});

/** Otra feature del mismo proyecto: otra clave, otra rama. */
function feature(w: Pick<World, "feature">, clave: string): string {
  const file = join(tempDir(), `${clave}.md`);
  writeFileSync(file, FEATURE.replace("SHOP-214", clave));
  return file;
}

function launchFile(w: World, file: string) {
  const result = runCli(["run", file, "--json"], w.env);
  if (result.status !== 0) throw new Error(`run falló: ${result.stdout}${result.stderr}`);
  return runStartedSchema.parse(JSON.parse(result.stdout));
}

/** El CLI sin esperar a que termine: para lanzar varios a la vez de verdad. */
function runCliAsync(args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, ...args], {
      env,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (status) => {
      resolve({ status, stdout });
    });
  });
}

const slotCount = (w: Pick<World, "home">) => {
  const dir = lugaresDir(w.home, "acme-api");
  return existsSync(dir) ? readdirSync(dir).filter((e) => e.endsWith(".json")).length : 0;
};

const notices = (w: World) => {
  const file = join(w.env.HOME ?? "", "avisos.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const tipos = (w: Pick<World, "home">, id: string) =>
  readLog(runDir(w, id)).events.map((e) => e.tipo);

describe("varios runs por repo", () => {
  // Antes del ADR 0019 el segundo `run` salía 1: el plan del primero trababa el repo.
  test("dos runs del mismo repo llegan los dos a esperar tu aprobación", async () => {
    const w = world({ FAKE_ESPERA_APROBAR: "1" });
    const a = launchFile(w, w.feature).id;
    const b = launchFile(w, feature(w, "SHOP-215")).id;
    await waitFor("los dos esperando", () =>
      [a, b].every((id) => stateNow(w, id).status === "esperando_aprobacion"),
    );
  });

  // Si regresiona, vuelve el problema de fondo: un plan que espera traba el repo sin gastar nada.
  test("con max_runs 1, un run que espera aprobación no le ocupa el lugar a otro", async () => {
    const w = world({ FAKE_ESPERA_APROBAR: "1" }, CONFIG("max_runs: 1\n"));
    const a = launchFile(w, w.feature).id;
    await waitFor("a esperando", () => stateNow(w, a).status === "esperando_aprobacion");
    await waitFor("a sin lugar", () => lockPid(w, a) === undefined);
    const b = launchFile(w, feature(w, "SHOP-215"));
    expect(b.cola).toBeUndefined();
    await waitFor("b esperando", () => stateNow(w, b.id).status === "esperando_aprobacion");
  });

  // Si regresiona, el run que no entra se pierde (antes salía 1) o arranca pasándose del tope.
  test("con max_runs 1 el segundo queda en cola y arranca solo cuando el primero se entrega", async () => {
    const semaforo = join(tempDir(), "siga");
    const w = world({ FAKE_SEMAFORO: semaforo }, CONFIG("max_runs: 1\n"));
    const a = launchFile(w, w.feature).id;
    const b = launchFile(w, feature(w, "SHOP-215"));
    expect(b.cola).toEqual({ posicion: 1, corriendo: [a] });
    expect(b.accion).toMatch(/en cola, 1\.º: corren /);
    expect(stateNow(w, b.id).status).toBe("en_cola");
    expect(executions(w, b.id)).toEqual([]);
    writeFileSync(semaforo, "");
    await waitFor("a entregado", () => stateNow(w, a).status === "entregado");
    await waitFor("b entregado", () => stateNow(w, b.id).status === "entregado");
    expect(tipos(w, b.id).slice(0, 3)).toEqual(["run_creado", "encolado", "reanudado"]);
    expect(executions(w, b.id)[0]).toBe("preparar");
    // Salir de la cola pasa sin que lo pidas: avisa. Lanzar y quedar en cola lo hiciste vos: no.
    await waitFor("el aviso de a", () => notices(w).includes("SHOP-214: PR abierta"));
    await waitFor("el aviso de b", () => notices(w).includes("SHOP-215: PR abierta"));
    const avisos = notices(w);
    expect(avisos).toContain("SHOP-215: salió de la cola y arrancó en preparar");
    expect(avisos).not.toContain("en cola, esperando un lugar");
    expect(avisos).not.toContain("SHOP-214: salió de la cola");
  });

  // Si regresiona, dos comandos que llegan juntos cuentan el mismo lugar libre y entran los dos.
  test("tres run lanzados a la vez con max_runs 1: uno corre, los otros esperan, nunca hay dos lugares", async () => {
    // Ninguna fase termina hasta abrir el semáforo: los tres CLI coinciden con el primero corriendo.
    const semaforo = join(tempDir(), "siga");
    const w = world({ FAKE_SEMAFORO: semaforo }, CONFIG("max_runs: 1\n"));
    const files = [w.feature, feature(w, "SHOP-215"), feature(w, "SHOP-216")];
    let maxSlots = 0;
    const watching = { on: true };
    const watcher = (async () => {
      while (watching.on) {
        maxSlots = Math.max(maxSlots, slotCount(w));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const results = await Promise.all(files.map((f) => runCliAsync(["run", f, "--json"], w.env)));
    const started = results.map((r) => runStartedSchema.parse(JSON.parse(r.stdout)));
    expect(
      started.filter((s) => s.cola === undefined),
      results.map((r) => r.stdout).join("\n"),
    ).toHaveLength(1);
    expect(started.filter((s) => s.cola !== undefined)).toHaveLength(2);
    writeFileSync(semaforo, "");
    await waitFor(
      "los tres entregados",
      () => started.every((s) => stateNow(w, s.id).status === "entregado"),
      90_000,
    );
    watching.on = false;
    await watcher;
    expect(maxSlots).toBe(1);
  }, 120_000);

  // Si regresiona, un proceso que murió sin despachar la cola (kill -9, corte de luz) la deja trabada.
  test("tick despacha la cola cuando el proceso que tenía que hacerlo murió", async () => {
    const w = world({ FAKE_SEMAFORO: join(tempDir(), "nunca") }, CONFIG("max_runs: 1\n"));
    const a = launchFile(w, w.feature).id;
    const pid = await waitFor("el proceso de a", () => {
      const p = lockPid(w, a);
      return p !== undefined && p !== 0 && isAlive(p) && executions(w, a).length > 0
        ? p
        : undefined;
    });
    const b = launchFile(w, feature(w, "SHOP-215")).id;
    expect(stateNow(w, b).status).toBe("en_cola");
    process.kill(pid, "SIGKILL");
    await waitFor("a muerto", () => !isAlive(pid));
    expect(stateNow(w, b).status).toBe("en_cola");
    const tick = runCli(["tick", "--json"], w.env);
    expect(tick.status, tick.stderr).toBe(0);
    expect(tick.stdout).toContain(`${b}: salió de la cola`);
    await waitFor("b corriendo", () => executions(w, b).length > 0);
    runCli(["abort", b], w.env);
  });

  test("abortar un run en cola lo saca de la cola sin lanzarlo", async () => {
    const semaforo = join(tempDir(), "siga");
    const w = world({ FAKE_SEMAFORO: semaforo }, CONFIG("max_runs: 1\n"));
    const a = launchFile(w, w.feature).id;
    const b = launchFile(w, feature(w, "SHOP-215")).id;
    expect(stateNow(w, b).status).toBe("en_cola");
    expect(runCli(["abort", b], w.env).status).toBe(0);
    expect(stateNow(w, b).status).toBe("abortado");
    writeFileSync(semaforo, "");
    await waitFor("a entregado", () => stateNow(w, a).status === "entregado");
    expect(executions(w, b)).toEqual([]);
  });

  // Si regresiona, dos runs de la misma clave trabajan en la misma rama y se pisan los commits.
  test("un segundo run de la misma clave se niega y nombra el run vivo", () => {
    const w = world({ FAKE_DELAY_MS: "2000" });
    const a = launchFile(w, w.feature).id;
    const second = runCli(["run", w.feature], w.env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(`ya hay un run de SHOP-214 en acme-api: ${a}`);
    runCli(["abort", a], w.env);
  });
});

describe("el turno del entorno", () => {
  // Si regresiona, dos verify del mismo repo corren juntos sobre los mismos puertos y la misma base.
  test("dos preparar reales de runs distintos nunca corren verify a la vez", async () => {
    const marks = tempDir("flowrunner-marcas-");
    mkdirSync(marks, { recursive: true });
    const verify = [
      `if ! mkdir "${marks}/dentro" 2>/dev/null; then echo solape >> "${marks}/solapes"; exit 0; fi`,
      "sleep 1",
      `rmdir "${marks}/dentro"`,
      `echo fin >> "${marks}/fines"`,
    ].join("\n");
    const { work } = makeProject({ verify });
    const env: NodeJS.ProcessEnv = {
      ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
      FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
      FAKE_KEEP_REAL: "preparar",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    };
    const w: World = {
      repo: work,
      env,
      home: join(env.HOME ?? "", ".flowrunner"),
      feature: join(tempDir(), "SHOP-214.md"),
    };
    writeFileSync(w.feature, FEATURE);
    const ids = [launchFile(w, w.feature).id, launchFile(w, feature(w, "SHOP-215")).id];
    await waitFor(
      "los dos entregados",
      () => ids.every((id) => stateNow(w, id).status === "entregado"),
      60_000,
    );
    expect(readFileSync(join(marks, "fines"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(join(marks, "solapes"))).toBe(false);
  });
});
