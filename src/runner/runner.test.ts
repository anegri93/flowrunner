import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PHASES, type Outcome, type Phase } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { runUntilStop } from "./runner.ts";
import type { Deps, PhaseFn, PhaseRegistry, RunPaths } from "./types.ts";

function newRun(): RunPaths {
  const dir = mkdtempSync(join(tmpdir(), "fr-runner-"));
  appendEvent(dir, {
    tipo: "run_creado",
    run_id: "R1",
    clave: "SHOP-1",
    proyecto: "acme",
    repo: "/r",
    budget_usd: 25,
    reintentos_red: 3,
  });
  return { id: "R1", home: dir, dir, worktrees: join(dir, "wt") };
}

const notified: string[] = [];
const deps: Deps = {
  now: () => new Date("2026-11-07T10:00:00Z"),
  sleep: () => Promise.resolve(),
  notify: (title) => notified.push(title),
  query: () => {
    throw new Error("sin modelo en este test");
  },
  deleteSession: () => Promise.resolve(),
  registro: () => Promise.reject(new Error("sin registro en este test")),
  env: {},
};

/** Fases falsas que dejan una línea en `ejecuciones.txt` cada vez que corren. */
function recordingPhases(run: RunPaths, answers: Partial<Record<Phase, Outcome[]>> = {}) {
  const counts = new Map<Phase, number>();
  const make =
    (fase: Phase): PhaseFn =>
    () => {
      appendFileSync(join(run.dir, "ejecuciones.txt"), `${fase}\n`);
      const n = counts.get(fase) ?? 0;
      counts.set(fase, n + 1);
      return Promise.resolve(answers[fase]?.[n] ?? { tipo: "ok" });
    };
  return Object.fromEntries(PHASES.map((f) => [f, make(f)])) as PhaseRegistry;
}

const executions = (run: RunPaths) =>
  readFileSync(join(run.dir, "ejecuciones.txt"), "utf8").trim().split("\n");

describe("runUntilStop", () => {
  // Si regresiona, un run completo repite fases o deja acciones sin cerrar en su log.
  test("un run completo deja exactamente una ejecución y un par de eventos por acción", async () => {
    const run = newRun();
    const state = await runUntilStop(run, recordingPhases(run), deps);
    expect(state.status).toBe("entregado");
    expect(executions(run)).toEqual(PHASES.filter((p) => p !== "aprender"));
    const { events } = readLog(run.dir);
    expect(events.filter((e) => e.tipo === "accion_iniciada")).toHaveLength(8);
    expect(events.filter((e) => e.tipo === "accion_terminada")).toHaveLength(8);
  });

  // Si regresiona, un corte en medio de una fase deja su trabajo a medias para siempre.
  test("un corte entre iniciada y terminada rehace esa acción y solo esa", async () => {
    const run = newRun();
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "preparar" });
    appendEvent(run.dir, { tipo: "accion_terminada", fase: "preparar", resultado: { tipo: "ok" } });
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
    await runUntilStop(run, recordingPhases(run), deps);
    expect(executions(run)[0]).toBe("planificar");
    expect(executions(run).filter((f) => f === "preparar")).toEqual([]);
    const iniciadas = readLog(run.dir).events.filter(
      (e) => e.tipo === "accion_iniciada" && e.fase === "planificar",
    );
    expect(iniciadas).toHaveLength(1);
  });

  test("un corte después de terminada no repite la acción", async () => {
    const run = newRun();
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "preparar" });
    appendEvent(run.dir, { tipo: "accion_terminada", fase: "preparar", resultado: { tipo: "ok" } });
    await runUntilStop(run, recordingPhases(run), deps);
    expect(executions(run)).not.toContain("preparar");
  });

  // Si regresiona, un bug de flowrunner se cuenta como fallo del modelo y gasta sus intentos.
  test("una excepción de la fase queda como falla de infraestructura, no de gate", async () => {
    const run = newRun();
    const phases = recordingPhases(run);
    phases.preparar = () => Promise.reject(new Error("se rompió algo"));
    const state = await runUntilStop(run, phases, deps);
    const fallas = readLog(run.dir).events.flatMap((e) =>
      e.tipo === "accion_terminada" && e.resultado.tipo === "falla" ? [e.resultado] : [],
    );
    expect(fallas.map((f) => f.clase)).toEqual(["infra", "infra", "infra"]);
    expect(state.status).toBe("detenido");
    expect(notified).toContain("SHOP-1: el run se detuvo");
  });

  // Si regresiona, un corte de red de unos minutos vuelve a matar el run en 25 segundos (primer VF-6).
  test("el runner espera 30 s, 2 min y 5 min entre reintentos de red", async () => {
    const run = newRun();
    const cut: Outcome = {
      tipo: "falla",
      clase: "infra",
      motivo: "git fetch --quiet origin falló: fatal: Could not resolve host: github.com",
    };
    const phases = recordingPhases(run, { preparar: [cut, cut, cut, cut] });
    const waits: number[] = [];
    const state = await runUntilStop(run, phases, {
      ...deps,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([30_000, 120_000, 300_000]);
    expect(state.status).toBe("detenido");
  });

  // Si regresiona, el run ya detenido espera el backoff antes de soltar su lugar y avisar.
  test("una falla de infraestructura que no es de red espera 5 s y 20 s, y no espera al detenerse", async () => {
    const run = newRun();
    const fail: Outcome = {
      tipo: "falla",
      clase: "infra",
      motivo: "la sesión terminó sin resultado",
    };
    const phases = recordingPhases(run, { preparar: [fail, fail, fail] });
    const waits: number[] = [];
    const state = await runUntilStop(run, phases, {
      ...deps,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([5_000, 20_000]);
    expect(state.status).toBe("detenido");
  });

  // Regresión T1.3b: implementar busca su entrada en el log; con eventos viejos tomaba la anterior.
  test("la fase recibe el log con su propia accion_iniciada al final", async () => {
    const run = newRun();
    const phases = recordingPhases(run);
    let lastSeen: unknown;
    phases.preparar = (ctx) => {
      lastSeen = ctx.events.at(-1);
      return Promise.resolve({ tipo: "falla", clase: "entorno", motivo: "corte" });
    };
    await runUntilStop(run, phases, deps);
    expect(lastSeen).toMatchObject({ tipo: "accion_iniciada", fase: "preparar" });
  });

  // Si regresiona, un tick con la PR todavía abierta queda girando para siempre.
  test("en un tick, aprender corre una sola vez aunque la PR siga abierta", async () => {
    const run = newRun();
    const phases = recordingPhases(run, { aprender: [{ tipo: "espera" }, { tipo: "espera" }] });
    await runUntilStop(run, phases, deps);
    const state = await runUntilStop(run, phases, deps, { tick: true });
    expect(state.status).toBe("entregado");
    expect(executions(run).filter((f) => f === "aprender")).toEqual(["aprender"]);
  });

  test("aprobar que espera termina el loop sin proceso esperando", async () => {
    const run = newRun();
    const state = await runUntilStop(
      run,
      recordingPhases(run, { aprobar: [{ tipo: "espera" }] }),
      deps,
    );
    expect(state.status).toBe("esperando_aprobacion");
    expect(executions(run).at(-1)).toBe("aprobar");
  });
});

describe("Autofix solo (ADR 0028)", () => {
  /** Un run con 0 vueltas, como los de ahora: el primer rojo con sub-tasks ya es una detención. */
  function zeroRounds(): RunPaths {
    const dir = mkdtempSync(join(tmpdir(), "fr-runner-"));
    appendEvent(dir, {
      tipo: "run_creado",
      run_id: "R1",
      clave: "SHOP-1",
      proyecto: "acme",
      repo: "/r",
      vueltas: 0,
    });
    return { id: "R1", home: dir, dir, worktrees: join(dir, "wt") };
  }
  const red: Outcome = { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-1 sigue en rojo" };

  /** Lo que hace el Autofix de verdad, sin herramientas: escribir el evento, y contar las veces. */
  function autofixer(run: RunPaths) {
    const calls: number[] = [];
    const autofixSolo = () => {
      calls.push(1);
      appendEvent(run.dir, { tipo: "autofix", origen: "flowrunner", sha: null });
      return Promise.resolve();
    };
    return { calls, autofixSolo };
  }

  // Si regresiona, la persona tiene que apretar Autofix en cada detención (PIZ-3), o flowrunner lo
  // repite solo vuelta tras vuelta.
  test("en una detención con sub-tasks lo corre una vez; si sigue en rojo, se detiene y avisa una vez", async () => {
    const run = zeroRounds();
    const phases = recordingPhases(run, { verificar: [red, red, red] });
    const { calls, autofixSolo } = autofixer(run);
    notified.length = 0;
    const state = await runUntilStop(run, phases, deps, { autofixSolo });
    expect(calls).toHaveLength(1);
    expect(state.status).toBe("detenido");
    expect(state.halt?.opciones.map((o) => o.comando)).toContain("flowrunner fix R1 --auto");
    // Autofix vuelve a verificar; el rojo siguiente lo corrige ST-2 sola; el tercero pregunta.
    expect(executions(run).filter((f) => f === "verificar")).toHaveLength(3);
    expect(executions(run).filter((f) => f === "implementar")).toHaveLength(2);
    expect(notified).toEqual(["SHOP-1: el run se detuvo"]);
  });

  // Si regresiona, un Autofix que se niega (cambios sin commitear) deja el run girando o sin decir por qué.
  test("si se niega, se detiene como antes, con el motivo en un aviso", async () => {
    const run = zeroRounds();
    const phases = recordingPhases(run, { verificar: [red] });
    let calls = 0;
    const state = await runUntilStop(run, phases, deps, {
      autofixSolo: () => {
        calls++;
        return Promise.reject(new Error("el worktree /w tiene cambios sin commitear"));
      },
    });
    expect(calls).toBe(1);
    expect(state.status).toBe("detenido");
    expect(executions(run).filter((f) => f === "verificar")).toHaveLength(1);
    expect(readLog(run.dir).events).toContainEqual(
      expect.objectContaining({
        tipo: "aviso",
        fase: "verificar",
        texto: "Autofix no corrió solo: el worktree /w tiene cambios sin commitear",
      }),
    );
  });

  // Si regresiona, flowrunner corre Autofix donde la persona no lo podría elegir, o en un run que ya
  // te esperaba antes de que este proceso arrancara.
  test("no corre en una detención sin Autofix ni en una que el proceso no causó", async () => {
    const run = zeroRounds();
    const { calls, autofixSolo } = autofixer(run);
    const porEntorno = recordingPhases(run, {
      verificar: [{ tipo: "falla", clase: "entorno", motivo: "falta jsqr" }],
    });
    expect((await runUntilStop(run, porEntorno, deps, { autofixSolo })).status).toBe("detenido");
    expect(calls).toHaveLength(0);

    const waiting = zeroRounds();
    const other = autofixer(waiting);
    await runUntilStop(waiting, recordingPhases(waiting, { verificar: [red] }), deps);
    expect(other.calls).toHaveLength(0);
    const again = await runUntilStop(waiting, recordingPhases(waiting), deps, {
      autofixSolo: other.autofixSolo,
    });
    expect(again.status).toBe("detenido");
    expect(other.calls).toHaveLength(0);
  });
});
