import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannedRun } from "../../test/helpers/planned.ts";
import { git as gitOut, repoWith } from "../../test/helpers/git.ts";
import { contextFor, testDeps, writeFiles } from "../../test/helpers/project.ts";
import type { Plan } from "../gates/plan.ts";
import { commitAll } from "../git/git.ts";
import { verifyScript } from "../setup/infer.ts";
import { readLog } from "../store/run-log.ts";
import { readPlan } from "./planificar.ts";
import { namedFiles, verificar } from "./verificar.ts";

const plan: Plan = {
  plan: "plan",
  subtareas: [
    {
      id: "ST-1",
      titulo: "csv",
      descripcion: "csv",
      alcance: ["src/csv.js"],
      dependencias: [],
      depende_de: [],
    },
    {
      id: "ST-2",
      titulo: "permiso",
      descripcion: "403",
      alcance: ["src/permiso.js"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [
    { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
    { id: "AC-2", comando: "node tests/ac2.mjs", subtarea: "ST-2" },
  ],
  tests: ["tests/ac1.mjs", "tests/ac2.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

const TESTS = {
  "tests/ac1.mjs":
    'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/csv.js") ? 0 : 1);\n',
  "tests/ac2.mjs":
    'import { readFileSync } from "node:fs";\nconsole.error("esperaba 403");\nprocess.exit(readFileSync("src/permiso.js", "utf8").includes("403") ? 0 : 1);\n',
};

async function featureWith(
  files: Record<string, string>,
  verify = "exit 0",
  baseFiles: Record<string, string> = {},
) {
  const deps = testDeps();
  const { run, featureWt } = await plannedRun(plan, TESTS, deps, { verify, files: baseFiles });
  writeFiles(featureWt, files);
  await commitAll(featureWt, "feat: implementado", {}, deps.env);
  return { run, featureWt, deps };
}

describe("verificar", () => {
  test("todo verde: avanza", async () => {
    const { run, deps } = await featureWith({ "src/csv.js": "x", "src/permiso.js": "403" });
    expect(await verificar(contextFor(run, "verificar", deps))).toEqual({ tipo: "ok" });
  });

  // Si regresiona, verificar rehace todas las sub-tasks por un criterio que cubre una sola.
  test("AC-2 rojo: vuelve solo ST-2, con el comando y su salida en el motivo", async () => {
    const { run, deps } = await featureWith({ "src/csv.js": "x", "src/permiso.js": "200" });
    const outcome = await verificar(contextFor(run, "verificar", deps));
    expect(outcome).toMatchObject({ tipo: "vuelve", unidades: ["ST-2"] });
    expect(outcome.tipo === "vuelve" && outcome.motivo).toMatch(
      /AC-2 sigue en rojo: `node tests\/ac2\.mjs` salió 1:\nesperaba 403/,
    );
  });

  // Si regresiona, un formato rojo esconde los tests rotos que vienen después, y el motivo dice que
  // lo único que falla es el formato: en VF-1 había 3 tests rotos que flowrunner nunca vio.
  test("con el verify que arma init, el motivo nombra todos los pasos rojos, no solo el primero", async () => {
    // La base está en verde; la feature, que agrega src/roto, rompe un test y el formato.
    const paso =
      '[ -f src/roto ] || exit 0\ncase "$1" in\n  test) echo "FAIL src/marcas.test.ts"; exit 1 ;;\n  format:check) echo "[warn] src/a.ts"; exit 1 ;;\nesac\n';
    const { run, deps } = await featureWith(
      { "src/csv.js": "x", "src/permiso.js": "403", "src/roto": "" },
      verifyScript("sh paso.sh", ["test", "lint", "format:check"]),
      { "paso.sh": paso },
    );
    const outcome = await verificar(contextFor(run, "verificar", deps));
    expect(outcome.tipo).toBe("vuelve");
    const motivo = outcome.tipo === "vuelve" ? outcome.motivo : "";
    expect(motivo).toContain("FAIL src/marcas.test.ts");
    expect(motivo).toContain("[warn] src/a.ts");
    expect(motivo).toContain("verify en rojo: sh paso.sh test; sh paso.sh format:check;");
  });

  // Regresión: en VF-4 un test bloqueado tenía `let` donde el lint del repo pide `const`, verify quedaba
  // en rojo y ninguna sub-task lo podía tocar: el run se trabó cuatro veces.
  test("repara con el lint del repo un test bloqueado, lo commitea con su hash nuevo y sigue", async () => {
    const deps = testDeps();
    const tests = {
      ...TESTS,
      "tests/ac1.mjs":
        'import { existsSync } from "node:fs";\nlet ruta = "src/csv.js";\nprocess.exit(existsSync(ruta) ? 0 : 1);\n',
    };
    const { run, featureWt } = await plannedRun(plan, tests, deps, {
      config: {
        setup: "true",
        tests_globs: ["tests/**"],
        lint_fix: "perl -pi -e 's/\\blet\\b/const/g'",
      },
      // El verify de mentira falla mientras quede un `let` en los tests, como el lint del repo.
      verify: "! grep -rqs 'let ' tests",
    });
    writeFiles(featureWt, { "src/csv.js": "x", "src/permiso.js": "403" });
    await commitAll(featureWt, "feat: implementado", {}, deps.env);
    expect(await verificar(contextFor(run, "verificar", deps))).toEqual({ tipo: "ok" });
    const content = readFileSync(join(featureWt, "tests/ac1.mjs"), "utf8");
    expect(content).toContain('const ruta = "src/csv.js";');
    expect(readPlan(run).locked["tests/ac1.mjs"]).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect(gitOut(featureWt, "log", "-1", "--format=%s")).toBe(
      "test: lint y formato de los tests de criterios",
    );
    expect(readLog(run.dir).events).toContainEqual(
      expect.objectContaining({ tipo: "aviso", fase: "verificar" }),
    );
  });

  // Si regresiona, un criterio se pone verde porque alguien ablandó su test.
  test("un byte cambiado en un test bloqueado detiene como invariante, con el archivo", async () => {
    const { run, featureWt, deps } = await featureWith({
      "src/csv.js": "x",
      "src/permiso.js": "403",
    });
    writeFileSync(join(featureWt, "tests/ac2.mjs"), "process.exit(0);\n");
    expect(await verificar(contextFor(run, "verificar", deps))).toEqual({
      tipo: "falla",
      clase: "invariante",
      motivo:
        "el test bloqueado tests/ac2.mjs cambió desde que lo escribió planificar: lo tiene que mirar una persona",
    });
  });

  test("criterios verdes y verify rojo: vuelve con todas las sub-tasks y la salida de verify", async () => {
    const { run, deps } = await featureWith(
      { "src/csv.js": "x", "src/permiso.js": "403", "src/roto.txt": "x" },
      'if [ -f src/roto.txt ]; then echo "lint: 2 errores" >&2; exit 1; fi',
    );
    // La base tenía verify verde: el verify rojo llega con lo integrado.
    const outcome = await verificar(contextFor(run, "verificar", deps));
    expect(outcome).toMatchObject({ tipo: "vuelve", unidades: ["ST-1", "ST-2"] });
    expect(outcome.tipo === "vuelve" && outcome.motivo).toMatch(/lint: 2 errores/);
  });

  // Si regresiona, un verify rojo por un archivo de una sola sub-task le devuelve trabajo a todas.
  test("verify rojo en un archivo con dueño: vuelve solo esa sub-task", async () => {
    const { run, deps } = await featureWith(
      { "src/csv.js": "x", "src/permiso.js": "403" },
      'if [ -f src/permiso.js ]; then echo "src/permiso.js:1:1  error  falta punto y coma" >&2; exit 1; fi',
    );
    const outcome = await verificar(contextFor(run, "verificar", deps));
    expect(outcome).toMatchObject({ tipo: "vuelve", unidades: ["ST-2"] });
  });

  // Regresión: en CUENTAS-1, dos seeds que llamaban a una función que cambió rompían el typecheck y no
  // estaban en ningún alcance. Devolver trabajo a implementar se iba a repetir hasta agotar intentos.
  test("verify rojo solo en archivos sin dueño: se detiene con el archivo y cómo replanificar", async () => {
    const { run, deps } = await featureWith(
      { "src/csv.js": "x", "src/permiso.js": "403" },
      'if [ -f src/csv.js ]; then echo "src/seeds/seed-nomina.js(213,5): error TS18047: usuario is possibly null" >&2; exit 1; fi',
      { "src/seeds/seed-nomina.js": "usar(usuario);\n" },
    );
    const outcome = await verificar(contextFor(run, "verificar", deps));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(outcome.tipo === "falla" && outcome.motivo).toContain(
      "verify está en rojo por src/seeds/seed-nomina.js, y ningún archivo de esos está en el alcance de una sub-task",
    );
    expect(outcome.tipo === "falla" && outcome.motivo).toContain(
      `flowrunner rerun ${run.id} --desde planificar`,
    );
  });
});

describe("namedFiles", () => {
  // Si regresiona, la salida de tsc dentro de un paquete del monorepo no se atribuye a ningún archivo.
  test("reconoce rutas con línea, absolutas o relativas a un paquete, y no lo que no es del repo", async () => {
    const repo = repoWith({
      "apps/api/src/seeds/seed-nomina.ts": "x\n",
      "apps/api/src/usuarios/usuarios.service.ts": "x\n",
      "README.md": "x\n",
    });
    const output = [
      "src/seeds/seed-nomina.ts(213,5): error TS18047",
      `${repo}/apps/api/src/usuarios/usuarios.service.ts:168:3 error`,
      "README.md sin línea no cuenta",
      "node_modules/x/index.js:1:1 tampoco, no es del repo",
    ].join("\n");
    expect((await namedFiles(output, repo, process.env)).sort()).toEqual([
      "apps/api/src/seeds/seed-nomina.ts",
      "apps/api/src/usuarios/usuarios.service.ts",
    ]);
  });
});
