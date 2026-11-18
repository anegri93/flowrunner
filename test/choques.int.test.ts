// La base avanzó y choca con la PR abierta (ADR 0041): el CLI real, las fases reales y el SDK
// simulado. Aprender ve el choque, una sesión lo resuelve con un merge, el run vuelve a verificar y
// entrega en la misma PR.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { BRANCH, delivered, type Delivered } from "./helpers/delivered.ts";
import { git, tempDir } from "./helpers/git.ts";
import { waitFor } from "./helpers/runs.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";

/** Suma guiones para las sesiones que vienen, después de los que ya usó la entrega. */
function addScripts(d: Delivered, scripts: SimScript[]): void {
  const file = d.env.FAKE_SIM_SCRIPTS ?? "";
  const current = JSON.parse(readFileSync(file, "utf8")) as SimScript[];
  writeFileSync(file, JSON.stringify([...current.slice(0, 3), ...scripts]));
}

/** Otra PR, ya mergeada en main, escribe distinto el archivo que escribió la feature. */
function mergeOtraPr(d: Delivered): string {
  const clone = join(tempDir(), "c");
  execFileSync("git", ["clone", "-q", "-b", "main", d.remote, clone]);
  mkdirSync(join(clone, "src", "export"), { recursive: true });
  writeFileSync(join(clone, "src", "export", "csv.js"), "export const csv = 0;\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "feat: otra PR");
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

// Si regresiona, la PR queda en GitHub sin poder mergearse hasta que resolvés el choque a mano.
test("con la PR abierta, un choque con la base se resuelve con un merge, pasa por verificar y se entrega en la misma PR", async () => {
  const d = await delivered();
  const enMain = mergeOtraPr(d);
  addScripts(d, [
    {
      match: "Sos el que resuelve los choques",
      calls: [
        {
          tool: "Write",
          input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
        },
      ],
    },
    { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
  ]);
  const pushes = () => readLog(d.dir(d.id)).events.filter((e) => e.tipo === "pr").length;
  expect(pushes()).toBe(1);

  const learned = runCli(["learn", d.id], d.env);
  expect(learned.stdout).toContain("volvió a trabajar");
  await waitFor(
    "entregado otra vez",
    () =>
      d.state(d.id).status === "detenido" ||
      (d.state(d.id).status === "entregado" && pushes() === 2),
    120_000,
  );
  expect(d.state(d.id).halt?.motivo).toBeUndefined();
  expect(d.state(d.id)).toMatchObject({ status: "entregado", fase: "aprender" });
  const fases = readLog(d.dir(d.id))
    .events.filter((e) => e.tipo === "accion_iniciada")
    .map((e) => e.fase);
  expect(fases.slice(fases.lastIndexOf("aprender"))).toEqual([
    "aprender",
    "verificar",
    "revisar",
    "probar",
    "entregar",
  ]);
  // status dice por qué volvió a trabajar, sin atribuírselo a un feedback que no diste.
  const status = JSON.parse(runCli(["status", d.id, "--json"], d.env).stdout) as {
    pasos: { fase: string; resultado: string | null; motivo: string | null }[];
  };
  expect(status.pasos.find((p) => p.resultado === "reentrar")).toMatchObject({
    fase: "aprender",
    motivo: expect.stringMatching(
      /^vuelve a verificar: la rama choca con main en src\/export\/csv\.js/,
    ) as unknown,
  });
  expect(git(d.remote, "merge-base", "--is-ancestor", enMain, BRANCH)).toBe("");
  expect(git(d.remote, "show", `${BRANCH}:src/export/csv.js`)).toBe("export const csv = 1;");
  expect(d.ghLog().filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(1);
}, 300_000);
