// Qué hace flowrunner cuando algo falla y reintentar a ciegas no lo arregla: reinstalar ante una señal
// de entorno, no gastar reintentos en una sub-task que no tiene nada que cambiar, y diagnosticar de qué
// lado está el problema. Con el CLI real, el SDK simulado y el gh falso.
import { describe, expect, test } from "vitest";
import type { Plan } from "../src/gates/plan.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { FEATURE } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { simWorld } from "./helpers/sim-world.ts";

const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});
const task = (id: string, dir: string) => ({
  id,
  titulo: id,
  descripcion: dir,
  alcance: [`src/${dir}/`],
  dependencias: [],
  depende_de: [],
});

async function run(opts: {
  plan: Plan;
  test: string;
  scripts: SimScript[];
  setup?: string;
  files?: Record<string, string>;
}) {
  const w = simWorld({
    real: ["preparar", "planificar", "aprobar", "implementar", "verificar", "revisar", "entregar"],
    scripts: [
      {
        match: "Sos el planificador",
        calls: [write("tests/ac1.mjs", opts.test)],
        output: opts.plan,
      },
      ...opts.scripts,
    ],
    feature: FEATURE,
    project: {
      files: { ".gitignore": ".setups\n", ...opts.files },
      config: { setup: opts.setup ?? "true", tests_globs: ["tests/**"] },
    },
  });
  const id = w.launch();
  await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
  runCli(["approve", id], w.env);
  await waitFor("fin", () => ["entregado", "detenido"].includes(w.state(id).status), 150_000);
  const events = readLog(w.dir(id)).events;
  const rounds = events.filter(
    (e) => e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve",
  );
  return { w, id, events, rounds };
}

const ONE: Plan = {
  plan: "# Plan\nUn QR.",
  subtareas: [task("ST-1", "qr")],
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [{ que: "a", por_que: "b" }],
};

/** AC-1 la cubre ST-1, pero lo que la rompe está en el archivo de ST-2. */
const TWO: Plan = {
  ...ONE,
  subtareas: [task("ST-1", "a"), task("ST-2", "b")],
};
const MISATTRIBUTED =
  'import { existsSync, readFileSync } from "node:fs";\nconst f = "src/b/b.js";\nprocess.exit(existsSync(f) && readFileSync(f, "utf8").includes("bien") ? 0 : 1);\n';
const twoUnits = (diagnosis: object): SimScript[] => [
  { match: "Sub-task ST-1", calls: [write("src/a/a.js", "export const a = 1;\n")] },
  { match: "Sub-task ST-2", calls: [write("src/b/b.js", "export const b = 'mal';\n")] },
  // Devuelta por verificar, ST-1 no encuentra nada que cambiar en su código.
  { match: "Sub-task ST-1", calls: [] },
  { match: "Sos el que diagnostica", output: diagnosis },
  { match: "Sub-task ST-2", calls: [write("src/b/b.js", "export const b = 'bien';\n")] },
  { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
];

describe("cuando algo falla y reintentar no alcanza", () => {
  // Si regresiona, una falla del entorno vuelve a una sub-task sana y gasta sus reintentos, como en PIZ-2.
  test("una señal de entorno en verificar reinstala y repite, sin devolver trabajo", async () => {
    const { w, id, rounds } = await run({
      plan: ONE,
      // Pasa solo si el setup corrió dos veces: la de preparar y la que hace verificar al ver la señal.
      test: 'import { existsSync, readFileSync } from "node:fs";\nconst n = existsSync(".setups") ? readFileSync(".setups", "utf8").split("\\n").filter(Boolean).length : 0;\nif (n < 2) { console.error("Error: Cannot find package \'jsqr\'"); process.exit(1); }\nprocess.exit(existsSync("src/qr/qr.js") ? 0 : 1);\n',
      setup: "echo x >> .setups",
      scripts: [
        { match: "Sub-task ST-1", calls: [write("src/qr/qr.js", "export const qr = 1;\n")] },
        { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
      ],
    });
    expect(w.state(id).halt?.motivo).toBeUndefined();
    expect(w.state(id).status).toBe("entregado");
    expect(rounds).toEqual([]);
    expect(w.prompts()).not.toContain("Sos el que diagnostica");
  }, 200_000);

  // Si regresiona, verificar culpa a la sub-task equivocada una y otra vez hasta detener el run.
  test("una sub-task devuelta sin nada que cambiar no reintenta, y el diagnóstico encuentra a la culpable", async () => {
    const { w, id, events } = await run({
      plan: TWO,
      test: MISATTRIBUTED,
      scripts: twoUnits({
        causa: "codigo",
        subtarea: "ST-2",
        instruccion: "src/b/b.js tiene que exportar 'bien'",
        explicacion: "AC-1 lee el archivo de ST-2, no el de ST-1",
      }),
    });
    expect(w.state(id).halt?.motivo).toBeUndefined();
    expect(w.state(id).status).toBe("entregado");
    const st1 = events.filter((e) => e.tipo === "unidad" && e.unidad === "ST-1");
    expect(st1.map((e) => (e.tipo === "unidad" ? e.estado : ""))).toEqual([
      "iniciada",
      "commiteada",
      "integrada",
      "iniciada",
      "sin_cambios",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        tipo: "decision",
        fase: "verificar",
        que: "diagnóstico: codigo en ST-2",
      }),
    );
    expect(w.prompts()).toContain("src/b/b.js tiene que exportar 'bien'");
  }, 200_000);

  // Si regresiona, flowrunner fuerza código para cumplir un criterio que está mal escrito.
  test("si el diagnóstico dice que el plan está mal, se detiene y dice cómo replanificar", async () => {
    const { w, id } = await run({
      plan: TWO,
      test: MISATTRIBUTED,
      scripts: twoUnits({
        causa: "plan",
        subtarea: "",
        instruccion: "",
        explicacion: "AC-1 está asignado a ST-1 pero mide el archivo de ST-2",
      }),
    });
    expect(w.state(id).status).toBe("detenido");
    expect(w.state(id).halt?.motivo).toContain(
      "AC-1 está asignado a ST-1 pero mide el archivo de ST-2",
    );
    expect(w.state(id).halt?.motivo).toContain(`flowrunner rerun ${id} --desde planificar`);
  }, 200_000);
});
