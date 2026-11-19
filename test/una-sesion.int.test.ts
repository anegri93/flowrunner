// Gate de la Fase 4 de flowrunner 2.0 (ADR 0045): con `implementar: una_sesion`, el CLI real, las fases
// reales y el SDK simulado. El planificador devuelve una sola sub-task, implementar retoma su sesión
// desde el worktree de ST-1, la sub-task corre el verify del repo sin rechazo, verificar pasa y
// `stats --runs` cuenta el run como una_sesion.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

// Si regresiona, alguna pieza del experimento no encaja con las otras: planificar borra la sesión, la
// sub-task arranca de cero, el verify se le rechaza, o stats mezcla los modos.
test("una_sesion: ST-1 retoma la sesión del planificador, corre el verify y stats lo cuenta aparte", async () => {
  const w = simWorld({
    real: ["preparar", "planificar", "aprobar", "implementar", "verificar"],
    scripts: [
      { match: "Sos el planificador", calls: [WRITE_TEST], output: PLAN },
      {
        match: "Ahora implementás vos el plan que escribiste",
        calls: [
          {
            tool: "Write",
            input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
          },
          { tool: "Bash", input: { command: "./.flowrunner/verify.sh" } },
        ],
      },
    ],
    feature: FEATURE,
    project: {
      config: {
        setup: "true",
        tests_globs: ["tests/**"],
        aprobar: "si_hace_falta",
        implementar: "una_sesion",
      },
    },
  });
  const id = w.launch();
  await waitFor(
    "verificado",
    () =>
      readLog(w.dir(id)).events.some(
        (e) => e.tipo === "accion_terminada" && e.fase === "verificar",
      ) || w.state(id).status === "detenido",
    120_000,
  );
  expect(w.state(id).halt?.motivo).toBeUndefined();

  const events = readLog(w.dir(id)).events;
  expect(existsSync(join(w.dir(id), "implementar-sesion.json"))).toBe(true);
  // El único prompt de implementar es el de la sesión retomada.
  expect(w.prompts()).toContain("Ahora implementás vos el plan que escribiste");
  expect(events.filter((e) => e.tipo === "rechazo")).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      tipo: "accion_terminada",
      fase: "verificar",
      resultado: { tipo: "ok" },
    }),
  );
  const marca = JSON.parse(readFileSync(join(w.dir(id), "implementar-sesion.json"), "utf8")) as {
    nombre: string;
  };
  expect(marca.nombre).toMatch(/^planificar/);

  const stats = JSON.parse(runCli(["stats", "--runs", "acme-api", "--json"], w.env).stdout) as {
    runs: { modo: string; aprobo: string }[];
  };
  expect(stats.runs).toEqual([
    expect.objectContaining({ modo: "una_sesion", aprobo: "flowrunner" }),
  ]);
});
