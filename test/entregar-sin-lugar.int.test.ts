// Entregar tiene su propio carril de un lugar (ADR 0031): el CLI real con fases falsas y max_runs 1.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { lugaresDir } from "../src/store/lugares.ts";
import { runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import { launchClave, stateNow, waitFor, world } from "./helpers/runs.ts";

const CONFIG = {
  ".flowrunner/config.yaml": 'setup: "true"\ntests_globs: [tests/**]\nmax_runs: 1\n',
};

// Si regresiona, aceptar un run que solo tiene que entregar lo manda a la cola detrás de runs que
// trabajan media hora (PIZ-14 esperó 12,7 minutos un entregar de segundos), o entregan sin tope.
test("entregar no espera a los que trabajan, entrega de a uno y la cola sigue mirando detrás del primero", async () => {
  const w = world({ FAKE_SIN_PROBAR: "1" }, CONFIG);
  const trabaja = join(tempDir(), "trabaja");
  const entrega = join(tempDir(), "entrega");
  const lanzados: string[] = [];
  // Al terminar, pase lo que pase: abortar los que siguen vivos y destrabar los semáforos.
  onTestFinished(() => {
    for (const id of lanzados) runCli(["abort", id], w.env);
    writeFileSync(trabaja, "");
    writeFileSync(entrega, "");
  });
  const a1 = launchClave(w, "SHOP-215");
  await waitFor("a1 detenido sin probar", () => stateNow(w, a1).sinProbar);
  const a2 = launchClave(w, "SHOP-216");
  await waitFor("a2 detenido sin probar", () => stateNow(w, a2).sinProbar);
  // b toma el único lugar de max_runs y se queda en preparar; c espera en cola, priorizado.
  const b = launchClave(w, "SHOP-217", { ...w.env, FAKE_SEMAFORO: trabaja });
  lanzados.push(b);
  await waitFor("b trabajando", () => stateNow(w, b).status === "en_curso");
  const c = launchClave(w, "SHOP-218", { ...w.env, FAKE_SEMAFORO: trabaja });
  lanzados.push(c);
  expect(stateNow(w, c).status).toBe("en_cola");
  expect(runCli(["prioritize", c], w.env).status).toBe(0);

  // a1 entra al carril de entrega aunque max_runs esté lleno, con su lugar escrito.
  const accept = (id: string, env = w.env) =>
    runCli(["accept-untested", id, "falta simular la falla", "--json"], env);
  expect(accept(a1, { ...w.env, FAKE_SEMAFORO: entrega }).status).toBe(0);
  expect(stateNow(w, a1)).toMatchObject({ status: "en_curso", fase: "entregar" });
  expect(existsSync(join(lugaresDir(w.home, "acme-api"), `${a1}.json`))).toBe(true);
  // El carril es de uno: a2 espera, primero en su carril aunque c esté antes en la cola.
  const queued = accept(a2);
  expect(queued.status).toBe(0);
  expect(queued.stdout).toMatch(/en cola, 1\.º/);
  expect(stateNow(w, a2).status).toBe("en_cola");
  // Pausar b libera un lugar normal: a a2, que espera el de entrega, no le sirve.
  const cruzado = runCli(["pause", b, "--para", a2, "--json"], w.env);
  expect(cruzado.status).toBe(1);
  expect(cruzado.stdout).toMatch(/pausarlo no le hace lugar/);

  // Cuando a1 entrega, la cola mira detrás de c, que no tiene lugar, y lanza a a2.
  writeFileSync(entrega, "");
  await waitFor("a1 y a2 entregados", () =>
    [a1, a2].every((id) => stateNow(w, id).status === "entregado"),
  );
  expect(stateNow(w, b)).toMatchObject({ status: "en_curso", fase: "preparar" });
  expect(stateNow(w, c).status).toBe("en_cola");
  expect(existsSync(join(lugaresDir(w.home, "acme-api"), `${a1}.json`))).toBe(false);
});
