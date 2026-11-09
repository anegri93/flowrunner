// T1.4: el CLI real lanza, consulta, retoma, rehace y aborta runs con fases falsas.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { statusRunSchema } from "../src/cli/contracts.ts";
import { isAlive } from "../src/store/lock.ts";
import { runCli } from "./helpers/cli.ts";
import { executions, launch, lockPid, runDir, stateNow, waitFor, world } from "./helpers/runs.ts";

describe("CLI de runs", () => {
  test("run sobre una feature inválida sale 1 sin crear el directorio del run", () => {
    const w = world();
    writeFileSync(w.feature, "sin frontmatter\n");
    const result = runCli(["run", w.feature], w.env);
    expect(result.status).toBe(1);
    expect(existsSync(join(w.home, "runs"))).toBe(false);
  });

  // Si regresiona, cerrar la terminal o la sesión de Claude Code mata el run.
  test("run devuelve un id y el proceso del run sigue vivo después de que el CLI terminó", async () => {
    const w = world({ FAKE_DELAY_MS: "400" });
    const id = launch(w);
    expect(id).toMatch(/^SHOP-214-\d{8}-\d{6}$/);
    const pid = await waitFor("el pid del proceso del run", () => {
      const p = lockPid(w);
      return p !== undefined && isAlive(p) ? p : undefined;
    });
    expect(isAlive(pid)).toBe(true);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id)).toEqual([
      "preparar",
      "planificar",
      "aprobar",
      "implementar",
      "verificar",
      "revisar",
      "probar",
      "entregar",
    ]);
  });

  // Si regresiona, editar la feature después de lanzar cambia en silencio un run que ya corre.
  test("editar el archivo original después de run no cambia la copia del run", () => {
    const w = world({ FAKE_DELAY_MS: "200" });
    const id = launch(w);
    writeFileSync(w.feature, "otra cosa\n");
    expect(readFileSync(join(runDir(w, id), "feature.md"), "utf8")).toContain(
      "Exportar pedidos a CSV",
    );
  });

  test("resume sobre un run entregado sale 1 con el motivo", async () => {
    const w = world();
    const id = launch(w);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    const result = runCli(["resume", id], w.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/está entregado: no hay nada que retomar/);
  });

  test("rerun --desde con una fase que no existe sale 1 y lista las fases", async () => {
    const w = world();
    const id = launch(w);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    const result = runCli(["rerun", id, "--desde", "inventada"], w.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/preparar, planificar, aprobar/);
  });

  // Si regresiona, abortar deja un proceso gastando suscripción en segundo plano.
  test("abort sobre un run en curso termina su proceso y lo deja abortado", async () => {
    const w = world({ FAKE_DELAY_MS: "3000" });
    const id = launch(w);
    const pid = await waitFor("el proceso del run", () => {
      const p = lockPid(w);
      return p !== undefined && isAlive(p) && executions(w, id).length > 0 ? p : undefined;
    });
    expect(runCli(["abort", id], w.env).status).toBe(0);
    // La fase falsa tarda 3 s: si el proceso muere antes, lo mató el abort y no el fin de la fase.
    await waitFor("el proceso terminado", () => !isAlive(pid), 1_500);
    expect(stateNow(w, id).status).toBe("abortado");
    expect(executions(w, id)).toEqual(["preparar"]);
  });

  test("un segundo run sobre el mismo repo se niega y nombra el run que tiene el lock", async () => {
    const w = world({ FAKE_DELAY_MS: "2000" });
    const first = launch(w);
    await waitFor("el lock del primero", () => lockPid(w));
    const second = runCli(["run", w.feature], w.env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(first);
    runCli(["abort", first], w.env);
  });

  // Si regresiona, la skill de consola lee una forma distinta a la que documenta el contrato.
  test("status --json valida contra su schema, y un error con --json también es JSON", async () => {
    const w = world();
    const id = launch(w);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    const status = runCli(["status", id, "--json"], w.env);
    expect(statusRunSchema.safeParse(JSON.parse(status.stdout)).success).toBe(true);
    // Si regresiona, el panel de Orca no sabe en qué repo abrir los archivos de un run ya cerrado, y
    // los comandos no aceptan la clave que muestra el panel: «no existe el run VF-4».
    const byKey = JSON.parse(runCli(["status", "SHOP-214", "--json"], w.env).stdout) as {
      run: { id: string; repo: string };
    };
    expect(byKey.run).toMatchObject({ id, repo: w.repo });
    expect(runCli(["report", "SHOP-214", "--json"], w.env).status).toBe(0);
    const missing = runCli(["status", "NO-1", "--json"], w.env);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      ok: false,
      error: { message: "no existe el run NO-1" },
    });
  });
});
