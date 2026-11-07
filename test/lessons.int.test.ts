// T7.3: al mergear, las correcciones de la persona se vuelven lecciones con su PR y auto-merge.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { delivered, type Delivered } from "./helpers/delivered.ts";
import { git } from "./helpers/git.ts";

/** Agrega guiones para las sesiones que vienen, ya con los orígenes reales de las correcciones. */
function addScripts(d: Delivered, scripts: SimScript[]): void {
  const file = d.env.FAKE_SIM_SCRIPTS ?? "";
  const current = JSON.parse(readFileSync(file, "utf8")) as SimScript[];
  writeFileSync(file, JSON.stringify([...current.slice(0, 3), ...scripts]));
}

const lessonsOnBase = (d: Delivered) =>
  git(d.remote, "show", "chore/lecciones-SHOP-214:.flowrunner/lecciones.md");

describe("lecciones", () => {
  // Si regresiona, lo que corregiste a mano no llega nunca al cerebro del repo.
  test("dos lecciones con su origen, una PR de lecciones con auto-merge y el run cerrado", async () => {
    const d = await delivered();
    const oid = d.pushCorrection("yo", "src/export/csv.js", "export const csv = 2;\n");
    const origin = `https://github.com/acme/acme-api/pull/412/commits/${oid}`;
    addScripts(d, [
      {
        output: {
          lecciones: [
            {
              titulo: "Los valores de export son constantes",
              regla: "Usar const.",
              origen: origin,
            },
            { titulo: "Un cambio por commit", regla: "No mezclar.", origen: origin },
          ],
        },
      },
    ]);
    d.setPr(412, (pr) => (pr.state = "MERGED"));
    expect(runCli(["learn", d.id], d.env).stdout).toContain("quedó cerrado");
    const lessons = lessonsOnBase(d);
    expect(lessons).toMatch(
      /### L-1 · Los valores de export son constantes\n\nRegla: Usar const\.\n\nOrigen: https:\/\/github\.com\/acme\/acme-api\/pull\/412\/commits\//,
    );
    expect(lessons).toContain("### L-2 · Un cambio por commit");
    const merges = d.ghLog().filter((a) => a[1] === "merge");
    expect(merges).toEqual([["pr", "merge", "413", "--auto", "--merge"]]);
    expect(readLog(d.dir(d.id)).events.findLast((e) => e.tipo === "lecciones")).toMatchObject({
      cantidad: 2,
      auto_merge: true,
    });
  }, 240_000);

  test("una lección sin un origen de la persona es falla de gate y no abre PR", async () => {
    const d = await delivered();
    d.pushCorrection("yo", "src/export/csv.js", "export const csv = 2;\n");
    addScripts(d, [
      { output: { lecciones: [{ titulo: "x", regla: "y", origen: "https://inventado" }] } },
    ]);
    d.setPr(412, (pr) => (pr.state = "MERGED"));
    runCli(["learn", d.id], d.env);
    const last = readLog(d.dir(d.id)).events.findLast((e) => e.tipo === "accion_terminada");
    expect(last?.tipo === "accion_terminada" && last.resultado).toMatchObject({
      tipo: "falla",
      clase: "gate",
    });
    expect(d.ghLog().filter((a) => a[1] === "create")).toHaveLength(1);
  }, 240_000);

  // Si regresiona, una consolidación que pierde lecciones entra sola a la base.
  test("si lecciones.md pasa su tope, se consolida y la PR se abre sin auto-merge, con aviso", async () => {
    const big = `# Lecciones\n\n${"x".repeat(11_950)}\n`;
    const d = await delivered([], { files: { ".flowrunner/lecciones.md": big } });
    const oid = d.pushCorrection("yo", "src/export/csv.js", "export const csv = 2;\n");
    addScripts(d, [
      {
        output: {
          lecciones: [
            {
              titulo: "Nueva",
              regla: "Regla nueva.",
              origen: `https://github.com/acme/acme-api/pull/412/commits/${oid}`,
            },
          ],
        },
      },
      { output: { lecciones_md: "# Lecciones\n\n### L-1 · Consolidada\n\nRegla: todo junto.\n" } },
    ]);
    d.setPr(412, (pr) => (pr.state = "MERGED"));
    runCli(["learn", d.id], d.env);
    expect(lessonsOnBase(d)).toBe("# Lecciones\n\n### L-1 · Consolidada\n\nRegla: todo junto.");
    expect(d.ghLog().some((a) => a[1] === "merge")).toBe(false);
    expect(d.notices()).toContain(
      "SHOP-214: la PR de lecciones necesita tu revisión: se consolidó lecciones.md.",
    );
  }, 240_000);
});
