// Entregar no espera un lugar (ADR 0031): el CLI real con fases falsas y max_runs 1.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runStartedSchema } from "../src/cli/contracts.ts";
import { runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import { FEATURE, stateNow, waitFor, world, type World } from "./helpers/runs.ts";

const CONFIG = {
  ".flowrunner/config.yaml": 'setup: "true"\ntests_globs: [tests/**]\nmax_runs: 1\n',
};

function launch(w: World, clave: string, env: NodeJS.ProcessEnv = w.env): string {
  const file = join(tempDir(), `${clave}.md`);
  writeFileSync(file, FEATURE.replace("SHOP-214", clave));
  const result = runCli(["run", file, "--json"], env);
  if (result.status !== 0) throw new Error(`run falló: ${result.stdout}${result.stderr}`);
  return runStartedSchema.parse(JSON.parse(result.stdout)).id;
}

// Si regresiona, aceptar un run que solo tiene que entregar lo manda a la cola detrás de runs que
// trabajan media hora: PIZ-14 esperó 12,7 minutos para un entregar de 6 segundos.
test("con el único lugar ocupado, aceptar un run detenido en probar lo entrega sin esperar", async () => {
  const w = world({ FAKE_SIN_PROBAR: "1" }, CONFIG);
  const a = launch(w, "SHOP-215");
  await waitFor("a detenido sin probar", () => stateNow(w, a).sinProbar);
  // Otro run toma el único lugar y se queda trabajando en preparar.
  const semaforo = join(tempDir(), "siga");
  const b = launch(w, "SHOP-216", { ...w.env, FAKE_SEMAFORO: semaforo });
  await waitFor("b trabajando", () => stateNow(w, b).status === "en_curso");

  const accepted = runCli(["accept-untested", a, "falta simular la falla", "--json"], w.env);
  expect(accepted.status, accepted.stdout).toBe(0);
  await waitFor("a entregado", () => stateNow(w, a).status === "entregado");
  expect(stateNow(w, b)).toMatchObject({ status: "en_curso", fase: "preparar" });
  writeFileSync(semaforo, "");
});
