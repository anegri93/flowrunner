// Tu feedback sobre una PR abierta que no querés mergear (ADR 0038): el CLI real, las fases reales y el
// SDK simulado. Aprender lo evalúa, el run vuelve a trabajar y entrega en la misma PR.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { BRANCH, delivered, type Delivered } from "./helpers/delivered.ts";
import { git } from "./helpers/git.ts";
import { waitFor, world } from "./helpers/runs.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";

/** Suma guiones para las sesiones que vienen, después de los que ya usó la entrega. */
function addScripts(d: Delivered, scripts: SimScript[]): void {
  const file = d.env.FAKE_SIM_SCRIPTS ?? "";
  const current = JSON.parse(readFileSync(file, "utf8")) as SimScript[];
  writeFileSync(file, JSON.stringify([...current.slice(0, 3), ...scripts]));
}

const FEEDBACK = "el CSV tiene que separar con punto y coma";

// Si regresiona, a la persona solo le queda mergear algo que no quiere o abortar y empezar de cero; o
// el run rehecho abre otra PR, pisa lo que la persona empujó a la rama, o deja la descripción vieja.
test("el feedback rehace la sub-task que eligió aprender y actualiza la misma PR, con lo que empujaste", async () => {
  const d = await delivered();
  const tuyo = d.pushCorrection("yo", "NOTAS.md", "lo empujé yo\n");
  addScripts(d, [
    {
      match: "Sos el que evalúa el feedback",
      output: {
        desde: "implementar",
        unidades: ["ST-1"],
        instruccion: "ST-1: en src/export/csv.js, exportá el separador ;",
        por_que: "el separador lo escribe ST-1 y el plan sirve",
      },
    },
    {
      match: "Sos un implementador",
      calls: [
        {
          tool: "Write",
          input: { file_path: "src/export/csv.js", content: 'export const separador = ";";\n' },
        },
      ],
    },
    { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
    { match: "Sos el que aprende de lo que le costó", output: { lecciones: [], sugerencias: [] } },
  ]);

  const sent = runCli(["feedback", d.id, FEEDBACK, "--origen", "orca", "--json"], d.env);
  expect(sent.status, sent.stdout + sent.stderr).toBe(0);
  expect(sent.stdout).toContain("evaluando desde dónde rehacer");
  await waitFor(
    "entregado otra vez",
    () => {
      const events = readLog(d.dir(d.id)).events;
      const after = events.slice(events.findIndex((e) => e.tipo === "feedback_pedido"));
      return d.state(d.id).status === "detenido"
        ? true
        : d.state(d.id).status === "entregado" && after.some((e) => e.tipo === "pr");
    },
    120_000,
  );
  expect(d.state(d.id).halt?.motivo).toBeUndefined();
  expect(d.state(d.id)).toMatchObject({ status: "entregado", fase: "aprender" });

  const events = readLog(d.dir(d.id)).events;
  expect(events).toContainEqual(
    expect.objectContaining({
      tipo: "decision",
      fase: "aprender",
      que: "tu feedback: rehacer ST-1 desde implementar",
    }),
  );
  // status dice la decisión, que es lo que la skill le cuenta a la persona.
  const status = JSON.parse(runCli(["status", d.id, "--json"], d.env).stdout) as {
    pasos: { fase: string; resultado: string | null; motivo: string | null }[];
  };
  expect(status.pasos.find((p) => p.resultado === "reentrar")).toMatchObject({
    fase: "aprender",
    motivo:
      "con tu feedback, desde implementar (ST-1): el separador lo escribe ST-1 y el plan sirve",
  });
  // La sub-task recibió tu feedback y la instrucción de la evaluación.
  const implementar = d
    .prompts()
    .split("\n---\n")
    .findLast((p) => p.startsWith("Sos un implementador"));
  expect(implementar).toContain(FEEDBACK);
  expect(implementar).toContain("exportá el separador ;");
  // La misma PR: ninguna nueva, la descripción reescrita, y la rama con tu commit y el arreglo.
  expect(d.ghLog().filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(1);
  expect(d.ghLog()).toContainEqual(expect.arrayContaining(["pr", "edit", "412"]));
  expect(d.ghState().prs.find((p) => p.number === 412)?.body).toContain("Feedback");
  expect(git(d.remote, "show", `${BRANCH}:src/export/csv.js`)).toBe(
    'export const separador = ";";',
  );
  expect(git(d.remote, "merge-base", "--is-ancestor", tuyo, BRANCH)).toBe("");
}, 300_000);

// Si regresiona, el feedback pisa un run que todavía trabaja, que tiene sus propias respuestas.
test("el feedback es solo para un run con la PR abierta, y pide el texto", () => {
  const w = world({ FAKE_ESPERA_APROBAR: "1" });
  const launched = runCli(["run", w.feature, "--json"], w.env);
  const id = (JSON.parse(launched.stdout) as { id: string }).id;
  const vacio = runCli(["feedback", id, "--json"], w.env);
  expect(vacio.status).toBe(1);
  expect(vacio.stdout).toContain("falta el feedback");
  const temprano = runCli(["feedback", id, FEEDBACK, "--json"], w.env);
  expect(temprano.status).toBe(1);
  expect(temprano.stdout).toContain("el feedback es para un run con la PR abierta");
  runCli(["abort", id], w.env);
});
