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
    expect(events.filter((e) => e.tipo === "accion_iniciada")).toHaveLength(7);
    expect(events.filter((e) => e.tipo === "accion_terminada")).toHaveLength(7);
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
