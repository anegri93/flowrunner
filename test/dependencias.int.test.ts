// Una sub-task que suma una dependencia: verificar tiene que correr con ella instalada en la
// integración. Regresión de PIZ-2, donde verificar corrió con los node_modules de la base. "Instalar"
// acá es copiar el manifiesto deps.txt a .instalado.
import { describe, expect, test } from "vitest";
import type { Plan } from "../src/gates/plan.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { FEATURE } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import { simWorld } from "./helpers/sim-world.ts";

const PLAN: Plan = {
  plan: "# Plan\nUn QR con una dependencia nueva.",
  subtareas: [
    {
      id: "ST-1",
      titulo: "QR",
      descripcion: "suma jsqr y src/qr.js",
      alcance: ["src/"],
      dependencias: ["jsqr"],
      depende_de: [],
    },
  ],
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [{ que: "jsqr", por_que: "decodifica QR" }],
};
const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});

describe("dependencias nuevas en la integración", () => {
  // Si regresiona, una feature que suma una dependencia se detiene en verificar aunque su código esté bien.
  test("si la feature cambia un manifiesto, verificar reinstala antes de correr los criterios", async () => {
    const w = simWorld({
      real: [
        "preparar",
        "planificar",
        "aprobar",
        "implementar",
        "verificar",
        "revisar",
        "entregar",
      ],
      scripts: [
        {
          match: "Sos el planificador",
          calls: [
            write(
              "tests/ac1.mjs",
              'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync(".instalado", "utf8").includes("jsqr") ? 0 : 1);\n',
            ),
          ],
          output: PLAN,
        },
        {
          match: "Sub-task ST-1",
          calls: [write("deps.txt", "jsqr\n"), write("src/qr.js", "export const qr = 1;\n")],
        },
        { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
      ],
      feature: FEATURE,
      project: {
        files: { "deps.txt": "", ".gitignore": ".instalado\n" },
        config: {
          setup: "cp deps.txt .instalado",
          tests_globs: ["tests/**"],
          manifests: ["deps.txt"],
        },
      },
    });
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    runCli(["approve", id], w.env);
    await waitFor("fin", () => ["entregado", "detenido"].includes(w.state(id).status), 120_000);
    expect(w.state(id).halt?.motivo).toBeUndefined();
    expect(w.state(id).status).toBe("entregado");
    const rounds = readLog(w.dir(id)).events.filter(
      (e) => e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve",
    );
    expect(rounds).toEqual([]);
  }, 180_000);

  // Si regresiona, un setup que falla al reinstalar se disfraza de código rojo y gasta reintentos.
  test("si reinstalar falla, se detiene como entorno con el motivo y sin vueltas", async () => {
    const w = simWorld({
      real: ["preparar", "planificar", "aprobar", "implementar", "verificar"],
      scripts: [
        {
          match: "Sos el planificador",
          calls: [
            write(
              "tests/ac1.mjs",
              'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync(".instalado", "utf8").includes("jsqr") ? 0 : 1);\n',
            ),
          ],
          output: PLAN,
        },
        {
          match: "Sub-task ST-1",
          calls: [write("deps.txt", "jsqr roto\n"), write("src/qr.js", "export const qr = 1;\n")],
        },
      ],
      feature: FEATURE,
      project: {
        files: { "deps.txt": "", ".gitignore": ".instalado\n" },
        config: {
          setup: "cp deps.txt .instalado && ! grep -q roto deps.txt",
          tests_globs: ["tests/**"],
          manifests: ["deps.txt"],
        },
      },
    });
    const id = w.launch();
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    runCli(["approve", id], w.env);
    await waitFor("detenido", () => w.state(id).status === "detenido", 120_000);
    expect(w.state(id).halt?.motivo).toMatch(
      /la feature cambió deps\.txt y el setup .* salió 1 al reinstalar/,
    );
    const rounds = readLog(w.dir(id)).events.filter(
      (e) => e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve",
    );
    expect(rounds).toEqual([]);
  }, 180_000);
});
