// flowrunner watch --once: el árbol de un run real lanzado con las fases falsas, por id o por clave.
import { describe, expect, test } from "vitest";
import { runCli } from "./helpers/cli.ts";
import { launch, stateNow, waitFor, world } from "./helpers/runs.ts";

describe("watch --once", () => {
  // Si regresiona, la persona no tiene cómo ver en qué está un run lanzado.
  test("por la clave muestra el run más reciente con sus fases; sin runs activos lo dice", async () => {
    const w = world();
    expect(runCli(["watch", "--once"], w.env).stdout.trim()).toBe("no hay runs activos");
    const id = launch(w);
    await waitFor("entregado", () => stateNow(w, id).status === "entregado");
    const out = runCli(["watch", "SHOP-214", "--once"], w.env);
    expect(out.status).toBe(0);
    const lines = out.stdout.split("\n");
    expect(lines[0]).toMatch(/^○ 1 PR abierta {2}.*ID {2}.*TOKENS.*ESTADO$/);
    expect(lines).toContain("acme-api");
    expect(lines).toContainEqual(
      expect.stringMatching(/^ ○ Exportar pedidos a CSV +SHOP-214 .* PR abierta$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/├─ ✓ revisar .* listo$/));
    expect(lines).toContainEqual(expect.stringMatching(/└─ ○ aprender .* espera merge$/));
    expect(runCli(["watch", "--once"], w.env).stdout).toContain("Exportar pedidos a CSV");
  }, 120_000);

  test("un run que no existe sale 1 y dice cómo verlos", () => {
    const out = runCli(["watch", "NOPE-1", "--once"], world().env);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("no existe el run NOPE-1");
  });
});
