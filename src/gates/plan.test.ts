import { describe, expect, test } from "vitest";
import { repoWith } from "../../test/helpers/git.ts";
import type { Feature } from "../feature/feature.ts";
import { checkCommandsFail, checkPlanShape, type Plan, type Subtask } from "./plan.ts";

const feature = {
  clave: "SHOP-214",
  proyecto: "acme",
  titulo: "Exportar",
  descripcion: "x",
  criterios: [
    { id: "AC-1", text: "csv" },
    { id: "AC-2", text: "403" },
  ],
  aclaraciones: [],
  fueraDeAlcance: [],
} satisfies Feature;

const rules = { lockfiles: ["pnpm-lock.yaml"], manifests: ["package.json"] };

const task = (id: string, alcance: string[], extra: Partial<Subtask> = {}): Subtask => ({
  id,
  titulo: id,
  descripcion: id,
  alcance,
  dependencias: [],
  depende_de: [],
  ...extra,
});

function plan(
  subtareas: Subtask[],
  criterios = [
    { id: "AC-1", comando: "false", subtarea: "ST-1" },
    { id: "AC-2", comando: "false", subtarea: "ST-2" },
  ],
): Plan {
  return { plan: "p", subtareas, criterios, tests: ["tests/ac.test.ts"], decisiones: [] };
}

const repo = repoWith({ "src/a.ts": "x\n" });
const shape = (p: Plan) => checkPlanShape(p, feature, repo, rules);

describe("forma del plan", () => {
  test("un plan bien formado no tiene problemas", () => {
    expect(
      shape(plan([task("ST-1", ["src/export/"]), task("ST-2", ["src/auth/roles.ts"])])),
    ).toEqual([]);
  });

  // Si regresiona, un criterio queda sin nadie que lo implemente ni comando que lo verifique.
  test("un criterio sin comando o que apunta a una sub-task inexistente: rechazado", () => {
    const p = plan(
      [task("ST-1", ["src/x.ts"])],
      [{ id: "AC-1", comando: "false", subtarea: "ST-9" }],
    );
    expect(shape(p)).toEqual([
      "AC-1 apunta a ST-9, que no existe",
      "AC-2 no tiene comando ni sub-task",
    ]);
  });

  // Caso real de enrich en SELECTIA: la carpeta de una migración nueva todavía no existe.
  test("una ruta nueva en una carpeta inexistente es válida; una que escapa del repo, no", () => {
    expect(
      shape(
        plan([
          task("ST-1", ["db/migrations/202611070001_export/migration.sql"]),
          task("ST-2", ["src/b.ts"]),
        ]),
      ),
    ).toEqual([]);
    expect(shape(plan([task("ST-1", ["../otro/x.ts"]), task("ST-2", ["src/b.ts"])]))).toEqual([
      'ST-1: "../otro/x.ts" queda fuera del repo',
    ]);
  });

  test("un glob en el alcance: rechazado", () => {
    expect(shape(plan([task("ST-1", ["src/**/*.ts"]), task("ST-2", ["src/b.ts"])]))[0]).toMatch(
      /es un glob/,
    );
  });

  // Si regresiona, dos sub-tasks en paralelo editan el mismo archivo y chocan al integrarse.
  test("dos sub-tasks paralelas con src/a/ y src/a/b.ts: rechazadas por pisarse", () => {
    expect(shape(plan([task("ST-1", ["src/a/"]), task("ST-2", ["src/a/b.ts"])]))).toEqual([
      "ST-1 y ST-2 pueden correr a la vez y sus alcances se pisan (src/a y src/a/b.ts): hacé que una dependa de la otra o separá los archivos",
    ]);
  });

  test("las mismas, con dependencia transitiva entre ellas: válidas", () => {
    const p = plan([
      task("ST-1", ["src/a/"]),
      task("ST-3", ["src/c.ts"], { depende_de: ["ST-1"] }),
      task("ST-2", ["src/a/b.ts"], { depende_de: ["ST-3"] }),
    ]);
    expect(shape(p)).toEqual([]);
  });

  test("dos sub-tasks paralelas que agregan dependencias: rechazadas por el lockfile", () => {
    const p = plan([
      task("ST-1", ["src/x.ts"], { dependencias: ["csv-stringify"] }),
      task("ST-2", ["src/y.ts"], { dependencias: ["zod"] }),
    ]);
    expect(shape(p)[0]).toMatch(/ST-1 y ST-2 pueden correr a la vez.*pnpm-lock\.yaml/);
  });

  test("un ciclo A→B→A: rechazado", () => {
    const p = plan([
      task("ST-1", ["src/x.ts"], { depende_de: ["ST-2"] }),
      task("ST-2", ["src/y.ts"], { depende_de: ["ST-1"] }),
    ]);
    expect(shape(p)).toEqual(["hay un ciclo de dependencias: ST-1 → ST-2 → ST-1"]);
  });
});

describe("los comandos de los criterios", () => {
  // Caso real de plan en SELECTIA-2: `tsx: command not found` no es un test en rojo.
  test("un comando que sale 127 se rechaza como no ejecutable", async () => {
    const p = plan(
      [task("ST-1", ["a"]), task("ST-2", ["b"])],
      [{ id: "AC-1", comando: "tsx tests/ac1.test.ts", subtarea: "ST-1" }],
    );
    const problems = await checkCommandsFail(p, repo, { PATH: "/usr/bin:/bin" });
    expect(problems[0]).toMatch(/AC-1 no se puede ejecutar \(exit 127\)/);
  });

  // Si regresiona, un criterio que ya pasaba se da por implementado sin que nadie haga nada.
  test("un comando que pasa antes de implementar se rechaza; uno que falla, pasa", async () => {
    const p = plan(
      [task("ST-1", ["a"]), task("ST-2", ["b"])],
      [
        { id: "AC-1", comando: "true", subtarea: "ST-1" },
        { id: "AC-2", comando: "test -f no-existe.txt", subtarea: "ST-2" },
      ],
    );
    expect(await checkCommandsFail(p, repo, process.env)).toEqual([
      "AC-1 ya pasa antes de implementar: `true` tiene que fallar",
    ]);
  });
});
