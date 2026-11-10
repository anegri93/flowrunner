// Las lecciones que deja un run: lo que le costó corregirse solo llega como propuesta, en un commit
// aparte de la PR de entrega. Con el CLI real, el SDK simulado y el gh falso.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { BRANCH, delivered } from "./helpers/delivered.ts";
import { git } from "./helpers/git.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./helpers/plan-fixtures.ts";
import { waitFor } from "./helpers/runs.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { simWorld } from "./helpers/sim-world.ts";

const WRITE_CSV = {
  tool: "Write",
  input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
};
const WITH_HEADER = {
  tool: "Write",
  input: {
    file_path: "src/export/csv.js",
    content: 'export const header = "id";\nexport const csv = 1;\n',
  },
};
const BLOCKER = {
  severidad: "bloqueante",
  archivo: "src/export/csv.js",
  linea: 1,
  afirmacion: "el CSV sale sin encabezado",
  regla: "todo CSV lleva encabezado",
  subtarea: "ST-1",
};

/** Un run cuya revisión devuelve ST-1 una vez, con el guion que propone las lecciones. */
async function withRound(proposal: SimScript) {
  const w = simWorld({
    real: ["preparar", "planificar", "aprobar", "implementar", "verificar", "revisar", "entregar"],
    scripts: [
      { match: "Sos el planificador", calls: [WRITE_TEST], output: PLAN },
      { match: "Sub-task ST-1", calls: [WRITE_CSV] },
      { match: "Sos el revisor", output: { hallazgos: [BLOCKER], decisiones: [] } },
      { match: "Sub-task ST-1", calls: [WITH_HEADER] },
      { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
      proposal,
    ],
    feature: FEATURE,
    // Un repo que pide vueltas automáticas: sin ellas, la vuelta de revisar es una pregunta (ADR 0023).
    project: { config: { setup: "true", tests_globs: ["tests/**"], vueltas: 2 } },
  });
  const id = w.launch();
  await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
  runCli(["approve", id], w.env);
  await waitFor("entregado", () => ["entregado", "detenido"].includes(w.state(id).status), 120_000);
  expect(w.state(id).halt?.motivo).toBeUndefined();
  const gh = JSON.parse(readFileSync(join(w.env.HOME ?? "", "gh-state.json"), "utf8")) as {
    prs: { body: string }[];
  };
  return { w, id, body: gh.prs[0]?.body ?? "" };
}

const PROPOSER = "Sos el que aprende de lo que le costó a un run";

describe("lecciones propuestas en la PR de entrega", () => {
  // Si regresiona, lo que el run tuvo que corregir solo se pierde y el próximo run tropieza igual.
  test("una vuelta de revisar deja su lección en un commit aparte de la PR, citando el run", async () => {
    const { w, id, body } = await withRound({
      match: PROPOSER,
      output: {
        lecciones: [
          {
            titulo: "Los CSV llevan encabezado",
            regla: "Escribir la fila de encabezado primero.",
            origen: "revisar, vuelta 1",
          },
        ],
      },
    });
    expect(w.prompts()).toContain("el CSV sale sin encabezado");
    const subjects = git(w.remote, "log", "--format=%s", `main..${BRANCH}`).split("\n");
    expect(subjects[0]).toBe("docs(lecciones): lo que aprendió SHOP-214");
    expect(git(w.remote, "show", "--name-only", "--format=", BRANCH)).toBe(
      ".flowrunner/lecciones.md",
    );
    expect(git(w.remote, "log", "-1", "--format=%b", BRANCH)).toContain(`Flowrunner-Run: ${id}`);
    const lessons = git(w.remote, "show", `${BRANCH}:.flowrunner/lecciones.md`);
    expect(lessons).toContain("### L-1 · Los CSV llevan encabezado");
    expect(lessons).toContain(`Origen: run ${id} · revisar, vuelta 1 ·`);
    expect(body).toContain("## Lo que aprendió este run");
    expect(body).toContain("Los CSV llevan encabezado");
    expect(body).toContain("borrala de `.flowrunner/lecciones.md`");
  }, 240_000);

  // Si regresiona, un modelo mete en el cerebro una lección que no sale de nada de lo que pasó.
  test("una lección con un origen inventado no entra, y la PR se entrega igual con un aviso", async () => {
    const { w, id, body } = await withRound({
      match: PROPOSER,
      output: { lecciones: [{ titulo: "x", regla: "y", origen: "revisar, vuelta 9" }] },
    });
    const subjects = git(w.remote, "log", "--format=%s", `main..${BRANCH}`).split("\n");
    expect(subjects).not.toContain("docs(lecciones): lo que aprendió SHOP-214");
    const warnings = readLog(w.dir(id)).events.flatMap((e) =>
      e.tipo === "aviso" ? [e.texto] : [],
    );
    expect(warnings.some((t) => t.includes("revisar, vuelta 9"))).toBe(true);
    expect(body).toContain("## Lo que aprendió este run");
  }, 240_000);

  // Si regresiona, flowrunner gasta una sesión buscando lecciones en un run que salió derecho.
  test("sin vueltas ni cambios al plan, no hay sesión ni commit, y la PR lo dice", async () => {
    const d = await delivered();
    expect(d.prompts()).not.toContain(PROPOSER);
    expect(git(d.remote, "log", "--format=%s", `main..${BRANCH}`)).not.toContain("docs(lecciones)");
    expect(d.ghState().prs[0]?.body).toContain("no hubo vueltas ni cambios al plan");
  }, 180_000);
});
