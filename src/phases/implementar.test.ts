import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { simQuery, type SimScript } from "../../test/helpers/sim-sdk.ts";
import type { Plan, Subtask } from "../gates/plan.ts";
import { runUntilStop } from "../runner/runner.ts";
import type { Deps, PhaseFn, PhaseRegistry, RunPaths } from "../runner/types.ts";
import { PHASES, type Outcome, type RunEvent } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import { checkCommand } from "../tripwires/comandos.ts";
import {
  implementar,
  integradasText,
  prefersExact,
  unitComandos,
  unitScope,
} from "./implementar.ts";

const st = (id: string, alcance: string[], extra: Partial<Subtask> = {}): Subtask => ({
  id,
  titulo: `tarea ${id}`,
  descripcion: id,
  alcance,
  dependencias: [],
  depende_de: [],
  ...extra,
});

const planWith = (subtareas: Subtask[], criterios: Plan["criterios"] = []): Plan => ({
  plan: "plan",
  subtareas,
  criterios:
    criterios.length > 0
      ? criterios
      : [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: subtareas[0]?.id ?? "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
});

const TESTS = { "tests/ac1.mjs": "process.exit(1);\n" };
const write = (path: string, content: string) => ({
  tool: "Write",
  input: { file_path: path, content },
});

/** Elige el guion según la sub-task del prompt y cuántas veces se la llamó. */
function byUnit(scripts: Record<string, SimScript[]>) {
  const seen = new Map<string, number>();
  return (prompt: string): SimScript => {
    const id = /Sub-task (ST-\d+)/.exec(prompt)?.[1] ?? "";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    const list = scripts[id] ?? [{}];
    return list[Math.min(n, list.length - 1)] ?? {};
  };
}

const unitEvents = (dir: string) =>
  readLog(dir).events.flatMap((e) => (e.tipo === "unidad" ? [`${e.unidad}:${e.estado}`] : []));

/** Cierra la entrada a implementar que dejó `plannedRun` con estos eventos y abre otra. */
function reenter(dir: string, events: Parameters<typeof appendEvent>[1][], resultado: Outcome) {
  for (const e of events) appendEvent(dir, e);
  appendEvent(dir, { tipo: "accion_terminada", fase: "implementar", resultado });
  appendEvent(dir, { tipo: "accion_iniciada", fase: "implementar" });
}

describe("instalar dependencias", () => {
  const config = (lock: string) =>
    repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"], lockfiles: [lock] });
  const task = st("ST-1", ["src/"], { dependencias: ["uqr"], dependencias_dev: ["jsqr"] });

  // Si regresiona, una dependencia de desarrollo entra como de producción, o sin la versión exacta que usa el repo.
  test("las de desarrollo van con -D y, si el repo fija versiones, todas con -E", () => {
    expect(unitComandos(config("package-lock.json"), task, [], true).exactos).toEqual([
      "npm install -E uqr",
      "npm install -D -E jsqr",
    ]);
    expect(unitComandos(config("pnpm-lock.yaml"), task, [], false).exactos).toEqual([
      "pnpm add uqr",
      "pnpm add -D jsqr",
    ]);
  });

  // Regresión: en CUENTAS-1, ST-2 corrió el verify completo del repo en su worktree, antes de que ST-3
  // se integrara: rojo por un archivo que traía ST-3, y minutos de 914 tests e2e.
  test("una sub-task corre sus criterios y el lint de su alcance, no el verify del repo", () => {
    const repo = repoConfigSchema.parse({
      setup: "true",
      tests_globs: ["tests/**"],
      lint_fix: "npx eslint --fix",
    });
    const own = st("ST-2", ["src/seeds/a.ts", "src/seeds/b.ts"]);
    expect(unitComandos(repo, own, ["npx jest seeds"], false)).toEqual({
      ampliables: ["npx jest seeds"],
      exactos: [],
      fixers: ["npx eslint --fix"],
    });
  });

  // Regresión de VF-6: 12 rechazos de `prettier --write`, y ST-3 formateó a mano y rompió el typecheck.
  test("una sub-task puede correr el formateador de su alcance y el typecheck del repo", () => {
    const repo = repoConfigSchema.parse({
      setup: "true",
      tests_globs: ["tests/**"],
      format: "npx prettier --write",
      typecheck: "pnpm run typecheck",
    });
    expect(unitComandos(repo, st("ST-3", ["src/carpeta.ts"]), [], false)).toMatchObject({
      ampliables: ["pnpm run typecheck"],
      fixers: ["npx prettier --write"],
    });
  });

  // Regresión: con el alcance de una ruta de Next sin comillas, el lint de la sub-task se rompía en el
  // shell: `[publicId]` es un patrón (zsh corta con «no matches found») y `(comprador)` es sintaxis.
  test("el lint de la sub-task llega al archivo aunque la ruta tenga corchetes o paréntesis", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-lint-"));
    const files = ["src/app/o/[publicId]/page.tsx", "src/app/(comprador)/page.tsx"];
    for (const f of files) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      writeFileSync(join(dir, f), "x\n");
    }
    const repo = repoConfigSchema.parse({
      setup: "true",
      tests_globs: ["tests/**"],
      lint_fix: "ls",
    });
    const task = st("ST-1", files);
    const scope = unitScope(dir, repo, task, [], unitComandos(repo, task, [], false));
    const lint = "ls 'src/app/o/[publicId]/page.tsx' 'src/app/(comprador)/page.tsx'";
    expect(checkCommand(scope, lint)).toEqual({ ok: true });
    // `ls` también es lectura: con un formateador, la política pasa por el fixer y por el alcance.
    const conFormato = repoConfigSchema.parse({
      setup: "true",
      tests_globs: ["tests/**"],
      format: "npx prettier --write",
    });
    const formato = unitScope(dir, conFormato, task, [], unitComandos(conFormato, task, [], false));
    const citados = "'src/app/o/[publicId]/page.tsx' 'src/app/(comprador)/page.tsx'";
    expect(checkCommand(formato, `npx prettier --write ${citados}`)).toEqual({ ok: true });
    expect(checkCommand(formato, "npx prettier --write src/otro.ts").ok).toBe(false);
    for (const shell of ["sh", "zsh"]) {
      const listed = execFileSync(shell, ["-c", lint], { cwd: dir, encoding: "utf8" });
      expect(listed.trim().split("\n").sort()).toEqual([...files].sort());
    }
  });

  // Regresión: en CUENTAS-1 (segundo run), AC-9 era «verify en verde» con `./.flowrunner/verify.sh`
  // como comando. ST-3 lo tenía asignado, lo corrió en su worktree y dio rojo por código de las otras.
  test("el comando de un criterio que es el verify del repo no pasa a la sub-task", () => {
    const repo = repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"] });
    const own = st("ST-3", ["src/conexiones/"]);
    for (const verify of [
      "./.flowrunner/verify.sh",
      ".flowrunner/verify.sh",
      "bash .flowrunner/verify.sh",
      " sh ./.flowrunner/verify.sh ",
    ]) {
      expect(unitComandos(repo, own, ["npx jest conexiones", verify], false).ampliables).toEqual([
        "npx jest conexiones",
      ]);
    }
  });

  test("prefersExact: sí si todas las versiones del manifiesto son exactas, no si alguna es un rango", () => {
    expect(
      prefersExact('{"dependencies":{"a":"1.2.3"},"devDependencies":{"b":"4.0.0-rc.1"}}'),
    ).toBe(true);
    expect(prefersExact('{"dependencies":{"a":"^1.2.3"}}')).toBe(false);
    expect(prefersExact("{}")).toBe(false);
  });
});

describe("implementar", () => {
  // Regresión de PIZ-2, VF-1 y VF-6: ningún reintento sin cambios salió bien, y cada uno es una
  // sesión entera. Si regresiona, la sub-task trabada gasta otra sesión antes de preguntar.
  test("una sub-task sin cambios pregunta al primer intento, con lo último que dijo", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [{ text: "No pude instalar jsqr: ese comando no está permitido." }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    const outcome = await implementar(contextFor(run, "implementar", deps));
    expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1"] });
    const motivo = outcome.tipo === "pregunta" ? outcome.motivo : "";
    expect(motivo).toContain("No pude instalar jsqr");
    expect(unitEvents(run.dir)).toEqual(["ST-1:iniciada", "ST-1:fallida"]);
  });

  // Regresión: en COMPARTIR-1 (rskate) el worktree no tenía .env.local y los e2e de una sub-task no
  // podían levantar la app. Los secretos tienen que estar para los comandos y no para el agente.
  test("la sub-task corre con los env_files sin poder leerlos, y no quedan en su commit", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [
          {
            calls: [
              { tool: "Read", input: { file_path: ".env.local" } },
              write("src/a/uno.js", "export const a = 1;\n"),
            ],
          },
        ],
      }),
    );
    let during: boolean | undefined;
    const query: typeof sim.query = (args) => {
      during = existsSync(join(args.options?.cwd ?? "", ".env.local"));
      return sim.query(args);
    };
    const deps = testDeps({ query });
    const { run, featureWt, work } = await plannedRun(
      planWith([st("ST-1", ["src/a/"])]),
      TESTS,
      deps,
      {
        config: { setup: "true", tests_globs: ["tests/**"], env_files: [".env.local"] },
      },
    );
    writeFileSync(join(work, ".env.local"), "DATABASE_URL=local\n");

    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(during).toBe(true);
    expect(sim.records[0]?.decisions[0]).toMatchObject({ tool: "Read", decision: "deny" });
    expect(sim.records[0]?.decisions[0]?.reason).toContain("secretos");
    expect(git(featureWt, "show", "--name-only", "--format=", "HEAD")).toBe("src/a/uno.js");
  });

  // Si regresiona, las sub-tasks independientes corren de a una y el run tarda el doble.
  test("dos sub-tasks independientes corren a la vez y dejan un commit cada una, con su trailer", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/a/uno.js", "export const a = 1;\n")], delayMs: 300 }],
        "ST-2": [{ calls: [write("src/b/dos.js", "export const b = 2;\n")], delayMs: 300 }],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(sim.concurrency.max).toBe(2);
    const subjects = git(featureWt, "log", "--format=%s", "-3").split("\n");
    expect(subjects.slice(0, 2).sort()).toEqual([
      "feat: tarea ST-1 · ST-1",
      "feat: tarea ST-2 · ST-2",
    ]);
    expect(subjects[2]).toBe("test: criterios en rojo");
    const bodies = git(featureWt, "log", "--format=%B", "-2");
    expect(bodies).toContain("Flowrunner-Subtask: ST-1");
    expect(bodies).toContain("Flowrunner-Subtask: ST-2");
    // Historial lineal: ningún merge.
    expect(git(featureWt, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
  });

  // Si regresiona, un conflicto de integración tira abajo la sub-task en lugar de rehacerla.
  test("una sub-task que choca al integrarse se rehace una vez sobre la punta nueva y después integra", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/compartido.js", "export const x = 'uno';\n")] }],
        "ST-2": [
          { calls: [write("src/compartido.js", "export const x = 'dos';\n")], delayMs: 400 },
          {
            calls: [
              {
                tool: "Edit",
                input: {
                  file_path: "src/compartido.js",
                  old_string: "'uno'",
                  new_string: "'uno y dos'",
                },
              },
            ],
          },
        ],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/compartido.js"]), st("ST-2", ["src/compartido.js"])]),
      TESTS,
      deps,
      { files: { "src/compartido.js": "export const x = 'base';\n" } },
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(readFileSync(join(featureWt, "src/compartido.js"), "utf8")).toBe(
      "export const x = 'uno y dos';\n",
    );
    expect(unitEvents(run.dir).filter((e) => e.startsWith("ST-2"))).toEqual([
      "ST-2:iniciada",
      "ST-2:commiteada",
      "ST-2:iniciada",
      "ST-2:commiteada",
      "ST-2:integrada",
    ]);
    const secondPrompt =
      sim.records.filter((r) => r.prompt.includes("Sub-task ST-2"))[1]?.prompt ?? "";
    expect(secondPrompt).toMatch(/chocó al integrarse.*src\/compartido\.js/);
  });

  // Si regresiona, un test que escribe archivos como efecto lateral cuela cambios fuera del alcance.
  test("una sub-task que viola el doble control no se commitea y reintenta con el motivo", async () => {
    const sideEffect =
      'import { writeFileSync } from "node:fs";\nwriteFileSync("src/generado.txt", "x");\nprocess.exit(1);\n';
    const sim = simQuery(
      byUnit({
        "ST-1": [
          {
            calls: [
              write("src/a/uno.js", "export {};\n"),
              { tool: "Bash", input: { command: "node tests/ac1.mjs" } },
            ],
          },
          { calls: [write("src/a/uno.js", "export {};\n")] },
        ],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(
      planWith([st("ST-1", ["src/a/"])]),
      { "tests/ac1.mjs": sideEffect },
      deps,
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(unitEvents(run.dir)).toEqual([
      "ST-1:iniciada",
      "ST-1:iniciada",
      "ST-1:commiteada",
      "ST-1:integrada",
    ]);
    expect(sim.records[1]?.prompt).toMatch(/src\/generado\.txt está fuera del alcance de ST-1/);
    expect(git(featureWt, "show", "--stat", "--format=", "HEAD")).not.toContain("generado");
  });

  // Si regresiona, una sub-task trabada tira abajo a las demás, o la fase falla sin preguntar.
  test("una sub-task que falla no corta la otra, que se integra, y la fase pregunta por la fallida", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/fuera.js", "x")] }],
        "ST-2": [{ calls: [write("src/b/dos.js", "export {};\n")], delayMs: 200 }],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    const outcome = await implementar(contextFor(run, "implementar", deps));
    expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1"] });
    expect(outcome.tipo === "pregunta" && outcome.motivo).toMatch(
      /^una sub-task no pudo terminar:\n- ST-1 no cambió ningún archivo/,
    );
    expect(unitEvents(run.dir)).toContain("ST-2:integrada");
    expect(unitEvents(run.dir)).toContain("ST-1:fallida");
  });

  // Si regresiona, la persona arregla la trabada y las que esperaban por ella no arrancan nunca.
  test("las que dependen de una sub-task trabada entran en la pregunta", async () => {
    const sim = simQuery(byUnit({ "ST-1": [{ text: "no sé por dónde empezar" }] }));
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"], { depende_de: ["ST-1"] })]),
      TESTS,
      deps,
    );
    const outcome = await implementar(contextFor(run, "implementar", deps));
    expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1", "ST-2"] });
    expect(outcome.tipo === "pregunta" && outcome.motivo).toContain(
      "Quedaron sin arrancar, porque dependen de esas: ST-2",
    );
    expect(sim.records).toHaveLength(1);
  });

  test("devuelto por verificar: rehace solo las sub-tasks nombradas, con el motivo", async () => {
    const sim = simQuery(
      byUnit({ "ST-2": [{ calls: [write("src/b/dos.js", "export const b = 3;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]),
      TESTS,
      deps,
    );
    const outcome = await implementar(
      contextFor(run, "implementar", deps, {
        unidades: ["ST-2"],
        instruccion: "AC-2 sigue rojo: esperaba 403",
      }),
    );
    expect(outcome).toEqual({ tipo: "ok" });
    expect(sim.records).toHaveLength(1);
    expect(sim.records[0]?.prompt).toContain("AC-2 sigue rojo: esperaba 403");
  });

  // Regresión de VF-6: devuelta por verificar, ST-6 intentó escribir CLAUDE.md, el bloqueo lo rechazó
  // y la sub-task cerró «sin cambios» como éxito, cuatro veces, hasta agotar las vueltas. Si
  // regresiona, cierra como éxito o paga otra sesión a ciegas en vez de preguntar.
  test("una sub-task devuelta que no cambió nada porque el bloqueo la frenó pregunta y dice qué rechazó", async () => {
    const sim = simQuery(byUnit({ "ST-1": [{ calls: [write("CLAUDE.md", "# nuevo\n")] }] }));
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    const outcome = await implementar(
      contextFor(run, "implementar", deps, { unidades: ["ST-1"], instruccion: "AC-1 rojo" }),
    );
    expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1"] });
    const motivo = outcome.tipo === "pregunta" ? outcome.motivo : "";
    expect(motivo).toContain(
      "El bloqueo rechazó lo que intentó escribir: CLAUDE.md es parte de CLAUDE.md: ningún agente lo escribe",
    );
    expect(sim.records).toHaveLength(1);
    expect(unitEvents(run.dir)).not.toContain("ST-1:sin_cambios");
    expect(unitEvents(run.dir)).toContain("ST-1:fallida");
  });

  // Fija lo que no cambia: su código ya está integrado y verificar decide de qué lado está el rojo.
  test("una sub-task devuelta sin cambios y sin rechazos sigue cerrando sin cambios", async () => {
    const sim = simQuery(byUnit({ "ST-1": [{ text: "mi parte ya está bien" }] }));
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    // Integrada en la entrada anterior; verificar la devolvió.
    const sha = git(featureWt, "rev-parse", "HEAD");
    reenter(
      run.dir,
      [{ tipo: "unidad", fase: "implementar", unidad: "ST-1", estado: "integrada", sha }],
      { tipo: "ok" },
    );
    const outcome = await implementar(
      contextFor(run, "implementar", deps, { unidades: ["ST-1"], instruccion: "AC-1 rojo" }),
    );
    expect(outcome).toEqual({ tipo: "ok" });
    expect(unitEvents(run.dir)).toEqual(["ST-1:integrada", "ST-1:iniciada", "ST-1:sin_cambios"]);
  });

  describe("tras un fix desde una pregunta de implementar", () => {
    const stuck = (dir: string) =>
      reenter(
        dir,
        [
          { tipo: "unidad", fase: "implementar", unidad: "ST-1", estado: "iniciada" },
          {
            tipo: "unidad",
            fase: "implementar",
            unidad: "ST-1",
            estado: "fallida",
            motivo: "ST-1 no cambió ningún archivo",
          },
        ],
        { tipo: "pregunta", motivo: "una sub-task no pudo terminar", unidades: ["ST-1", "ST-2"] },
      );
    const chained = planWith([
      st("ST-1", ["src/a/"]),
      st("ST-2", ["src/b/"], { depende_de: ["ST-1"] }),
    ]);
    const fix = { unidades: ["ST-1", "ST-2"], instruccion: "Para ST-1: usá jsqr" };

    // Revisión: si regresiona, la trabada cierra «sin cambios» como éxito sin haberse hecho nunca.
    test("la trabada que sigue sin cambiar nada vuelve a preguntar, no cierra sin cambios", async () => {
      const sim = simQuery(byUnit({ "ST-1": [{ text: "sigo sin poder" }] }));
      const deps = testDeps({ query: sim.query });
      const { run } = await plannedRun(chained, TESTS, deps);
      stuck(run.dir);
      const outcome = await implementar(contextFor(run, "implementar", deps, fix));
      expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1", "ST-2"] });
      expect(unitEvents(run.dir)).not.toContain("ST-1:sin_cambios");
      expect(sim.records[0]?.prompt).toContain("Para ST-1: usá jsqr");
    });

    // Revisión: si regresiona, después de un replan la ST-1 nueva cierra «sin cambios» con la
    // integración de la ST-1 del plan anterior, sin haberse hecho.
    test("una integración de antes de la última aprobación no cuenta como su código", async () => {
      const sim = simQuery(byUnit({ "ST-1": [{ text: "sigo sin poder" }] }));
      const deps = testDeps({ query: sim.query });
      const { run, featureWt } = await plannedRun(chained, TESTS, deps);
      const sha = git(featureWt, "rev-parse", "HEAD");
      appendEvent(run.dir, {
        tipo: "unidad",
        fase: "implementar",
        unidad: "ST-1",
        estado: "integrada",
        sha,
      });
      appendEvent(run.dir, { tipo: "aprobado" });
      stuck(run.dir);
      const outcome = await implementar(contextFor(run, "implementar", deps, fix));
      expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1", "ST-2"] });
      expect(unitEvents(run.dir)).not.toContain("ST-1:sin_cambios");
    });

    // Revisión: si regresiona, la que esperaba por la trabada arranca, no hace nada y pasa como hecha.
    test("la que esperaba por ella y no cambia nada pregunta, aunque entre con el fix", async () => {
      const sim = simQuery(
        byUnit({
          "ST-1": [{ calls: [write("src/a/uno.js", "export const a = 1;\n")] }],
          "ST-2": [{ text: "no hay nada que hacer" }],
        }),
      );
      const deps = testDeps({ query: sim.query });
      const { run } = await plannedRun(chained, TESTS, deps);
      stuck(run.dir);
      const outcome = await implementar(contextFor(run, "implementar", deps, fix));
      expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-2"] });
      expect(unitEvents(run.dir)).toContain("ST-1:integrada");
      expect(unitEvents(run.dir)).not.toContain("ST-2:sin_cambios");
    });
  });

  describe("package.json en el alcance sin dependencias", () => {
    const PKG = `${JSON.stringify({ name: "x", scripts: { test: "true" }, dependencies: { zod: "4.0.0" } }, null, 2)}\n`;
    const project = {
      config: { setup: "true", tests_globs: ["tests/**"], manifests: ["package.json"] },
      files: { "package.json": PKG },
    };
    const pkg = (extra: Record<string, unknown>) =>
      `${JSON.stringify({ name: "x", scripts: { test: "true" }, dependencies: { zod: "4.0.0" }, ...extra }, null, 2)}\n`;

    // Regresión de VF-6: el script `mac` se rechazó dos veces y quedó documentado sin existir.
    test("puede agregar un script", async () => {
      const sim = simQuery(
        byUnit({
          "ST-1": [
            {
              calls: [
                write("package.json", pkg({ scripts: { test: "true", mac: "node mac.js" } })),
              ],
            },
          ],
        }),
      );
      const deps = testDeps({ query: sim.query });
      const { run, featureWt } = await plannedRun(
        planWith([st("ST-1", ["src/a/", "package.json"])]),
        TESTS,
        deps,
        project,
      );
      expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
      expect(readFileSync(join(featureWt, "package.json"), "utf8")).toContain(
        '"mac": "node mac.js"',
      );
    });

    // Si regresiona, una sub-task sin dependencias declaradas instala lo que quiere vía package.json.
    test("no puede cambiar sus dependencias", async () => {
      const sim = simQuery(
        byUnit({
          "ST-1": [
            {
              calls: [
                write("package.json", pkg({ dependencies: { zod: "4.0.0", lodash: "4.0.0" } })),
              ],
            },
          ],
        }),
      );
      const deps = testDeps({ query: sim.query });
      const { run } = await plannedRun(
        planWith([st("ST-1", ["src/a/", "package.json"])]),
        TESTS,
        deps,
        project,
      );
      const outcome = await implementar(contextFor(run, "implementar", deps));
      expect(outcome).toMatchObject({ tipo: "pregunta", unidades: ["ST-1"] });
      const rechazos = readLog(run.dir).events.flatMap((e) =>
        e.tipo === "rechazo" ? [e.motivo] : [],
      );
      expect(rechazos).toContain(
        "package.json cambia dependencies sin dependencias declaradas: solo se pueden cambiar otras partes, como los scripts",
      );
    });
  });

  // Si regresiona, un formato a mano de una sub-task llega rojo a verify, y verify no sabe de quién es.
  test("el formateador del repo pasa por lo que cambió la sub-task antes del commit", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [{ calls: [write("src/a/uno.js", "export  const  a = 1;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, featureWt } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps, {
      config: { setup: "true", tests_globs: ["tests/**"], format: "perl -pi -e 's/ +/ /g'" },
    });
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(readFileSync(join(featureWt, "src/a/uno.js"), "utf8")).toBe("export const a = 1;\n");
  });

  describe("un test que ya existía", () => {
    const OLD = { files: { "tests/viejo.mjs": "process.exit(0);\n" } };
    const avisos = (dir: string) =>
      readLog(dir).events.flatMap((e) => (e.tipo === "aviso" ? [e.texto] : []));
    const rewrites = () =>
      simQuery(
        byUnit({
          "ST-1": [
            {
              calls: [
                write("tests/viejo.mjs", "process.exit(1);\n"),
                write("tests/nuevo.mjs", "process.exit(0);\n"),
              ],
            },
          ],
        }),
      );

    // Si regresiona, una sub-task cambia el test que fija una regla vigente y la PR no lo dice.
    test("si una sub-task lo cambia y el plan no lo declaraba, queda un aviso; uno nuevo no avisa", async () => {
      const sim = rewrites();
      const deps = testDeps({ query: sim.query });
      const { run } = await plannedRun(planWith([st("ST-1", ["tests/"])]), TESTS, deps, OLD);
      expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
      expect(avisos(run.dir)).toEqual([
        "test existente cambiado: ST-1 cambió tests/viejo.mjs, que ya existía y el plan aprobado no declaraba",
      ]);
    });

    test("si el plan aprobado lo declaraba, no avisa de nuevo", async () => {
      const sim = rewrites();
      const deps = testDeps({ query: sim.query });
      const plan = {
        ...planWith([st("ST-1", ["tests/"])]),
        cambia_lo_existente: [{ que: "q", donde: "tests/viejo.mjs:1", criterio: "AC-1" }],
      };
      const { run } = await plannedRun(plan, TESTS, deps, OLD);
      expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
      expect(avisos(run.dir)).toEqual([]);
    });
  });
});

describe("cortes de red en implementar", () => {
  const CUT = "getaddrinfo ENOTFOUND api.anthropic.com";
  const cut: SimScript = { throws: CUT };
  const done = (path: string): SimScript => ({ calls: [write(path, "export {};\n")] });
  const pair = planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/b/"])]);

  /** El run entero como lo corre el runner: implementar de verdad, el resto en ok. Anota las esperas. */
  async function runAll(run: RunPaths, deps: Deps) {
    const waits: number[] = [];
    const ok: PhaseFn = () => Promise.resolve({ tipo: "ok" });
    const registry = Object.fromEntries(
      PHASES.map((f) => [f, f === "implementar" ? implementar : ok]),
    ) as PhaseRegistry;
    const final = await runUntilStop(run, registry, {
      ...deps,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    return { final, waits };
  }
  const of = (dir: string, id: string) =>
    unitEvents(dir)
      .filter((e) => e.startsWith(`${id}:`))
      .map((e) => e.slice(id.length + 1));
  const sessionsOf = (records: { prompt: string }[], id: string) =>
    records.filter((r) => r.prompt.includes(`Sub-task ${id}`)).length;

  // Si regresiona, un corte de red de segundos gasta los intentos de la sub-task y termina en una
  // pregunta sobre una sub-task que no estaba trabada.
  test("un corte de red en una sub-task espera y reintenta sin gastar sus intentos", async () => {
    // Dos cortes y una falla de otra infraestructura: si los cortes contaran, el tercer intento sería
    // el último y la sub-task terminaría «no salió en 3 intentos».
    const sim = simQuery(
      byUnit({ "ST-1": [cut, cut, { subtype: "error_during_execution" }, done("src/a/uno.js")] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    const { final, waits } = await runAll(run, deps);
    expect(waits).toEqual([30_000, 120_000]);
    expect(final.status).toBe("entregado");
    expect(of(run.dir, "ST-1")).toEqual([
      "iniciada",
      "fallida",
      "iniciada",
      "fallida",
      "iniciada",
      "iniciada",
      "commiteada",
      "integrada",
    ]);
  });

  // Si regresiona, un corte largo termina en la pregunta de implementar, que pide arreglar una
  // sub-task que no tiene nada que arreglar.
  test("cuatro cortes de red en una sub-task detienen con sin conexión y resume", async () => {
    const sim = simQuery(byUnit({ "ST-1": [cut] }));
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    const { final, waits } = await runAll(run, deps);
    expect(waits).toEqual([30_000, 120_000, 300_000]);
    expect(final.status).toBe("detenido");
    expect(final.fase).toBe("implementar");
    expect(final.halt?.motivo).toContain("sin conexión después de 3 reintentos");
    expect(final.halt?.opciones[0]?.comando).toBe(`flowrunner resume ${run.id}`);
    expect(final.halt?.unidades).toBeUndefined();
    expect(sessionsOf(sim.records, "ST-1")).toBe(4);
  });

  // Si regresiona, el reintento rehace una sub-task ya integrada: otra sesión, que no encuentra nada
  // que cambiar y termina en una pregunta.
  test("una sub-task integrada antes del corte no se rehace al reintentar", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [cut, done("src/a/uno.js")], "ST-2": [done("src/b/dos.js")] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(pair, TESTS, deps);
    const { final, waits } = await runAll(run, deps);
    expect(waits).toEqual([30_000]);
    expect(final.status).toBe("entregado");
    expect(sessionsOf(sim.records, "ST-2")).toBe(1);
    expect(of(run.dir, "ST-2")).toEqual(["iniciada", "commiteada", "integrada"]);
    expect(of(run.dir, "ST-1").at(-1)).toBe("integrada");
  });

  // Si regresiona, retomar después de un corte de más de 7 minutos rehace lo ya integrado.
  test("retomar después de cuatro cortes no rehace lo integrado ni cuenta los cortes", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [cut, cut, cut, cut, { subtype: "error_during_execution" }, done("src/a/uno.js")],
        "ST-2": [done("src/b/dos.js")],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(pair, TESTS, deps);
    expect((await runAll(run, deps)).final.status).toBe("detenido");
    appendEvent(run.dir, { tipo: "reanudado" });
    const { final } = await runAll(run, deps);
    expect(final.status).toBe("entregado");
    expect(sessionsOf(sim.records, "ST-2")).toBe(1);
    expect(sessionsOf(sim.records, "ST-1")).toBe(6);
  });

  // Fija lo que no cambia: un run creado antes de distinguir los cortes de red los reintenta dentro de
  // la sub-task, sin espera, como siempre.
  test("un run viejo sin reintentos_red reintenta la sub-task como antes", async () => {
    const sim = simQuery(byUnit({ "ST-1": [cut, done("src/a/uno.js")] }));
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps);
    const log = join(run.dir, "events.jsonl");
    const [first = "", ...rest] = readFileSync(log, "utf8").split("\n");
    const { reintentos_red: _, ...old } = JSON.parse(first) as Record<string, unknown>;
    writeFileSync(log, [JSON.stringify(old), ...rest].join("\n"));
    const { final, waits } = await runAll(run, deps);
    expect(waits).toEqual([]);
    expect(final.status).toBe("entregado");
    expect(of(run.dir, "ST-1")).toEqual(["iniciada", "iniciada", "commiteada", "integrada"]);
  });
});

describe("la orientación de cada sub-task", () => {
  const FUENTES = {
    "src/a/uno.ts": "export function uno(): number { return 1 }\n",
    "src/b/dos.ts": 'import { uno } from "../a/uno.ts"; export const dos = () => uno() + 1;\n',
    "src/a/tres.ts": "export class Tres {}\n",
  };

  // Si regresiona, cada sub-task vuelve a orientarse con ls, cat y git log por Bash, que es buena parte
  // de los ~100 comandos de lectura que rechazó el bloqueo en 9 runs.
  test("cada sub-task arranca con lo integrado, la API de su alcance y sus llamadores fuera del alcance marcados", async () => {
    const sim = simQuery(
      byUnit({
        "ST-1": [{ calls: [write("src/a/cuatro.ts", "export const cuatro = 4;\n")] }],
        "ST-2": [{ calls: [write("src/c/cinco.ts", "export const cinco = 5;\n")] }],
      }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/"]), st("ST-2", ["src/c/"], { depende_de: ["ST-1"] })]),
      TESTS,
      deps,
      { files: FUENTES },
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    const primero = sim.records[0]?.prompt ?? "";
    expect(primero).toContain("Sub-task ST-1");
    expect(primero).toContain("# Lo que ya hay");
    expect(primero).toContain("function uno(): number");
    expect(primero).toMatch(/`src\/b\/dos\.ts[^\n]*fuera de tu alcance/);
    const segundo = sim.records[1]?.prompt ?? "";
    expect(segundo).toContain("Sub-task ST-2");
    expect(segundo).toMatch(/- ST-1 · tarea ST-1 · [0-9a-f]{7} · alcance: src\/a\//);
  });

  // Si regresiona, las sub-tasks ven la API de la base de preparar, sin los tests del plan ni lo integrado.
  test("implementar reconstruye el índice al entrar: la sub-task ve la API de los tests del plan", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [{ calls: [write("src/a/cuatro.ts", "export const cuatro = 4;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(
      planWith([st("ST-1", ["src/a/", "tests/ayuda.ts"])]),
      { ...TESTS, "tests/ayuda.ts": "export function ayudaDelPlan(): number { return 1 }\n" },
      deps,
      { files: FUENTES },
    );
    expect(await implementar(contextFor(run, "implementar", deps))).toEqual({ tipo: "ok" });
    expect(sim.records[0]?.prompt).toContain("function ayudaDelPlan(): number");
  });

  // Si regresiona, un graft que falta tira la fase abajo en vez de dejar a las sub-tasks como antes.
  test("sin graft, implementar avisa y las sub-tasks arrancan con el texto de falla", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [{ calls: [write("src/a/cuatro.ts", "export const cuatro = 4;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps, {
      files: FUENTES,
    });
    const sinGraft = testDeps({ query: sim.query, env: { ...deps.env, PATH: "/usr/bin:/bin" } });
    expect(await implementar(contextFor(run, "implementar", sinGraft))).toEqual({ tipo: "ok" });
    const avisos = readLog(run.dir).events.flatMap((e) => (e.tipo === "aviso" ? [e.texto] : []));
    expect(avisos).toEqual([
      expect.stringMatching(
        /^graft no pudo reconstruir el índice: .+; las sub-tasks arrancan sin su contexto$/,
      ),
    ]);
    expect(sim.records[0]?.prompt).toContain("(graft no pudo armar el contexto:");
  });

  // Revisión: si regresiona, los secretos esperan en el worktree de la sub-task mientras graft
  // responde, hasta 60 s, y quedan ahí si armar la orientación tira.
  test("los env_files no están en el worktree de la sub-task mientras se arma su orientación", async () => {
    const sim = simQuery(
      byUnit({ "ST-1": [{ calls: [write("src/a/cuatro.ts", "export const cuatro = 4;\n")] }] }),
    );
    const deps = testDeps({ query: sim.query });
    const { run, work } = await plannedRun(planWith([st("ST-1", ["src/a/"])]), TESTS, deps, {
      files: FUENTES,
      config: { setup: "true", tests_globs: ["tests/**"], env_files: [".env.local"] },
    });
    writeFileSync(join(work, ".env.local"), "DATABASE_URL=local\n");
    // Un graft que anota si el .env de la sub-task existe cuando le preguntan.
    const fake = mkdtempSync(join(tmpdir(), "fr-fake-graft-"));
    writeFileSync(
      join(fake, "graft"),
      [
        "#!/bin/sh",
        'if [ "$3" = build ]; then exit 0; fi',
        'if [ -e "$UNIT_WT/.env.local" ]; then echo visto >> "$FAKE_DIR/log"; fi',
        `echo '{"file":"'"$7"'","entries":[],"note":"no definitions indexed for this file"}'`,
      ].join("\n"),
    );
    chmodSync(join(fake, "graft"), 0o755);
    const conFake = testDeps({
      query: sim.query,
      env: {
        ...deps.env,
        PATH: `${fake}:${deps.env.PATH ?? ""}`,
        UNIT_WT: join(run.worktrees, "ST-1"),
        FAKE_DIR: fake,
      },
    });
    expect(await implementar(contextFor(run, "implementar", conFake))).toEqual({ tipo: "ok" });
    expect(sim.records[0]?.prompt).toContain("### `src/a/uno.ts`");
    expect(existsSync(join(fake, "log"))).toBe(false);
  });

  // Si regresiona, una sub-task ve como integrado lo que un replan ya tiró, o se ve a sí misma.
  test("integradasText toma lo integrado desde la última aprobación, una vez por sub-task y sin la propia", () => {
    const at = "2026-11-07T10:00:00.000Z";
    const integrada = (unidad: string, sha: string): RunEvent => ({
      tipo: "unidad",
      at,
      fase: "implementar",
      unidad,
      estado: "integrada",
      sha,
    });
    const events: RunEvent[] = [
      integrada("ST-1", "aaaaaaa1111111"),
      { tipo: "aprobado", at },
      integrada("ST-1", "bbbbbbb2222222"),
      integrada("ST-2", "ccccccc3333333"),
    ];
    const plan = { subtareas: [st("ST-1", ["src/a/", "src/x.ts"]), st("ST-2", ["src/b/"])] };
    expect(integradasText(events, plan, "ST-2")).toBe(
      "- ST-1 · tarea ST-1 · bbbbbbb · alcance: src/a/, src/x.ts",
    );
    expect(integradasText(events.slice(0, 2), plan, "ST-1")).toBe("Ninguna todavía.");
  });
});
