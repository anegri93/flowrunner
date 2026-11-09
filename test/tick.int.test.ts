// T7.1: flowrunner tick y learn: runs pausados y el estado de las PRs entregadas.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendEvent, readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { delivered } from "./helpers/delivered.ts";
import { executions, launch, runDir, stateNow, waitFor, world } from "./helpers/runs.ts";

describe("tick", () => {
  // Si regresiona, un run pausado por el límite de la suscripción queda parado para siempre.
  test("un run pausado cuyo límite ya pasó se retoma", async () => {
    const w = world();
    const id = launch(w);
    await waitFor("entregado", () => stateNow(w, id).status === "entregado");
    const dir = runDir(w, id);
    appendEvent(dir, { tipo: "rehacer", desde: "revisar" });
    appendEvent(dir, { tipo: "accion_iniciada", fase: "revisar" });
    appendEvent(dir, {
      tipo: "accion_terminada",
      fase: "revisar",
      resultado: { tipo: "limite", hasta: Date.now() - 1000 },
    });
    expect(stateNow(w, id).status).toBe("pausado_por_limite");
    const out = runCli(["tick", "--json"], w.env);
    expect(JSON.parse(out.stdout)).toMatchObject({
      acciones: [`${id}: retomado después del límite`],
    });
    await waitFor("entregado otra vez", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id).slice(-2)).toEqual(["revisar", "entregar"]);
  });

  test("PR abierta: sin cambios; PR cerrada sin merge: cerrado sin ninguna sesión", async () => {
    const d = await delivered();
    const promptsBefore = d.prompts();
    expect(runCli(["tick"], d.env).stdout).toContain(`${d.id}: la PR sigue abierta`);
    expect(d.state(d.id).status).toBe("entregado");
    d.setPr(412, (pr) => (pr.state = "CLOSED"));
    runCli(["tick"], d.env);
    expect(d.state(d.id).status).toBe("cerrado");
    expect(readLog(d.dir(d.id)).events.findLast((e) => e.tipo === "pr_cerrada")).toMatchObject({
      mergeada: false,
    });
    expect(d.prompts()).toBe(promptsBefore);
  }, 180_000);

  // Si regresiona, flowrunner gasta una sesión aprendiendo de un merge sin correcciones.
  test("PR mergeada sin correcciones de la persona: cerrado sin sesión de agente", async () => {
    const d = await delivered();
    const promptsBefore = d.prompts();
    d.setPr(412, (pr) => (pr.state = "MERGED"));
    expect(runCli(["learn", d.id], d.env).stdout).toContain("quedó cerrado");
    expect(d.prompts()).toBe(promptsBefore);
  }, 180_000);

  // Regresión: el cierre después del merge lo hace el chequeo, que no escribía el informe, y VF-4 quedó
  // con el de la entrega. Además, `learn` no aceptaba la clave del run: «no existe el run VF-4».
  test("learn con la clave cierra el run y escribe el informe final", async () => {
    const d = await delivered();
    d.setPr(412, (pr) => (pr.state = "MERGED"));
    const out = runCli(["learn", "SHOP-214"], d.env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("quedó cerrado");
    expect(readFileSync(join(runDir(d, d.id), "informe.md"), "utf8")).toContain(
      "**Estado:** cerrado",
    );
  }, 180_000);

  test("dos ticks a la vez: el segundo sale sin hacer nada; learn sobre un run ocupado no lo pisa", async () => {
    const d = await delivered();
    writeFileSync(join(d.home, "tick.lock"), String(process.pid));
    expect(JSON.parse(runCli(["tick", "--json"], d.env).stdout)).toEqual({
      ok: true,
      acciones: ["otro tick está corriendo"],
    });
    writeFileSync(join(d.dir(d.id), "aprender.lock"), String(process.pid));
    expect(runCli(["learn", d.id], d.env).stdout).toContain(
      "otro proceso ya está aprendiendo de este run",
    );
  }, 180_000);

  test("learn sobre un run que no está entregado sale 1", () => {
    const w = world({ FAKE_DELAY_MS: "3000" });
    const id = launch(w);
    const result = runCli(["learn", id], w.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/solo se aprende de un run entregado/);
    runCli(["abort", id], w.env);
  });
});
