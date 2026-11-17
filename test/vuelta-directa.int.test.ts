// Un bloqueante de revisar vuelve directo a su sub-task (ADR 0030): el CLI real con fases falsas.
import { expect, test } from "vitest";
import { runStartedSchema } from "../src/cli/contracts.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { executions, runDir, stateNow, waitFor, world } from "./helpers/runs.ts";

// Si regresiona, un bloqueante de la revisión vuelve a pasar por Autofix y por otra revisión del mismo
// código antes de llegar a la sub-task, y un bloqueante real puede desaparecer sin arreglarse (PIZ-9).
test("un bloqueante de revisar vuelve a implementar sin detenerse ni correr Autofix, y el run entrega", async () => {
  const w = world({ FAKE_REVISAR_VUELVE: "ST-1" });
  const started = runCli(["run", w.feature, "--json"], w.env);
  expect(started.status, started.stderr).toBe(0);
  const id = runStartedSchema.parse(JSON.parse(started.stdout)).id;
  await waitFor("entregado", () => stateNow(w, id).status === "entregado");
  expect(executions(w, id)).toEqual([
    "preparar",
    "planificar",
    "aprobar",
    "implementar",
    "verificar",
    "revisar",
    "implementar",
    "verificar",
    "revisar",
    "probar",
    "entregar",
  ]);
  const events = readLog(runDir(w, id)).events;
  expect(events.some((e) => e.tipo === "autofix")).toBe(false);
  expect(events.find((e) => e.tipo === "run_creado")).toMatchObject({ vuelta_directa: true });
});
