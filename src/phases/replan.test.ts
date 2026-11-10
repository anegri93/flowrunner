// Un replan sobre código ya implementado: preparar, planificar, implementar y planificar otra vez,
// llamando a las fases como el runner y escribiendo los eventos que el runner escribiría.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { contextFor, makeProject, newRun, testDeps } from "../../test/helpers/project.ts";
import { simQuery, type SimScript } from "../../test/helpers/sim-sdk.ts";
import type { Plan, Subtask } from "../gates/plan.ts";
import type { Deps, PhaseFn, RunPaths } from "../runner/types.ts";
import type { NewEvent, Outcome, Phase } from "../store/events.ts";
import { commitAll, resetHard } from "../git/git.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { intentarTurno, soltarTurno, turnoFile } from "../store/turno.ts";
import { stateOf } from "../engine/engine.ts";
import { ramaAnterior } from "./conservar.ts";
import { implementar } from "./implementar.ts";
import { prepared } from "./inputs.ts";
import { planificar, readPlan } from "./planificar.ts";
import { preparar } from "./preparar.ts";

const N = [1, 2, 3, 4, 5, 6];

const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Exportar pedidos.

## Criterios
${N.map((n) => `- AC-${String(n)}: existe la parte ${String(n)}.`).join("\n")}
`;

const st = (n: number, alcance: string, extra: Partial<Subtask> = {}): Subtask => ({
  id: `ST-${String(n)}`,
  titulo: `parte ${String(n)}`,
  descripcion: `la parte ${String(n)}`,
  alcance: [alcance],
  dependencias: [],
  depende_de: [],
  ...extra,
});

/** Un test que pasa cuando existe `file`. */
const writeTest = (path: string, file: string) => ({
  tool: "Write",
  input: {
    file_path: path,
    content: `import { existsSync } from "node:fs";\nprocess.exit(existsSync(${JSON.stringify(file)}) ? 0 : 1);\n`,
  },
});

const PLAN_1: Plan = {
  plan: "# Plan\nSeis partes.",
  subtareas: N.map((n) => st(n, `src/s${String(n)}/`)),
  criterios: N.map((n) => ({
    id: `AC-${String(n)}`,
    comando: `node tests/ac${String(n)}.mjs`,
    subtarea: `ST-${String(n)}`,
  })),
  tests: N.map((n) => `tests/ac${String(n)}.mjs`),
  decisiones: [],
  cambia_lo_existente: [],
};
const SCRIPT_1: SimScript = {
  calls: N.map((n) => writeTest(`tests/ac${String(n)}.mjs`, `src/s${String(n)}/s${String(n)}.js`)),
  output: PLAN_1,
};

/** ST-1 a ST-5 se conservan, ST-6 cambia de alcance y ST-7 es nueva. */
const PLAN_2: Plan = {
  plan: "# Plan\nSeis partes, la sexta en otro lado, y una séptima.",
  subtareas: [
    ...[1, 2, 3, 4, 5].map((n) => ({ ...st(n, `src/s${String(n)}/`), conserva: true })),
    st(6, "src/s6b/"),
    st(7, "src/s7/"),
  ],
  criterios: [
    ...[1, 2, 3, 4, 5].map((n) => ({
      id: `AC-${String(n)}`,
      comando: `node tests/ac${String(n)}.mjs`,
      subtarea: `ST-${String(n)}`,
    })),
    { id: "AC-6", comando: "node tests/ac6b.mjs", subtarea: "ST-6" },
  ],
  tests: [...[1, 2, 3, 4, 5].map((n) => `tests/ac${String(n)}.mjs`), "tests/ac6b.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};
const SCRIPT_2: SimScript = {
  calls: [
    { tool: "Read", input: { file_path: "src/s1/s1.js" } },
    writeTest("tests/ac6b.mjs", "src/s6b/s6.js"),
  ],
  output: PLAN_2,
};

/** Una sub-task escribe un archivo en su alcance: `src/s<n>/s<n>.js`, o `src/s6b/s6.js`. */
function unitScript(prompt: string): SimScript {
  const id = /# Sub-task ST-(\d+)/.exec(prompt)?.[1] ?? "";
  const dir = prompt.includes("src/s6b/") && id === "6" ? "s6b" : `s${id}`;
  return {
    calls: [{ tool: "Write", input: { file_path: `src/${dir}/s${id}.js`, content: `// ${id}\n` } }],
  };
}

const isUnit = (prompt: string) => /# Sub-task ST-\d+/.test(prompt);

/** Lo que haría el runner: abre la acción, corre la fase y la cierra con su resultado. */
async function fase(
  run: RunPaths,
  deps: Deps,
  phase: Phase,
  fn: PhaseFn,
  extra: Parameters<typeof contextFor>[3] = {},
): Promise<Outcome> {
  appendEvent(run.dir, { tipo: "accion_iniciada", fase: phase });
  const outcome = await fn(contextFor(run, phase, deps, extra));
  appendEvent(run.dir, { tipo: "accion_terminada", fase: phase, resultado: outcome });
  return outcome;
}

const aprobar: PhaseFn = () => Promise.resolve({ tipo: "espera" });

/** Un run con el primer plan aprobado e implementado entero, detenido en verificar por ST-6. */
async function implementado(
  planner: SimScript[],
  project: Parameters<typeof makeProject>[0] = {
    config: { setup: "true", tests_globs: ["tests/**"] },
  },
  unit: (prompt: string) => SimScript = unitScript,
) {
  const { work } = makeProject(project);
  const run = newRun(work, FEATURE);
  let worktree = "";
  const seen: { prompt: string; s1: boolean }[] = [];
  const sim = simQuery((prompt) => {
    if (isUnit(prompt)) return unit(prompt);
    const k = seen.length;
    seen.push({ prompt, s1: existsSync(join(worktree, "src/s1/s1.js")) });
    return planner[Math.min(k, planner.length - 1)] ?? {};
  });
  const deps = testDeps({ query: sim.query });
  expect(await fase(run, deps, "preparar", preparar)).toEqual({ tipo: "ok" });
  const prep = prepared(readLog(run.dir).events);
  worktree = prep.worktree;
  expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
  await fase(run, deps, "aprobar", aprobar);
  appendEvent(run.dir, { tipo: "aprobado" });
  expect(await fase(run, deps, "implementar", implementar)).toEqual({ tipo: "ok" });
  const verifica: Outcome = {
    tipo: "pregunta",
    motivo: "ST-6 no pudo escribir lo pedido",
    unidades: ["ST-6"],
  };
  await fase(run, deps, "verificar", () => Promise.resolve(verifica));
  return { run, deps, sim, seen, worktree, base: prep.base_sha };
}

const subjects = (wt: string, base: string) =>
  git(wt, "log", "--reverse", "--format=%s", `${base}..HEAD`).split("\n");

// Cada test corre cuatro fases con git y graft de verdad, y hasta nueve sesiones simuladas: solo tarda
// unos 3 s, pero con la suite entera en paralelo pasa los 5 s por defecto.
describe("un replan conserva el código", { timeout: 30_000 }, () => {
  test("un replan conserva el código de ST-1 a ST-5 y solo implementa lo que cambió (VF-6)", async () => {
    const { run, deps, sim, worktree, base } = await implementado([SCRIPT_1, SCRIPT_2]);
    expect(N.every((n) => existsSync(join(worktree, `src/s${String(n)}/s${String(n)}.js`)))).toBe(
      true,
    );
    // Las sub-tasks se integraron en paralelo: el orden de la rama vieja es el que se respeta.
    const orden = subjects(worktree, base).filter((s) => /· ST-[1-5]$/.test(s));
    const rehacer: NewEvent = { tipo: "rehacer", desde: "planificar" };
    appendEvent(run.dir, rehacer);
    expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
    // La rama como la dejó planificar, antes de que implementar le sume nada.
    const rama = subjects(worktree, base);
    const bodies = git(worktree, "log", "--format=%B", `${base}..HEAD`);
    const st1Sha = git(worktree, "log", "--format=%H", "--grep=· ST-1$", `${base}..HEAD`);
    const s6Vieja = existsSync(join(worktree, "src/s6/s6.js"));
    const s1 = existsSync(join(worktree, "src/s1/s1.js"));
    const status = git(worktree, "status", "--porcelain");
    const candidatas = existsSync(join(run.dir, "candidatas.json"));
    const refs = git(worktree, "for-each-ref", `refs/flowrunner/${run.id}/`);
    const locked = Object.keys(readPlan(run).locked).sort();

    await fase(run, deps, "aprobar", aprobar);
    appendEvent(run.dir, { tipo: "aprobado" });
    const before = sim.records.length;
    expect(await fase(run, deps, "implementar", implementar)).toEqual({ tipo: "ok" });
    const units = sim.records
      .slice(before)
      .map((r) => /# Sub-task (ST-\d+)/.exec(r.prompt)?.[1])
      .sort();
    expect(units).toEqual(["ST-6", "ST-7"]);

    const file = join(run.dir, "conservadas.json");
    const conservadas = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as Record<
      string,
      string[]
    >;
    expect(Object.keys(conservadas)).toEqual(["ST-1", "ST-2", "ST-3", "ST-4", "ST-5"]);
    expect(orden.toSorted()).toEqual(
      [1, 2, 3, 4, 5].map((n) => `feat: parte ${String(n)} · ST-${String(n)}`),
    );
    expect(rama).toEqual([...orden, "test: los criterios de SHOP-214, en rojo"]);
    for (const n of [1, 2, 3, 4, 5])
      expect(bodies).toContain(`Flowrunner-Subtask: ST-${String(n)}`);
    // Los SHAs que pasan a implementar son los de la rama nueva.
    expect(conservadas["ST-1"]).toEqual([st1Sha]);
    expect(s6Vieja).toBe(false);
    expect(s1).toBe(true);
    expect(status).toBe("");
    // Lo bloqueado son solo los tests, no el código conservado.
    expect(locked).toEqual([
      "tests/ac1.mjs",
      "tests/ac2.mjs",
      "tests/ac3.mjs",
      "tests/ac4.mjs",
      "tests/ac5.mjs",
      "tests/ac6b.mjs",
    ]);
    // Al pasar el gate, la punta vieja y las candidatas ya no hacen falta.
    expect(candidatas).toBe(false);
    expect(refs).toBe("");

    const events = readLog(run.dir).events;
    const ultima = events.findLastIndex((e) => e.tipo === "aprobado");
    const conservadasLog = events
      .slice(ultima)
      .flatMap((e) =>
        e.tipo === "unidad" && e.motivo === "conservada del plan anterior"
          ? [`${e.unidad}:${e.estado}:${e.sha ?? ""}`]
          : [],
      );
    expect(conservadasLog).toEqual(
      [1, 2, 3, 4, 5].map(
        (n) => `ST-${String(n)}:integrada:${conservadas[`ST-${String(n)}`]?.at(-1) ?? ""}`,
      ),
    );
    expect(existsSync(join(worktree, "src/s6b/s6.js"))).toBe(true);
    expect(existsSync(join(worktree, "src/s7/s7.js"))).toBe(true);
  });

  test("antes de la sesión, el planificador ve el código implementado y la lista de lo ya implementado", async () => {
    const { run, deps, seen } = await implementado([SCRIPT_1, SCRIPT_2]);
    appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
    await fase(run, deps, "planificar", planificar);
    const second = seen[1];
    expect(second?.s1).toBe(true);
    expect(second?.prompt).toContain("## Ya implementado en el worktree");
    expect(second?.prompt).toContain("- ST-1 · parte 1 · src/s1/ · 1 commits");
    // ST-6 está implementada: va en la lista, aunque el plan nuevo la cambie.
    expect(second?.prompt).toContain("- ST-6 · parte 6 · src/s6/ · 1 commits");
  });

  test("un conserva inválido rechaza el plan y no toca la rama", async () => {
    const invalido: SimScript = {
      ...SCRIPT_2,
      output: {
        ...PLAN_2,
        subtareas: PLAN_2.subtareas.map((t) => (t.id === "ST-6" ? { ...t, conserva: true } : t)),
      },
    };
    const { run, deps, worktree } = await implementado([SCRIPT_1, invalido]);
    const tip = git(worktree, "rev-parse", "HEAD");
    appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
    const outcome = await fase(run, deps, "planificar", planificar);
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
    expect(outcome.tipo === "falla" && outcome.motivo).toContain(
      "ST-6 cambió su alcance (antes: src/s6; ahora: src/s6b): no se puede conservar",
    );
    expect(git(worktree, "rev-parse", `refs/flowrunner/${run.id}/anterior`)).toBe(tip);
    // La rama sigue con todo lo de antes: el próximo intento lo vuelve a ver.
    expect(N.every((n) => existsSync(join(worktree, `src/s${String(n)}/s${String(n)}.js`)))).toBe(
      true,
    );
    expect(existsSync(join(run.dir, "candidatas.json"))).toBe(true);
  });

  test("pedir cambios antes de implementar no conserva nada y planifica como hoy", async () => {
    const { work } = makeProject({ config: { setup: "true", tests_globs: ["tests/**"] } });
    const run = newRun(work, FEATURE);
    const sim = simQuery([SCRIPT_1, { calls: [], output: PLAN_1 }]);
    const deps = testDeps({ query: sim.query });
    await fase(run, deps, "preparar", preparar);
    expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
    await fase(run, deps, "aprobar", aprobar);
    appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: "llamá distinto a la parte 2" });
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
    expect(
      await planificar(
        contextFor(run, "planificar", deps, { instruccion: "llamá distinto a la parte 2" }),
      ),
    ).toEqual({ tipo: "ok" });
    expect(existsSync(join(run.dir, "candidatas.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(run.dir, "conservadas.json"), "utf8"))).toEqual({});
    expect(sim.records[1]?.prompt).not.toContain("## Ya implementado en el worktree");
  });

  describe("lo que no es una sub-task y lo que no termina", () => {
    // Si regresiona, un replan borra lo que la persona arregló a mano con `fix --yo`.
    test("un arreglo a mano se reaplica después de las conservadas y antes de los tests", async () => {
      const { run, deps, worktree, base } = await implementado([SCRIPT_1, SCRIPT_2]);
      const orden = subjects(worktree, base).filter((s) => /· ST-[1-5]$/.test(s));
      writeFileSync(join(worktree, "NOTAS.md"), "arreglado a mano\n");
      await commitAll(worktree, "fix: arreglo a mano", { "Flowrunner-Manual": run.id }, deps.env);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
      expect(subjects(worktree, base)).toEqual([
        ...orden,
        "fix: arreglo a mano",
        "test: los criterios de SHOP-214, en rojo",
      ]);
      expect(readFileSync(join(worktree, "NOTAS.md"), "utf8")).toBe("arreglado a mano\n");
    });

    // Si regresiona, un gate rechazado después de sacar lo no conservado deja al próximo intento sin
    // ese código: lo que el plan corregido sí conserva pasa por «no estaba implementada».
    test("después de un gate rechazado, el próximo intento vuelve a ver todas las candidatas", async () => {
      const sinST4: SimScript = {
        ...SCRIPT_2,
        output: {
          ...PLAN_2,
          subtareas: PLAN_2.subtareas.map((t) => (t.id === "ST-4" ? { ...t, conserva: false } : t)),
          tests: [...PLAN_2.tests, "tests/falta.mjs"],
        },
      };
      const { run, deps, worktree } = await implementado([SCRIPT_1, sinST4, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const first = await fase(run, deps, "planificar", planificar);
      expect(first.tipo === "falla" && first.motivo).toContain(
        "el plan declara el test tests/falta.mjs, pero no está escrito",
      );
      // El rechazo llegó con ST-4 ya fuera de la rama.
      expect(existsSync(join(worktree, "src/s4/s4.js"))).toBe(false);
      const motivo = first.tipo === "falla" ? first.motivo : "";
      expect(
        await fase(run, deps, "planificar", planificar, { intento: 2, instruccion: motivo }),
      ).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).conservadas)).toEqual([
        "ST-1",
        "ST-2",
        "ST-3",
        "ST-4",
        "ST-5",
      ]);
      expect(existsSync(join(worktree, "src/s4/s4.js"))).toBe(true);
    });

    // Si regresiona, un proceso que muere en pleno rearmado deja la rama en la base y el reintento
    // pierde todo lo implementado.
    test("si el proceso se corta en pleno rearmado, el reintento retoma desde la punta vieja", async () => {
      const { run, deps, worktree, base } = await implementado([SCRIPT_1, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      // Lo que alcanzó a hacer el intento cortado: guardar la punta y volver la rama a la base.
      await ramaAnterior(run, worktree, readLog(run.dir).events, base, [], deps.env);
      await resetHard(worktree, base, deps.env);
      expect(await planificar(contextFor(run, "planificar", deps, { intento: 2 }))).toEqual({
        tipo: "ok",
      });
      expect(Object.keys(readPlan(run).conservadas)).toEqual([
        "ST-1",
        "ST-2",
        "ST-3",
        "ST-4",
        "ST-5",
      ]);
      expect(existsSync(join(worktree, "src/s1/s1.js"))).toBe(true);
      // La punta vieja se soltó recién con el plan aprobado por el gate.
      expect(git(worktree, "for-each-ref", `refs/flowrunner/${run.id}/`)).toBe("");
    });
  });

  describe("lo que la revisión encontró", () => {
    // Si regresiona, el primer rechazo del gate borra el motivo del replan, y en el segundo intento se
    // conserva justo la sub-task que lo motivó.
    test("el motivo del replan sigue valiendo después de un gate rechazado", async () => {
      // El plan de antes, entero y conservado, ST-6 incluida, con el mismo alcance.
      const conST6: Plan = {
        ...PLAN_1,
        subtareas: PLAN_1.subtareas.map((t) => ({ ...t, conserva: true })),
      };
      const falta: SimScript = {
        calls: [],
        output: {
          ...conST6,
          subtareas: conST6.subtareas.map((t) => ({ ...t, conserva: false })),
          tests: [...conST6.tests, "tests/falta.mjs"],
        },
      };
      const { run, deps } = await implementado([SCRIPT_1, falta, { calls: [], output: conST6 }]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const first = await fase(run, deps, "planificar", planificar);
      expect(first.tipo === "falla" && first.motivo).toContain("tests/falta.mjs");
      const motivo = first.tipo === "falla" ? first.motivo : "";
      const second = await fase(run, deps, "planificar", planificar, {
        intento: 2,
        instruccion: motivo,
      });
      expect(second.tipo === "falla" && second.motivo).toContain(
        "ST-6 la nombran los pedidos de cambios o el motivo del replan: no se puede conservar",
      );
    });

    // Si regresiona, una sub-task conservada no cumple el criterio que el plan nuevo le pide, nadie la
    // vuelve a implementar, y verificar la encuentra en rojo.
    test("una conservada cuyo criterio no pasa con su código no se conserva", async () => {
      const nuevoAC5: SimScript = {
        calls: [
          writeTest("tests/ac5b.mjs", "src/s5/otro.js"),
          writeTest("tests/ac6b.mjs", "src/s6b/s6.js"),
        ],
        output: {
          ...PLAN_2,
          criterios: PLAN_2.criterios.map((c) =>
            c.id === "AC-5" ? { ...c, comando: "node tests/ac5b.mjs" } : c,
          ),
          tests: [...PLAN_2.tests.filter((t) => t !== "tests/ac5.mjs"), "tests/ac5b.mjs"],
        },
      };
      const { run, deps } = await implementado([SCRIPT_1, nuevoAC5]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const outcome = await fase(run, deps, "planificar", planificar);
      expect(outcome.tipo === "falla" && outcome.motivo).toContain(
        "ST-5 tiene conserva: true pero AC-5 no pasa con su código",
      );
    });

    // Si regresiona, las candidatas de un replan rechazado se reusan después de que otra fase cambió la
    // rama, y lo que se commiteó en el medio se pierde.
    test("lo que se commiteó después de un replan rechazado no se pierde en el siguiente", async () => {
      const invalido: SimScript = {
        ...SCRIPT_2,
        output: {
          ...PLAN_2,
          subtareas: PLAN_2.subtareas.map((t) => (t.id === "ST-6" ? { ...t, conserva: true } : t)),
        },
      };
      const { run, deps, worktree, base } = await implementado([SCRIPT_1, invalido, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      expect((await fase(run, deps, "planificar", planificar)).tipo).toBe("falla");
      // La persona sigue desde verificar y arregla algo a mano. Lo que dejó sin commitear el intento
      // rechazado, sus tests, no es parte del arreglo.
      await resetHard(worktree, "HEAD", deps.env);
      appendEvent(run.dir, { tipo: "rehacer", desde: "verificar" });
      await fase(run, deps, "verificar", () =>
        Promise.resolve({ tipo: "pregunta", motivo: "algo", unidades: ["ST-6"] }),
      );
      writeFileSync(join(worktree, "NOTAS.md"), "arreglado a mano\n");
      await commitAll(worktree, "fix: arreglo a mano", { "Flowrunner-Manual": run.id }, deps.env);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
      expect(subjects(worktree, base)).toContain("fix: arreglo a mano");
      expect(existsSync(join(worktree, "NOTAS.md"))).toBe(true);
    });

    // Si regresiona, el texto de un gate rechazado (que nombra sub-tasks) queda como si fuera un
    // pedido, y el intento que corrige el plan ya no puede conservar lo que el gate nombró.
    test("lo que dijo un gate rechazado no cuenta como un pedido que nombra a la sub-task", async () => {
      const malST1: SimScript = {
        ...SCRIPT_2,
        output: {
          ...PLAN_2,
          subtareas: PLAN_2.subtareas.map((t) =>
            t.id === "ST-1" ? { ...t, alcance: ["src/s1/", "src/otra/"] } : t,
          ),
        },
      };
      const { run, deps } = await implementado([SCRIPT_1, malST1, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const first = await fase(run, deps, "planificar", planificar);
      expect(first.tipo === "falla" && first.motivo).toContain("ST-1 cambió su alcance");
      const motivo = first.tipo === "falla" ? first.motivo : "";
      expect(
        await fase(run, deps, "planificar", planificar, { intento: 2, instruccion: motivo }),
      ).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).conservadas)).toEqual([
        "ST-1",
        "ST-2",
        "ST-3",
        "ST-4",
        "ST-5",
      ]);
    });

    // Si regresiona, una conservada que agregó un paquete se rechaza porque su criterio corre con las
    // dependencias de la base: planificar no reinstalaba.
    test("si lo conservado cambia las dependencias, se reinstalan antes de correr sus criterios", async () => {
      const project = {
        files: { ".gitignore": ".instaladas\n" },
        config: {
          setup: "if [ -f deps.lock ]; then cp deps.lock .instaladas; fi",
          tests_globs: ["tests/**"],
          lockfiles: ["deps.lock"],
        },
      };
      const conDeps = (plan: Plan): Plan => ({
        ...plan,
        subtareas: plan.subtareas.map((t) =>
          t.id === "ST-1" ? { ...t, dependencias: ["algo"] } : t,
        ),
      });
      // AC-1 pasa con el archivo de ST-1 y su dependencia instalada.
      const ac1 = {
        tool: "Write",
        input: {
          file_path: "tests/ac1.mjs",
          content:
            'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/s1/s1.js") && existsSync(".instaladas") ? 0 : 1);\n',
        },
      };
      const script1: SimScript = {
        calls: [ac1, ...(SCRIPT_1.calls ?? []).slice(1)],
        output: conDeps(PLAN_1),
      };
      const script2: SimScript = { ...SCRIPT_2, output: conDeps(PLAN_2) };
      const unit = (prompt: string): SimScript => {
        const base = unitScript(prompt);
        return /# Sub-task ST-1\b/.test(prompt)
          ? {
              calls: [
                ...(base.calls ?? []),
                { tool: "Write", input: { file_path: "deps.lock", content: "algo@1\n" } },
              ],
            }
          : base;
      };
      const { run, deps, worktree } = await implementado([script1, script2], project, unit);
      expect(existsSync(join(worktree, "deps.lock"))).toBe(true);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).conservadas)).toContain("ST-1");
    });

    // Si regresiona, un `rerun --desde planificar` después de que planificar se detuvo por el gate toma
    // el texto del gate (que nombra sub-tasks) como el motivo del replan, y ya no las puede conservar.
    test("una detención de planificar no cuenta como motivo que nombra a la sub-task", async () => {
      const { run, deps } = await implementado([SCRIPT_1, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const gate =
        "el plan no pasó el gate:\n- ST-1 cambió su alcance (antes: src/s1; ahora: src/s1, src/otra): no se puede conservar";
      for (let i = 0; i < 2; i++) {
        appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
        appendEvent(run.dir, {
          tipo: "accion_terminada",
          fase: "planificar",
          resultado: { tipo: "falla", clase: "gate", motivo: gate },
        });
      }
      const halted = stateOf(readLog(run.dir).events);
      expect(halted.status).toBe("detenido");
      expect(halted.halt?.motivo).toContain("ST-1 cambió su alcance");
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).conservadas)).toContain("ST-1");
    });

    // Si regresiona, los criterios que tienen que pasar corren mientras otro run del proyecto usa los
    // puertos o la base local, y una conservada sana se rechaza (ADR 0019).
    test("los criterios del gate corren con el turno del entorno", async () => {
      const { run, deps } = await implementado([SCRIPT_1, SCRIPT_2]);
      appendEvent(run.dir, { tipo: "rehacer", desde: "planificar" });
      const file = turnoFile(run.home, stateOf(readLog(run.dir).events).proyecto, "entorno");
      const otro = intentarTurno(file, "OTRO-RUN");
      expect(otro.tipo).toBe("tomado");
      const suelta = setTimeout(() => soltarTurno(file, otro.dueño), 1_500);
      try {
        expect(await fase(run, deps, "planificar", planificar)).toEqual({ tipo: "ok" });
      } finally {
        clearTimeout(suelta);
        soltarTurno(file, otro.dueño);
      }
      const avisos = readLog(run.dir).events.flatMap((e) => (e.tipo === "aviso" ? [e.texto] : []));
      expect(avisos).toContain("esperando el turno del entorno: lo tiene OTRO-RUN");
    });
  });
});
