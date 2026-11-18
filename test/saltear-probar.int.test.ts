// Saltear probar a pedido (ADR 0036): el CLI real con fases falsas.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import { executions, launch, runDir, stateNow, waitFor, world } from "./helpers/runs.ts";

const events = (w: { home: string }, id: string) =>
  readFileSync(join(runDir(w, id), "events.jsonl"), "utf8");

describe("skip-probar", () => {
  // Si regresiona, la persona no puede evitar que probar levante el entorno, o se saltea sin motivo.
  test("antes de probar, con motivo, el run entrega sin correr probar; sin motivo sale 1", async () => {
    const semaforo = join(tempDir(), "sigue");
    const w = world({ FAKE_SEMAFORO: semaforo });
    const id = launch(w);
    await waitFor("el run en preparar", () => stateNow(w, id).fase === "preparar");

    const sinMotivo = runCli(["skip-probar", id], w.env);
    expect(sinMotivo.status).toBe(1);
    expect(sinMotivo.stderr).toMatch(/falta el motivo/);

    const marcado = runCli(["skip-probar", id, "solo", "toca", "docs"], w.env);
    expect(marcado.status).toBe(0);
    expect(marcado.stdout).toMatch(/probar se va a saltear/);
    expect(stateNow(w, id).probarSalteado).toBe("solo toca docs");

    writeFileSync(semaforo, "");
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id)).not.toContain("probar");
    expect(executions(w, id)).toContain("entregar");
    expect(events(w, id)).toContain('"salteada":"la salteó la persona: solo toca docs"');
  });

  // Si regresiona, deshacer no vuelve a probar, o la marca se borra sin que la persona lo pida.
  test("--deshacer vuelve a probar; sin marca sale 1", async () => {
    const semaforo = join(tempDir(), "sigue");
    const w = world({ FAKE_SEMAFORO: semaforo });
    const id = launch(w);
    await waitFor("el run en preparar", () => stateNow(w, id).fase === "preparar");
    expect(runCli(["skip-probar", id, "--deshacer"], w.env).stderr).toMatch(/no está marcado/);
    expect(runCli(["skip-probar", id, "sin entorno"], w.env).status).toBe(0);
    const deshecho = runCli(["skip-probar", id, "--deshacer"], w.env);
    expect(deshecho.status).toBe(0);
    expect(stateNow(w, id).probarSalteado).toBeUndefined();
    writeFileSync(semaforo, "");
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id)).toContain("probar");
  });

  // Si regresiona, el CLI dice que lo salteó cuando probar ya corrió, y la PR miente.
  test("con probar ya hecho sale 1 con la fase; detenido por criterios sin probar deriva a accept-untested", async () => {
    const w = world();
    const id = launch(w);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    const tarde = runCli(["skip-probar", id, "x"], w.env);
    expect(tarde.status).toBe(1);
    expect(tarde.stderr).toMatch(/probar ya arrancó o pasó/);
    expect(events(w, id)).not.toContain("probar_salteado");

    const w2 = world({ FAKE_SIN_PROBAR: "1" });
    const id2 = launch(w2);
    await waitFor("el run detenido", () => stateNow(w2, id2).status === "detenido");
    const detenido = runCli(["skip-probar", id2, "x"], w2.env);
    expect(detenido.status).toBe(1);
    expect(detenido.stderr).toMatch(/accept-untested/);
  });
});
