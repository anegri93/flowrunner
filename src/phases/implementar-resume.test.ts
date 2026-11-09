// T5.3: retomar implementar después de un corte con sub-tasks en tres estados distintos.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps, writeFiles } from "../../test/helpers/project.ts";
import { simQuery } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import { addWorktree, cherryPick, commitAll, headSha } from "../git/git.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { implementar } from "./implementar.ts";
import { unitWorktree } from "./inputs.ts";

const plan: Plan = {
  plan: "plan",
  subtareas: ["ST-1", "ST-2", "ST-3"].map((id, i) => ({
    id,
    titulo: id,
    descripcion: id,
    alcance: [`src/m${i + 1}/`],
    dependencias: [],
    depende_de: [],
  })),
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

describe("retomar implementar", () => {
  // Si regresiona, retomar repite sesiones ya pagadas o integra trabajo a medio hacer.
  test("la integrada no se toca, la commiteada se integra sin sesión y la cortada se rehace limpia", async () => {
    const sim = simQuery([
      {
        calls: [
          {
            tool: "Write",
            input: { file_path: "src/m3/tres.js", content: "export const t = 3;\n" },
          },
        ],
      },
    ]);
    const deps = testDeps({ query: sim.query });
    const { run, featureWt, work } = await plannedRun(
      plan,
      { "tests/ac1.mjs": "process.exit(1);\n" },
      deps,
    );
    const tip = await headSha(featureWt, deps.env);
    const unit = async (id: string, file: string) => {
      const wt = unitWorktree(run, id);
      await addWorktree(work, wt, `feat/SHOP-214/${id}`, tip, deps.env);
      writeFiles(wt, { [file]: `// ${id}\n` });
      return {
        wt,
        sha: (await commitAll(wt, `feat: ${id}`, { "Flowrunner-Subtask": id }, deps.env)) ?? "",
      };
    };
    // ST-1: integrada antes del corte.
    const one = await unit("ST-1", "src/m1/uno.js");
    const picked = await cherryPick(featureWt, one.sha, deps.env);
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "iniciada",
      sha: tip,
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "commiteada",
      sha: one.sha,
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "integrada",
      sha: picked.ok ? picked.sha : "",
    });
    // ST-2: commiteada en su rama, sin integrar.
    const two = await unit("ST-2", "src/m2/dos.js");
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-2",
      estado: "iniciada",
      sha: tip,
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-2",
      estado: "commiteada",
      sha: two.sha,
    });
    // ST-3: cortada a mitad de su sesión, con un archivo a medio escribir fuera de lugar.
    const threeWt = unitWorktree(run, "ST-3");
    await addWorktree(work, threeWt, "feat/SHOP-214/ST-3", tip, deps.env);
    writeFiles(threeWt, { "src/m3/tres.js": "export const t = ", "basura.tmp": "a medias" });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-3",
      estado: "iniciada",
      sha: tip,
    });

    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(sim.records).toHaveLength(1);
    expect(sim.records[0]?.prompt).toContain("Sub-task ST-3");
    const subjects = git(featureWt, "log", "--format=%s", "-3").split("\n");
    expect(subjects).toEqual(["feat: ST-3 · ST-3", "feat: ST-2", "feat: ST-1"]);
    expect(readFileSync(join(featureWt, "src/m3/tres.js"), "utf8")).toBe("export const t = 3;\n");
    expect(existsSync(join(featureWt, "basura.tmp"))).toBe(false);
    const st1 = readLog(run.dir).events.filter((e) => e.tipo === "unidad" && e.unidad === "ST-1");
    expect(st1).toHaveLength(3);
  });
});
