import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { git, tempDir } from "../../test/helpers/git.ts";
import { contextFor, makeProject, newRun, testDeps } from "../../test/helpers/project.ts";
import { simQuery, type SimScript } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import type { RunEvent } from "../store/events.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { prepared } from "./inputs.ts";
import { gateRechazado, planificar, readPlan, sesionAnterior } from "./planificar.ts";
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
  cambia_lo_existente: [],
};

const writeTest = {
  tool: "Write",
  input: {
    file_path: "tests/ac1.mjs",
    content:
      'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/export/csv.js") ? 0 : 1);\n',
  },
};

async function prepared_(
  scripts: SimScript[],
  format?: string,
  lint_fix?: string,
  files?: Record<string, string>,
) {
  const { work } = makeProject({
    ...(files === undefined ? {} : { files }),
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

  // Regresión: en CUENTAS-1, otra herramienta reescribió `.claude/helpers/*` en el worktree mientras
  // planificaba. `add -A` lo commiteó como «tests en rojo», lo bloqueó por hash y llegó a la PR.
  test("lo que cambió fuera de los tests y no escribió el planificador se descarta, con un aviso", async () => {
    const { work } = makeProject({
      files: { ".claude/helpers/hook.cjs": "original\n" },
      config: { setup: "true", tests_globs: ["tests/**"] },
    });
    const run = newRun(work, FEATURE);
    const sim = simQuery([{ calls: [writeTest], output: goodPlan }]);
    let worktree = "";
    const query: typeof sim.query = (args) => {
      writeFileSync(join(worktree, ".claude/helpers/hook.cjs"), "reescrito por otro\n");
      writeFileSync(join(worktree, ".claude/nuevo.json"), "{}\n");
      return sim.query(args);
    };
    const deps = testDeps({ query });
    expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
    worktree = prepared(readLog(run.dir).events).worktree;

    expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
    expect(git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual([
      "tests/ac1.mjs",
    ]);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(worktree, ".claude/helpers/hook.cjs"), "utf8")).toBe("original\n");
    expect(Object.keys(readPlan(run).locked)).toEqual(["tests/ac1.mjs"]);
    const avisos = readLog(run.dir).events.filter((e) => e.tipo === "aviso");
    expect(avisos.map((e) => e.texto)).toEqual([
      expect.stringContaining(".claude/helpers/hook.cjs, .claude/nuevo.json"),
    ]);
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

  describe("lo que ya existe", () => {
    const OLD = { "tests/viejo.mjs": "process.exit(0);\n" };
    const rewriteOld = {
      tool: "Write",
      input: { file_path: "tests/viejo.mjs", content: "process.exit(1);\n" },
    };
    const declared = {
      que: "hoy tests/viejo.mjs exige que pase; queda exigiendo que falle",
      donde: "tests/viejo.mjs:1",
      criterio: "AC-1",
    };

    // Si regresiona, el planificador reescribe el test que fija una regla vigente y lo anota como una
    // decisión más: el plan se aprueba sin que nadie lo vea, como en CUENTAS-1.
    test("reescribir un test existente sin declararlo no pasa el gate", async () => {
      const { run, deps } = await prepared_(
        [{ calls: [writeTest, rewriteOld], output: goodPlan }],
        undefined,
        undefined,
        OLD,
      );
      const outcome = await planificar(contextFor(run, "planificar", deps));
      expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
      expect(outcome.tipo === "falla" && outcome.motivo).toContain(
        "el plan cambia tests/viejo.mjs, un test que ya existe, y no lo declara en cambia_lo_existente",
      );
    });

    // Si regresiona, el plan le da a una sub-task permiso de reescribir un test existente sin decirlo.
    test("nombrar un test existente en el alcance sin declararlo no pasa el gate", async () => {
      const scoped = {
        ...goodPlan,
        subtareas: goodPlan.subtareas.map((t) => ({
          ...t,
          alcance: [...t.alcance, "tests/viejo.mjs"],
        })),
      };
      const { run, deps } = await prepared_(
        [{ calls: [writeTest], output: scoped }],
        undefined,
        undefined,
        OLD,
      );
      const outcome = await planificar(contextFor(run, "planificar", deps));
      expect(outcome.tipo === "falla" && outcome.motivo).toContain(
        "el plan cambia tests/viejo.mjs",
      );
    });

    // Si regresiona, lo declarado no llega a aprobar y la persona aprueba sin verlo.
    test("declarado, pasa y queda en el plan que lee aprobar", async () => {
      const { run, deps } = await prepared_(
        [
          {
            calls: [writeTest, rewriteOld],
            output: { ...goodPlan, cambia_lo_existente: [declared] },
          },
        ],
        undefined,
        undefined,
        OLD,
      );
      expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
      expect(readPlan(run).cambia_lo_existente).toEqual([declared]);
    });

    // Regresión: en CUENTAS-1 el plan cambió lo que devuelve asegurarAcceso y dos seeds que lo llamaban
    // no estaban en ningún alcance. El plan se aprobó y verificar los iba a encontrar rotos sin dueño.
    test("un símbolo que cambia con un llamador fuera de todo alcance no pasa el gate", async () => {
      const files = {
        "src/export/csv.js": "export function serializar(filas) {\n  return filas;\n}\n",
        "src/scripts/volcar.js": "const s = cargar();\nconsole.log(s.serializar(filas));\n",
      };
      const changesSignature = {
        ...goodPlan,
        cambia_lo_existente: [
          {
            que: "serializar pasa a pedir el separador",
            donde: "src/export/csv.js:1",
            criterio: "AC-1",
            simbolo: "serializar",
          },
        ],
      };
      const { run, deps } = await prepared_(
        [{ calls: [writeTest], output: changesSignature }],
        undefined,
        undefined,
        files,
      );
      const outcome = await planificar(contextFor(run, "planificar", deps));
      expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
      expect(outcome.tipo === "falla" && outcome.motivo).toContain(
        "serializar cambia (src/export/csv.js:1) y lo llaman archivos que ninguna sub-task tiene en su alcance: src/scripts/volcar.js",
      );
    });

    // Si regresiona, un test que no existía en la base cuenta como «existente»: en un replan, el que
    // escribió una sub-task conservada y nombra en su alcance pide declararse en cambia_lo_existente.
    test("un test del alcance que no existía en la base no es un test existente", async () => {
      const inScope = {
        ...goodPlan,
        subtareas: goodPlan.subtareas.map((t) => ({
          ...t,
          alcance: ["src/export/", "tests/ac1.mjs"],
        })),
      };
      const { run, deps } = await prepared_([{ calls: [writeTest], output: inScope }]);
      expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
    });

    test("el prompt dice que cambiar lo existente no es una decisión del planificador", async () => {
      const { run, deps, sim } = await prepared_([{ calls: [writeTest], output: goodPlan }]);
      await planificar(contextFor(run, "planificar", deps));
      expect(sim.records[0]?.prompt).toContain(
        "Lo que ya existe y el plan cambia **no es una decisión tuya**",
      );
    });
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

  describe("con un gate rechazado", () => {
    const writeAc2 = {
      tool: "Write",
      input: { file_path: "tests/ac2.mjs", content: writeTest.input.content },
    };
    const twoTests: Plan = { ...goodPlan, tests: ["tests/ac1.mjs", "tests/ac2.mjs"] };
    const sesionFile = (run: { dir: string }) => join(run.dir, "planificar-sesion.json");

    /** El primer intento, entre los eventos que deja el runner, y el reintento con el motivo del gate. */
    async function rechazadoYReintento(
      run: Parameters<typeof contextFor>[0],
      deps: Parameters<typeof contextFor>[2],
    ) {
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      const first = await planificar(contextFor(run, "planificar", deps));
      expect(first).toMatchObject({ tipo: "falla", clase: "gate" });
      if (first.tipo !== "falla") throw new Error("el primer intento tenía que fallar");
      appendEvent(run.dir, { tipo: "accion_terminada", fase: "planificar", resultado: first });
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      const second = await planificar(
        contextFor(run, "planificar", deps, { intento: 2, instruccion: first.motivo }),
      );
      return { motivo: first.motivo, second };
    }

    // Si regresiona, un rechazo por una sola declaración faltante vuelve a explorar todo el repo en una
    // sesión nueva: en ML-1 y VF-5 eso costó US$ 2 a 2,8 y 10 minutos por reintento.
    test("un plan rechazado por el gate se corrige retomando la misma sesión, con el motivo como único mensaje", async () => {
      const { run, deps, sim, worktree } = await prepared_([
        { calls: [writeTest], output: twoTests },
        { calls: [writeAc2], output: twoTests },
      ]);
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      const first = await planificar(contextFor(run, "planificar", deps));
      expect(first.tipo === "falla" && first.motivo).toContain(
        "el plan declara el test tests/ac2.mjs, pero no está escrito",
      );
      // La sesión rechazada queda persistida y anotada para el reintento.
      const sessionId = sim.records[0]?.options?.sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sim.records[0]?.options?.persistSession).toBe(true);
      expect(JSON.parse(readFileSync(sesionFile(run), "utf8"))).toEqual({
        sessionId,
        nombre: "planificar-1",
      });
      if (first.tipo !== "falla") return;
      appendEvent(run.dir, { tipo: "accion_terminada", fase: "planificar", resultado: first });
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });

      const second = await planificar(
        contextFor(run, "planificar", deps, { intento: 2, instruccion: first.motivo }),
      );

      expect(sim.records).toHaveLength(2);
      expect(sim.records[1]?.options?.resume).toBe(sessionId);
      const prompt = sim.records[1]?.prompt ?? "";
      expect(prompt.startsWith("El gate rechazó el plan que devolviste")).toBe(true);
      expect(prompt).toContain(first.motivo);
      expect(prompt).not.toContain("Exportar pedidos a CSV");
      expect(existsSync(join(worktree, "tests/ac1.mjs"))).toBe(true);
      expect(second).toEqual({ tipo: "ok" });
      expect(Object.keys(readPlan(run).locked).sort()).toEqual(["tests/ac1.mjs", "tests/ac2.mjs"]);
      // Cada sesión emite su propio uso.
      const usos = readLog(run.dir).events.flatMap((e) => (e.tipo === "uso" ? [e.sesion] : []));
      expect(usos).toEqual(["planificar-1", "planificar-2"]);
    });

    // Si regresiona, una sesión que no se puede retomar (expiró, el CLI falló) deja el intento en falla
    // y gasta uno de los tres intentos de planificar sin haber planificado.
    test("si retomar falla, planifica de cero en el mismo intento y lo avisa", async () => {
      const { run, deps, sim, worktree } = await prepared_([
        { calls: [writeTest], output: twoTests },
        { subtype: "error_during_execution" },
        { calls: [writeTest, writeAc2], output: twoTests },
      ]);
      const { second } = await rechazadoYReintento(run, deps);
      expect(sim.records).toHaveLength(3);
      expect(sim.records[1]?.options?.resume).toBeDefined();
      expect(sim.records[2]?.options?.resume).toBeUndefined();
      expect(sim.records[2]?.prompt).toContain("Exportar pedidos a CSV");
      const avisos = readLog(run.dir).events.flatMap((e) => (e.tipo === "aviso" ? [e.texto] : []));
      expect(avisos.filter((t) => t.startsWith("no se pudo retomar la sesión del plan"))).toEqual([
        expect.stringMatching(
          /\(la sesión planificar-2 terminó con error_during_execution.*\): planifica de cero$/,
        ),
      ]);
      expect(second).toEqual({ tipo: "ok" });
      expect(existsSync(join(worktree, "tests/ac2.mjs"))).toBe(true);
    });

    // Si regresiona, un pedido de cambios retoma la conversación de un plan que ya se aprobó, o las
    // conversaciones de planificar se acumulan en el disco después de pasar el gate.
    test("un pedido de cambios no retoma la sesión", async () => {
      const { run, deps, sim } = await prepared_([
        { calls: [writeTest], output: goodPlan },
        { calls: [], output: goodPlan },
      ]);
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      const first = await planificar(contextFor(run, "planificar", deps));
      expect(first).toEqual({ tipo: "ok" });
      expect(sim.records[0]?.options?.persistSession).toBe(true);
      expect(existsSync(sesionFile(run))).toBe(false);
      appendEvent(run.dir, { tipo: "accion_terminada", fase: "planificar", resultado: first });
      appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: "renombrá el serializador" });
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      expect(
        await planificar(
          contextFor(run, "planificar", deps, { instruccion: "renombrá el serializador" }),
        ),
      ).toEqual({ tipo: "ok" });
      expect(sim.records[1]?.options?.resume).toBeUndefined();
      expect(sim.records[1]?.prompt).toContain("Exportar pedidos a CSV");
      expect(existsSync(sesionFile(run))).toBe(false);
    });

    // Si regresiona, un test que el planificador escribió en el intento rechazado y el plan corregido ya
    // no declara queda bloqueado en rojo hasta la PR: antes lo borraba el reset entre intentos.
    test("un test que el intento retomado dejó sin declarar se descarta", async () => {
      const sobra = {
        tool: "Write",
        input: { file_path: "tests/sobra.mjs", content: "process.exit(1);\n" },
      };
      const { run, deps, worktree } = await prepared_([
        { calls: [writeTest, sobra], output: twoTests },
        { calls: [], output: goodPlan },
      ]);
      const { second } = await rechazadoYReintento(run, deps);
      expect(second).toEqual({ tipo: "ok" });
      expect(existsSync(join(worktree, "tests/sobra.mjs"))).toBe(false);
      expect(Object.keys(readPlan(run).locked)).toEqual(["tests/ac1.mjs"]);
      expect(git(worktree, "show", "--name-only", "--format=", "HEAD")).toBe("tests/ac1.mjs");
      const avisos = readLog(run.dir).events.flatMap((e) => (e.tipo === "aviso" ? [e.texto] : []));
      expect(avisos).toContain("se descartaron tests que el plan no declara: tests/sobra.mjs");
    });

    // Si regresiona, un proceso que muere en pleno intento nuevo deja anotada la sesión de un intento
    // anterior, y el siguiente retoma esa conversación sobre un worktree que ya se reseteó.
    test("si el proceso muere en un intento nuevo, el siguiente no retoma la sesión de antes", async () => {
      const { work } = makeProject({ config: { setup: "true", tests_globs: ["tests/**"] } });
      const run = newRun(work, FEATURE);
      const sim = simQuery([
        { calls: [writeTest], output: twoTests },
        { subtype: "error_during_execution" },
        { calls: [writeTest, writeAc2], output: twoTests },
      ]);
      let llamadas = 0;
      const query: typeof sim.query = (args) => {
        llamadas++;
        // La tercera sesión es el intento nuevo después de no poder retomar: ahí muere el proceso.
        if (llamadas === 3) throw new Error("el proceso se cortó");
        return sim.query(args);
      };
      const deps = testDeps({ query });
      expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      const first = await planificar(contextFor(run, "planificar", deps));
      if (first.tipo !== "falla") throw new Error("el primer intento tenía que fallar");
      appendEvent(run.dir, { tipo: "accion_terminada", fase: "planificar", resultado: first });
      const reintento = { intento: 2, instruccion: first.motivo };
      appendEvent(run.dir, { tipo: "accion_iniciada", fase: "planificar" });
      await expect(planificar(contextFor(run, "planificar", deps, reintento))).rejects.toThrow(
        "el proceso se cortó",
      );
      // El runner rehace la acción iniciada sin terminar, con la misma instrucción y sin otra
      // `accion_iniciada`.
      expect(await planificar(contextFor(run, "planificar", deps, reintento))).toEqual({
        tipo: "ok",
      });
      expect(sim.records).toHaveLength(3);
      expect(sim.records[2]?.options?.resume).toBeUndefined();
      expect(sim.records[2]?.prompt).toContain("Exportar pedidos a CSV");
    });

    // Si regresiona, se retoma la sesión de un plan después de pedir cambios o de un rerun, o un archivo
    // de sesión roto tira la fase abajo en vez de planificar de cero.
    test("solo el reintento de un gate rechazado retoma, y un archivo de sesión roto cuenta como ausente", () => {
      const motivo = "el plan no pasó el gate:\n- falta algo";
      const at = "2026-11-07T10:00:00.000Z";
      const rechazo = [
        { tipo: "accion_iniciada", at, fase: "planificar" },
        {
          tipo: "accion_terminada",
          at,
          fase: "planificar",
          resultado: { tipo: "falla", clase: "gate", motivo },
        },
        { tipo: "accion_iniciada", at, fase: "planificar" },
      ] as const satisfies readonly RunEvent[];
      expect(gateRechazado(rechazo, motivo)).toBe(motivo);
      expect(gateRechazado(rechazo, undefined)).toBeUndefined();
      expect(gateRechazado(rechazo, "otra instrucción")).toBeUndefined();
      expect(
        gateRechazado([...rechazo, { tipo: "rehacer", at, desde: "planificar" }], motivo),
      ).toBeUndefined();
      expect(
        gateRechazado([...rechazo, { tipo: "cambios_pedidos", at, motivo }], motivo),
      ).toBeUndefined();
      const infra = [
        ...rechazo,
        {
          tipo: "accion_terminada",
          at,
          fase: "planificar",
          resultado: { tipo: "falla", clase: "infra", motivo },
        },
      ] as const satisfies readonly RunEvent[];
      expect(gateRechazado(infra, motivo)).toBeUndefined();

      const run = newRun(tempDir("fr-sesion-"));
      expect(sesionAnterior(run)).toBeUndefined();
      writeFileSync(join(run.dir, "planificar-sesion.json"), "{roto");
      expect(sesionAnterior(run)).toBeUndefined();
      writeFileSync(join(run.dir, "planificar-sesion.json"), JSON.stringify({ sessionId: "x" }));
      expect(sesionAnterior(run)).toBeUndefined();
      const ok = { sessionId: "5b0c6f8e-4c1a-4b8e-9d3a-2f7e1c0a9b11", nombre: "planificar-1" };
      writeFileSync(join(run.dir, "planificar-sesion.json"), JSON.stringify(ok));
      expect(sesionAnterior(run)).toEqual(ok);
    });
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

  // Regresión: en COMPARTIR-1 (rskate) el worktree no tenía .env.local: cada e2e esperó 180 s a un
  // servidor que no podía arrancar y «falló» sin probar nada (18 min de gate). Además el gate rechazó
  // «verify en verde» por pasar sobre la base, y el plan dio otra vuelta.
  test("el gate corre los criterios con los env_files y sin el del verify, y no los deja en el commit", async () => {
    const marks = tempDir("fr-gate-env-");
    const { work } = makeProject({
      config: { setup: "true", tests_globs: ["tests/**"], env_files: [".env.local"] },
    });
    writeFileSync(join(work, ".env.local"), "DATABASE_URL=local\n");
    const run = newRun(
      work,
      FEATURE.replace(
        "- AC-1: existe src/export/csv.js.",
        "- AC-1: existe src/export/csv.js.\n- AC-2: el repo sigue en verde.",
      ),
    );
    const sim = simQuery([
      {
        calls: [
          {
            tool: "Write",
            input: {
              file_path: "tests/ac1.mjs",
              content: `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(`${marks}/vio.log`)}, readFileSync(".env.local", "utf8"));\nprocess.exit(1);\n`,
            },
          },
        ],
        output: {
          ...goodPlan,
          criterios: [
            { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
            { id: "AC-2", comando: "./.flowrunner/verify.sh", subtarea: "ST-1" },
          ],
        },
      },
    ]);
    const deps = testDeps({ query: sim.query });
    expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
    const worktree = prepared(readLog(run.dir).events).worktree;
    expect(await planificar(contextFor(run, "planificar", deps))).toEqual({ tipo: "ok" });
    expect(readFileSync(join(marks, "vio.log"), "utf8")).toBe("DATABASE_URL=local\n");
    expect(existsSync(join(worktree, ".env.local"))).toBe(false);
    expect(git(worktree, "show", "--name-only", "--format=", "HEAD")).toBe("tests/ac1.mjs");
  });

  test("si falta un env_file en el repo, planificar se detiene por el entorno", async () => {
    const { work } = makeProject({
      config: { setup: "true", tests_globs: ["tests/**"], env_files: [".env.local"] },
    });
    const run = newRun(work, FEATURE);
    const sim = simQuery([{ calls: [writeTest], output: goodPlan }]);
    const deps = testDeps({ query: sim.query });
    expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
    const outcome = await planificar(contextFor(run, "planificar", deps));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/^\.env\.local no existe en /);
  });
});
