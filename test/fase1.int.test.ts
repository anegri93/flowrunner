// Gate de la Fase 1: un run real, cortado con kill -9 en tres puntos y retomado cada vez, deja el
// mismo log que un run sin cortes.
import { describe, expect, test } from "vitest";
import type { RunEvent } from "../src/store/events.ts";
import { isAlive } from "../src/store/lock.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import {
  executions,
  launch,
  lockPid,
  runDir,
  stateNow,
  waitFor,
  world,
  type World,
} from "./helpers/runs.ts";

/** El log sin lo que agrega retomar: los `reanudado`, las acciones cortadas y los tiempos. */
function normalized(events: readonly RunEvent[]): unknown[] {
  const kept: RunEvent[] = [];
  for (const [i, event] of events.entries()) {
    if (event.tipo === "reanudado") continue;
    if (event.tipo === "accion_iniciada") {
      const next = events
        .slice(i + 1)
        .find((e) => e.tipo === "accion_iniciada" || e.tipo === "accion_terminada");
      if (next?.tipo !== "accion_terminada") continue;
    }
    kept.push(event);
  }
  return kept.map(({ at: _at, ...rest }) =>
    rest.tipo === "run_creado" ? { ...rest, run_id: "-", repo: "-" } : rest,
  );
}

async function killDuring(w: World, id: string, fase: string): Promise<void> {
  await waitFor(`el run en ${fase}`, () => executions(w, id).at(-1) === fase);
  const pid = await waitFor("el pid del run", () => lockPid(w));
  process.kill(pid, "SIGKILL");
  await waitFor("el proceso muerto", () => !isAlive(pid));
  expect(stateNow(w, id).status).toBe("en_curso");
  const resumed = runCli(["resume", id], w.env);
  expect(resumed.status, resumed.stderr).toBe(0);
}

describe("Fase 1 ensamblada", () => {
  // Si regresiona, un corte de luz o un reinicio de la Mac en medio de un run repite o pierde trabajo.
  test("tres kill -9 y tres resume llegan a entregado con el mismo log que un run sin cortes", async () => {
    const clean = world({ FAKE_DELAY_MS: "50" });
    const cleanId = launch(clean);
    await waitFor("el run limpio entregado", () => stateNow(clean, cleanId).status === "entregado");

    const w = world({ FAKE_DELAY_MS: "1500" });
    const id = launch(w);
    await killDuring(w, id, "planificar");
    await killDuring(w, id, "implementar");
    await killDuring(w, id, "revisar");
    await waitFor("el run cortado entregado", () => stateNow(w, id).status === "entregado", 60_000);

    const cut = readLog(runDir(w, id)).events;
    expect(cut.filter((e) => e.tipo === "reanudado")).toHaveLength(3);
    expect(normalized(cut)).toEqual(normalized(readLog(runDir(clean, cleanId)).events));
    // Las tres fases cortadas corrieron dos veces; el resto, una.
    expect(executions(w, id)).toEqual([
      "preparar",
      "planificar",
      "planificar",
      "aprobar",
      "implementar",
      "implementar",
      "verificar",
      "revisar",
      "revisar",
      "probar",
      "entregar",
    ]);
  }, 120_000);
});
