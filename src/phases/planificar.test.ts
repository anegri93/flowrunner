import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { contextFor, makeProject, newRun, testDeps } from "../../test/helpers/project.ts";
import { simQuery, type SimScript } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { prepared } from "./inputs.ts";
import { planificar, readPlan } from "./planificar.ts";
import { preparar } from "./preparar.ts";

const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Exportar pedidos.

## Criterios
- AC-1: existe src/export/csv.js.
`;

const goodPlan: Plan = {
  plan: "# Plan\nUn serializador.",
  subtareas: [
    {
      id: "ST-1",
      titulo: "Serializador",
      descripcion: "csv",
      alcance: ["src/export/"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [{ que: "usar node:test", por_que: "el repo no tiene framework" }],
};

const writeTest = {
  tool: "Write",
  input: {
    file_path: "tests/ac1.mjs",
    content:
      'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/export/csv.js") ? 0 : 1);\n',
  },
};

async function prepared_(scripts: SimScript[], format?: string, lint_fix?: string) {
  const { work } = makeProject({
    config: {
      setup: "true",
      tests_globs: ["tests/**"],
      ...(format === undefined ? {} : { format }),
      ...(lint_fix === undefined ? {} : { lint_fix }),
    },
  });
  const run = newRun(work, FEATURE);
  const sim = simQuery(scripts);
  const deps = testDeps({ query: sim.query });
  expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
  const worktree = prepared(readLog(run.dir).events).worktree;
  return { run, deps, sim, worktree };
}

describe("planificar", () => {
  // Si regresiona, implementar arranca sin tests bloqueados contra los que verificar.
  test("un plan válido commitea los tests y deja locked.json con un hash por archivo", async () => {
    const { run, deps, worktree } = await prepared_([{ calls: [writeTest], output: goodPlan }]);
    expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
    expect(git(worktree, "log", "-1", "--format=%s")).toBe(
      "test: los criterios de SHOP-214, en rojo",
    );
    expect(git(worktree, "status", "--porcelain")).toBe("");
    const saved = readPlan(run);
    expect(Object.keys(saved.locked)).toEqual(["tests/ac1.mjs"]);
    expect(saved.locked["tests/ac1.mjs"]).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.subtareas[0]?.alcance).toEqual(["src/export/"]);
    const decisions = readLog(run.dir).events.filter((e) => e.tipo === "decision");
    expect(decisions).toHaveLength(1);
  });

  // Si regresiona, el planificador y su explorador leen archivos enteros en vez de ubicar con graft,
  // y planificar se encarece: en VF-1, 95 lecturas y graft una sola vez.
  test("el explorador recibe las herramientas de graft, y el prompt pide ubicar con graft y leer rangos", async () => {
    const { run, deps, sim } = await prepared_([{ calls: [writeTest], output: goodPlan }]);
    await planificar(contextFor(run, "planificar", deps));
    const options = sim.records[0]?.options;
    expect(options?.agents?.explorador?.tools).toEqual(
      expect.arrayContaining(["mcp__graft__graft_find_code", "mcp__graft__graft_trace_calls"]),
    );
    const prompt = sim.records[0]?.prompt ?? "";
    expect(prompt).toContain("graft_find_code");
    expect(prompt).toContain("`offset` y `limit`");
    // Si regresiona, el criterio de «todo en verde» encadena con && y el primer rojo esconde el resto.
    expect(prompt).toContain("su comando es `./.flowrunner/verify.sh`, no una cadena con `&&`");
  });

  // Si regresiona, un plan rechazado deja tests a medias commiteados en la rama de la feature.
  test("un plan cuyo criterio ya pasa se rechaza con el motivo y no commitea nada", async () => {
    const passing = { ...writeTest, input: { ...writeTest.input, content: "process.exit(0);\n" } };
    const { run, deps, worktree } = await prepared_([{ calls: [passing], output: goodPlan }]);
    const outcome = await planificar(contextFor(run, "planificar", deps));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/AC-1 ya pasa antes de implementar/);
    expect(git(worktree, "rev-list", "--count", "HEAD")).toBe(
      git(worktree, "rev-list", "--count", prepared(readLog(run.dir).events).base_sha),
    );
    expect(existsSync(join(run.dir, "plan.md"))).toBe(false);
  });

  test("el motivo del intento anterior y una instrucción de changes llegan al prompt", async () => {
    const { run, deps, sim } = await prepared_([{ calls: [writeTest], output: goodPlan }]);
    await planificar(
      contextFor(run, "planificar", deps, {
        intento: 2,
        instruccion: "separá la validación en ST-2",
      }),
    );
    expect(sim.records[0]?.prompt).toContain("separá la validación en ST-2");
    expect(sim.records[0]?.prompt).toContain("Exportar pedidos a CSV");
    // El explorador solo lee: Read, Grep, Glob y las herramientas de graft, nada que escriba ni ejecute.
    const explorer = sim.records[0]?.options?.agents?.explorador?.tools ?? [];
    expect(explorer.filter((t) => !t.startsWith("mcp__graft__"))).toEqual(["Read", "Grep", "Glob"]);
    expect(Object.keys(sim.records[0]?.options?.mcpServers ?? {})).toEqual(["graft"]);
  });

  // Si regresiona, planificar escribe código de producción además de los tests.
  test("un archivo fuera de los globs de tests lo rechaza el hook y el plan no pasa", async () => {
    const outside = {
      tool: "Write",
      input: { file_path: "src/export/csv.js", content: "export {};\n" },
    };
    const { run, deps, sim, worktree } = await prepared_([
      { calls: [outside], output: { ...goodPlan, tests: ["src/export/csv.js"] } },
    ]);
    const outcome = await planificar(contextFor(run, "planificar", deps));
    expect(sim.records[0]?.decisions[0]).toMatchObject({ decision: "deny" });
    expect(existsSync(join(worktree, "src/export/csv.js"))).toBe(false);
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/no escribió ningún test/);
  });

  test("un reintento arranca de la base: los tests del intento anterior no quedan", async () => {
    const stray = {
      tool: "Write",
      input: { file_path: "tests/viejo.mjs", content: "process.exit(1);\n" },
    };
    const { run, deps, worktree } = await prepared_([
      { calls: [stray], output: { ...goodPlan, tests: ["tests/otro.mjs"] } },
      { calls: [writeTest], output: goodPlan },
    ]);
    expect((await planificar(contextFor(run, "planificar", deps))).tipo).toBe("falla");
    expect(await planificar(contextFor(run, "planificar", deps, { intento: 2 }))).toEqual({
      tipo: "ok",
    });
    expect(existsSync(join(worktree, "tests/viejo.mjs"))).toBe(false);
    expect(readFileSync(join(run.dir, "plan.md"), "utf8")).toContain("Un serializador.");
  });

  describe("con un plan anterior", () => {
    // Si regresiona, cada pedido de cambios reescribe los tests desde cero y rehace el diseño entero.
    test("los tests bloqueados del plan anterior vuelven al worktree, y el prompt trae los pedidos y el plan", async () => {
      const { run, deps, sim, worktree } = await prepared_([
        { calls: [writeTest], output: goodPlan },
        { calls: [], output: goodPlan },
        { calls: [], output: goodPlan },
      ]);
      expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
      for (const motivo of ["agregá la entrada en CAMBIOS.md", "la tabla se llama costos"]) {
        appendEvent(run.dir, { tipo: "cambios_pedidos", motivo });
        expect(
          await planificar(contextFor(run, "planificar", deps, { instruccion: motivo })),
        ).toEqual({ tipo: "ok" });
      }
      const third = sim.records[2]?.prompt ?? "";
      expect(third).toContain("1. agregá la entrada en CAMBIOS.md\n2. la tabla se llama costos");
      expect(third).toContain("Un serializador.");
      expect(Object.keys(readPlan(run).locked)).toEqual(["tests/ac1.mjs"]);
      expect(existsSync(join(worktree, "tests/ac1.mjs"))).toBe(true);
    });

    // Si regresiona, un test que el plan nuevo ya no declara queda bloqueado y en rojo para siempre.
    test("un test del plan anterior que el plan nuevo no declara se borra", async () => {
      const otherTest = {
        tool: "Write",
        input: { file_path: "tests/ac1b.mjs", content: writeTest.input.content },
      };
      const otherPlan = {
        ...goodPlan,
        criterios: [{ id: "AC-1", comando: "node tests/ac1b.mjs", subtarea: "ST-1" }],
        tests: ["tests/ac1b.mjs"],
      };
      const { run, deps, worktree } = await prepared_([
        { calls: [writeTest], output: goodPlan },
        { calls: [otherTest], output: otherPlan },
      ]);
      await planificar(contextFor(run, "planificar", deps));
      appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: "renombrá el test" });
      expect(
        await planificar(contextFor(run, "planificar", deps, { instruccion: "renombrá el test" })),
      ).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).locked)).toEqual(["tests/ac1b.mjs"]);
      expect(existsSync(join(worktree, "tests/ac1.mjs"))).toBe(false);
    });
  });

  describe("con lint", () => {
    const letTest = {
      ...writeTest,
      input: {
        ...writeTest.input,
        content:
          'import { existsSync } from "node:fs";\nlet ruta = "src/export/csv.js";\nprocess.exit(existsSync(ruta) ? 0 : 1);\n',
      },
    };
    // Un lint de mentira con un arreglo de verdad: cambia `let` por `const`, como `eslint --fix` con
    // prefer-const.
    const LET_TO_CONST = "perl -pi -e 's/\\blet\\b/const/g'";

    // Regresión: en VF-4 el planificador escribió `let ahora = HOY;`, el lint del repo pedía `const`, y
    // el test quedó bloqueado así: verify se trabó al final y ninguna sub-task lo podía arreglar.
    test("el lint arregla los tests antes de bloquearlos: el hash es del archivo arreglado", async () => {
      const { run, deps, worktree } = await prepared_(
        [{ calls: [letTest], output: goodPlan }],
        undefined,
        LET_TO_CONST,
      );
      expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
      const content = readFileSync(join(worktree, "tests/ac1.mjs"), "utf8");
      expect(content).toContain('const ruta = "src/export/csv.js";');
      expect(readPlan(run).locked["tests/ac1.mjs"]).toBe(
        createHash("sha256").update(content).digest("hex"),
      );
      expect(git(worktree, "status", "--porcelain")).toBe("");
    });

    // Si regresiona, un error que el lint no arregla solo entra bloqueado y traba el run al final.
    test("un error que el lint no arregla solo rechaza el plan con su salida", async () => {
      const { run, deps } = await prepared_(
        [{ calls: [writeTest], output: goodPlan }],
        undefined,
        "sh -c 'echo \"tests/ac1.mjs 2:1 error no-unused-vars\"; exit 1' --",
      );
      const outcome = await planificar(contextFor(run, "planificar", deps));
      expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
      expect(outcome.tipo === "falla" && outcome.motivo).toMatch(
        /el lint dejó errores que no arregla solo en los tests: .*\n.*no-unused-vars/,
      );
    });
  });

  describe("con formateador", () => {
    const PRETTIER = fileURLToPath(new URL("../../node_modules/.bin/prettier", import.meta.url));
    const longLine = {
      ...writeTest,
      input: {
        ...writeTest.input,
        content:
          'import { existsSync } from "node:fs";\nconst rutas = ["src/export/csv.js", "src/export/encabezados-del-archivo.js", "src/export/filas-del-archivo-exportado.js"];\nprocess.exit(rutas.every((r) => existsSync(r)) ? 0 : 1);\n',
      },
    };

    // Si regresiona, un test con una línea larga queda bloqueado así, ninguna sub-task lo puede
    // formatear y verify se queda en rojo por formato: VF-1 se trabó dos veces por esto.
    test("los tests se formatean antes de bloquearlos: el hash es del archivo formateado y pasa el chequeo", async () => {
      const { run, deps, worktree } = await prepared_(
        [{ calls: [longLine], output: goodPlan }],
        `${PRETTIER} --write`,
      );
      expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
      const content = readFileSync(join(worktree, "tests/ac1.mjs"), "utf8");
      expect(Math.max(...content.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
      const check = spawnSync(PRETTIER, ["--check", "tests/ac1.mjs"], { cwd: worktree });
      expect(check.status).toBe(0);
      expect(readPlan(run).locked["tests/ac1.mjs"]).toBe(
        createHash("sha256").update(content).digest("hex"),
      );
      expect(git(worktree, "status", "--porcelain")).toBe("");
    });

    // Si regresiona, un formateador roto deja pasar tests sin formatear y el run se traba al final.
    test("si el formateador falla, el plan no pasa el gate y lo dice", async () => {
      const { run, deps } = await prepared_([{ calls: [writeTest], output: goodPlan }], "false");
      const outcome = await planificar(contextFor(run, "planificar", deps));
      expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
      expect(outcome.tipo === "falla" && outcome.motivo).toMatch(
        /el formateador falló en los tests: `false` salió 1/,
      );
    });
  });
});
