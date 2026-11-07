// Gate final: el recorrido entero por CLI, con cortes y reanudaciones, sobre repos reales en tmpdir,
// con el SDK simulado y gh falso. Feature, preparar, planificar, aprobar, implementar en paralelo,
// verificar, revisar, entregar y aprender.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Plan } from "../src/gates/plan.ts";
import { isAlive, readLock } from "../src/store/lock.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { git, tempDir } from "./helpers/git.ts";
import { waitFor } from "./helpers/runs.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { simWorld } from "./helpers/sim-world.ts";
import { execFileSync } from "node:child_process";

const FEATURE = `---
clave: SHOP-300
proyecto: acme-api
titulo: Dos módulos
---
## Descripción
Dos módulos independientes.

## Criterios
- AC-1: existe src/a/uno.js.
- AC-2: existe src/b/dos.js.
`;
const exists = (p: string) =>
  `import { existsSync } from "node:fs";\nprocess.exit(existsSync("${p}") ? 0 : 1);\n`;
const write = (file_path: string, content: string) => ({
  tool: "Write",
  input: { file_path, content },
});
const PLAN: Plan = {
  plan: "# Plan\nDos sub-tasks en paralelo.",
  subtareas: [
    {
      id: "ST-1",
      titulo: "Uno",
      descripcion: "src/a/uno.js",
      alcance: ["src/a/"],
      dependencias: [],
      depende_de: [],
    },
    {
      id: "ST-2",
      titulo: "Dos",
      descripcion: "src/b/dos.js",
      alcance: ["src/b/"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [
    { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
    { id: "AC-2", comando: "node tests/ac2.mjs", subtarea: "ST-2" },
  ],
  tests: ["tests/ac1.mjs", "tests/ac2.mjs"],
  decisiones: [{ que: "dos archivos", por_que: "son independientes" }],
};
const planScript = (delayMs?: number): SimScript => ({
  match: "Sos el planificador",
  calls: [
    write("tests/ac1.mjs", exists("src/a/uno.js")),
    write("tests/ac2.mjs", exists("src/b/dos.js")),
  ],
  output: PLAN,
  ...(delayMs === undefined ? {} : { delayMs }),
});
const unitScript = (id: string, file: string, delayMs?: number): SimScript => ({
  match: `Sub-task ${id}`,
  calls: [write(file, `export const ${id.replace("-", "")} = 1;\n`)],
  ...(delayMs === undefined ? {} : { delayMs }),
});

describe("recorrido completo", () => {
  // Si regresiona, flowrunner no lleva una feature de punta a punta, o un corte lo deja a medias.
  test("feature → PR → lecciones, con un corte en planificar y otro en implementar", async () => {
    const w = simWorld({
      real: [
        "preparar",
        "planificar",
        "aprobar",
        "implementar",
        "verificar",
        "revisar",
        "entregar",
        "aprender",
      ],
      scripts: [
        planScript(2500),
        planScript(),
        unitScript("ST-1", "src/a/uno.js", 2500),
        unitScript("ST-2", "src/b/dos.js", 2500),
        unitScript("ST-1", "src/a/uno.js"),
        unitScript("ST-2", "src/b/dos.js"),
        { match: "Sos el revisor", output: { hallazgos: [], decisiones: [] } },
      ],
      feature: FEATURE,
      project: { config: { setup: "true", tests_globs: ["tests/**"], max_parallel: 2 } },
    });
    const sessions = (id: string) => {
      try {
        return readdirSync(join(w.dir(id), "sesiones"));
      } catch {
        return [];
      }
    };
    const killAndResume = async (id: string) => {
      const pid = await waitFor("el pid", () => readLock(w.home, "acme-api")?.pid);
      process.kill(pid, "SIGKILL");
      await waitFor("muerto", () => !isAlive(pid));
      expect(runCli(["resume", id], w.env).status).toBe(0);
    };

    expect(runCli(["feature", "check", w.feature], w.env).status).toBe(0);
    const id = w.launch();
    await waitFor("planificando", () => w.prompts().includes("Sos el planificador"), 60_000);
    await killAndResume(id);
    await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
    expect(runCli(["approve", id], w.env).status).toBe(0);
    await waitFor(
      "dos sesiones de implementar",
      () =>
        sessions(id).filter((s) => s.startsWith("implementar")).length === 0
          ? undefined
          : w.prompts().includes("Sub-task ST-2") && w.prompts().includes("Sub-task ST-1"),
      60_000,
    );
    await killAndResume(id);
    await waitFor(
      "entregado",
      () => ["entregado", "detenido"].includes(w.state(id).status),
      120_000,
    );
    expect(w.state(id).halt?.motivo).toBeUndefined();
    expect(w.state(id).status).toBe("entregado");

    const branch = "feat/SHOP-300-dos-modulos";
    const subjects = git(w.remote, "log", "--format=%s", `main..${branch}`).split("\n");
    expect(subjects.filter((s) => s.startsWith("feat:")).sort()).toEqual([
      "feat: Dos · ST-2",
      "feat: Uno · ST-1",
    ]);
    expect(readLog(w.dir(id)).events.filter((e) => e.tipo === "reanudado")).toHaveLength(2);

    // La persona corrige la PR y la mergea; tick aprende.
    const clone = join(tempDir(), "c");
    execFileSync("git", ["clone", "-q", "-b", branch, w.remote, clone]);
    writeFileSync(join(clone, "src/a/uno.js"), "export const ST1 = 2;\n");
    git(clone, "commit", "-qam", "fix: valor correcto");
    git(clone, "push", "-q", "origin", branch);
    const oid = git(clone, "rev-parse", "HEAD");
    const stateFile = join(w.env.HOME ?? "", "gh-state.json");
    const gh = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: Record<string, unknown>[] };
    const pr = gh.prs[0] ?? {};
    pr.state = "MERGED";
    pr.commits = [
      {
        oid: "ours",
        messageHeadline: "feat",
        messageBody: `Flowrunner-Run: ${id}`,
        authors: [{ login: "bot" }],
      },
      { oid, messageHeadline: "fix", messageBody: "", authors: [{ login: "yo" }] },
    ];
    writeFileSync(stateFile, JSON.stringify(gh));
    const scriptsFile = w.env.FAKE_SIM_SCRIPTS ?? "";
    const scripts = JSON.parse(readFileSync(scriptsFile, "utf8")) as SimScript[];
    const origin = `${String(pr.url)}/commits/${oid}`;
    writeFileSync(
      scriptsFile,
      JSON.stringify([
        ...scripts,
        {
          match: "Sos el que aprende",
          output: { lecciones: [{ titulo: "Valor correcto", regla: "Usar 2.", origen: origin }] },
        },
      ]),
    );
    expect(runCli(["tick"], w.env).stdout).toContain(`${id}: quedó cerrado`);
    expect(git(w.remote, "show", "chore/lecciones-SHOP-300:.flowrunner/lecciones.md")).toContain(
      `Origen: ${origin}`,
    );
    expect(readFileSync(join(w.env.HOME ?? "", "gh.log"), "utf8")).toContain(
      '"merge","413","--auto","--merge"',
    );
    const report = runCli(["report", id], w.env).stdout;
    expect(report).toContain("- **Estado:** cerrado");
    expect(JSON.parse(runCli(["stats", "--json"], w.env).stdout)).toMatchObject({
      runs: 1,
      lecciones: 1,
    });
  }, 300_000);
});
