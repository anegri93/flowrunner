// flowrunner watch --once: el árbol de un run real lanzado con las fases falsas, por id o por clave.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadTree } from "../src/watch/load.ts";
import { runCli } from "./helpers/cli.ts";
import { newRun } from "./helpers/project.ts";
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
      expect.stringMatching(/^ ○ Exportar pedidos a CSV ▾ +SHOP-214 .* PR abierta$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/├─ ✓ \d\d:\d\d revisar .* listo$/));
    expect(lines).toContainEqual(expect.stringMatching(/└─ ○ aprender .* espera merge$/));
    expect(runCli(["watch", "--once"], w.env).stdout).toContain("Exportar pedidos a CSV");
  }, 120_000);

  // Si regresiona, el panel de Orca, que lee esta salida, se queda sin runs o no los cruza con su repo.
  test("--json devuelve el árbol de los runs activos, con el repo; --cerrados suma los cerrados", async () => {
    const w = world();
    const empty = JSON.parse(runCli(["watch", "--json"], w.env).stdout) as { runs: unknown[] };
    expect(empty).toEqual({ ok: true, runs: [] });
    const id = launch(w);
    await waitFor("entregado", () => stateNow(w, id).status === "entregado");
    const out = runCli(["watch", "--json"], w.env);
    expect(out.status).toBe(0);
    const { runs } = JSON.parse(out.stdout) as {
      runs: {
        id: string;
        clave: string;
        repo: string;
        fases: { fase: string; estado: string }[];
      }[];
    };
    expect(runs.map((r) => [r.id, r.clave])).toEqual([[id, "SHOP-214"]]);
    expect(runs[0]?.repo).toMatch(/\//);
    expect(runs[0]?.fases.find((f) => f.fase === "revisar")?.estado).toBe("ok");

    // Abortado deja de estar entre los activos; con --cerrados vuelve, para el panel de Orca.
    expect(runCli(["abort", id], w.env).status).toBe(0);
    const active = JSON.parse(runCli(["watch", "--json"], w.env).stdout) as { runs: unknown[] };
    expect(active.runs).toEqual([]);
    const all = JSON.parse(runCli(["watch", "--json", "--cerrados"], w.env).stdout) as {
      runs: { id: string; status: string }[];
    };
    expect(all.runs.map((r) => [r.id, r.status])).toEqual([[id, "abortado"]]);
  }, 120_000);

  test("un run que no existe sale 1 y dice cómo verlos", () => {
    const out = runCli(["watch", "NOPE-1", "--once"], world().env);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("no existe el run NOPE-1");
  });
});

describe("watch y los cambios a lo existente", () => {
  // Si regresiona, el panel de Orca aprueba sin mostrar lo que el plan cambia de lo que ya existe, y
  // flowrunner le rechaza la aprobación sin que la persona sepa por qué.
  test("cada run trae lo que su plan declaró que cambia de lo existente; un archivo roto se lee vacío", () => {
    const run = newRun("/r/acme");
    expect(loadTree(run.home, run.id, Date.now()).cambiaLoExistente).toEqual([]);
    const cambio = {
      que: "el alta rechaza correos de otro dominio; después los acepta sin cuenta",
      donde: "apps/api/src/usuarios/usuarios.service.ts:42",
      criterio: "AC-1",
    };
    writeFileSync(join(run.dir, "cambios-existentes.json"), JSON.stringify([cambio]));
    expect(loadTree(run.home, run.id, Date.now()).cambiaLoExistente).toEqual([cambio]);
    writeFileSync(join(run.dir, "cambios-existentes.json"), "[{");
    expect(loadTree(run.home, run.id, Date.now()).cambiaLoExistente).toEqual([]);
  });
});
