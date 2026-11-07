import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps, writeFiles } from "../../test/helpers/project.ts";
import type { Plan } from "../gates/plan.ts";
import { commitAll } from "../git/git.ts";
import { verificar } from "./verificar.ts";

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
};

const TESTS = {
  "tests/ac1.mjs":
    'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/csv.js") ? 0 : 1);\n',
  "tests/ac2.mjs":
    'import { readFileSync } from "node:fs";\nconsole.error("esperaba 403");\nprocess.exit(readFileSync("src/permiso.js", "utf8").includes("403") ? 0 : 1);\n',
};

async function featureWith(files: Record<string, string>, verify = "exit 0") {
  const deps = testDeps();
  const { run, featureWt } = await plannedRun(plan, TESTS, deps, { verify });
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
});
