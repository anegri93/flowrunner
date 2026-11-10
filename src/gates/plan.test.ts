import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoWith } from "../../test/helpers/git.ts";
import type { Feature } from "../feature/feature.ts";
import {
  checkCommandsFail,
  checkPlanShape,
  delRun,
  subtaskSchema,
  type Plan,
  type Subtask,
} from "./plan.ts";

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
  return {
    plan: "p",
    subtareas,
    criterios,
    tests: ["tests/ac.test.ts"],
    decisiones: [],
    cambia_lo_existente: [],
  };
}

const repo = repoWith({ "src/a.ts": "x\n" });
const shape = (p: Plan) => checkPlanShape(p, feature, repo, rules);

describe("forma del plan", () => {
  // Regresión de VF-6: CLAUDE.md estaba en el alcance de ST-6; el bloqueo lo rechazó 11 veces y el run
  // replanificó cuatro, sin que nada lo frenara antes.
  test("una ruta que ningún agente escribe no puede estar en un alcance", () => {
    const p = plan([
      task("ST-1", ["src/a.ts", "CLAUDE.md"]),
      task("ST-2", [".claude/settings.json"]),
    ]);
    expect(shape(p)).toEqual([
      'ST-1: "CLAUDE.md" es parte de CLAUDE.md, que ningún agente escribe: sacalo del alcance. Si la feature lo necesita, va fuera del run, a mano',
      'ST-2: ".claude/settings.json" es parte de .claude, que ningún agente escribe: sacalo del alcance. Si la feature lo necesita, va fuera del run, a mano',
    ]);
    // Parecidos que no lo son: un CLAUDE.md en otra carpeta y .github.
    expect(
      shape(plan([task("ST-1", ["docs/CLAUDE.md"]), task("ST-2", [".github/ci.yml"])])),
    ).toEqual([]);
  });

  // Regresión: en CUENTAS-1 el planificador agregó «ST-5 Cierre: verify completo en verde», con la
  // unión de los alcances de las demás. Rehacía el trabajo de verificar desde una sub-task.
  test("una sub-task que abarca el alcance de otras dos es de cierre: rechazada", () => {
    const p = plan([
      task("ST-1", ["src/export/csv.ts"]),
      task("ST-2", ["src/auth/roles.ts"]),
      task("ST-3", ["src/export/", "src/auth/"], { depende_de: ["ST-1", "ST-2"] }),
    ]);
    expect(shape(p)).toEqual([
      "ST-3 abarca el alcance de ST-1, ST-2: una sub-task de cierre o de «verify en verde» no va, porque el verify de conjunto lo corre verificar sobre la rama integrada. Lo que haga falta cambiar va en la sub-task dueña de cada archivo",
    ]);
    // Abarcar una sola, como al extender lo que otra dejó, sigue valiendo.
    expect(
      shape(
        plan([
          task("ST-1", ["src/export/csv.ts"]),
          task("ST-2", ["src/export/"], { depende_de: ["ST-1"] }),
        ]),
      ),
    ).toEqual([]);
  });

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

  const VERIFY = "./.flowrunner/verify.sh";
  const esVerify = (comando: string) => comando === VERIFY;

  // Regresión de VF-6: «AC-12: verify.sh en verde» tenía que ir a una sub-task, y fue a ST-6, que no
  // era dueña de lo que se rompía. Un criterio de verify es del run: lo comprueba verificar.
  test("un criterio que corre el verify del repo es del run y no necesita sub-task", () => {
    const p = plan(
      [task("ST-1", ["src/x.ts"])],
      [
        { id: "AC-1", comando: "false", subtarea: "ST-1" },
        { id: "AC-2", comando: VERIFY, subtarea: "run" },
      ],
    );
    expect(checkPlanShape(p, feature, repo, rules, esVerify)).toEqual([]);
  });

  // Si regresiona, un criterio que no es el verify queda sin sub-task que lo implemente: ninguna lo
  // recibe en implementar y verificar lo devuelve a «run», que no existe.
  test("solo un criterio que corre el verify puede ser del run", () => {
    const p = plan(
      [task("ST-1", ["src/x.ts"])],
      [
        { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "run" },
        { id: "AC-2", comando: VERIFY, subtarea: "run" },
      ],
    );
    expect(checkPlanShape(p, feature, repo, rules, esVerify)).toEqual([
      "AC-1 es del run, pero solo un criterio cuyo comando es el verify del repo puede serlo: asignalo a la sub-task que lo cubre",
    ]);
  });

  test("delRun pasa los criterios de verify a run y deja los demás", () => {
    const p = plan(
      [task("ST-1", ["src/x.ts"]), task("ST-6", ["src/y.ts"])],
      [
        { id: "AC-12", comando: VERIFY, subtarea: "ST-6" },
        { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
      ],
    );
    expect(delRun(p, esVerify).criterios).toEqual([
      { id: "AC-12", comando: VERIFY, subtarea: "run" },
      { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
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
    for (const glob of ["src/**/*.ts", "src/a?.ts", "src/{a,b}.ts"]) {
      expect(shape(plan([task("ST-1", [glob]), task("ST-2", ["src/b.ts"])]))[0]).toMatch(
        /es un glob/,
      );
    }
  });

  // Regresión: en COMPARTIR-1 (rskate, Next.js) el gate rechazó `src/app/o/[publicId]/page.tsx`
  // como glob. Los corchetes son carpetas reales de rutas dinámicas en Next y SvelteKit, y el
  // planificador tuvo que rehacer el plan entero con un alcance más ancho.
  test("una ruta dinámica con corchetes es una ruta concreta", () => {
    expect(
      shape(
        plan([
          task("ST-1", ["src/app/o/[publicId]/page.tsx", "src/app/(comprador)/page.tsx"]),
          task("ST-2", ["src/app/docs/[...slug]/page.tsx", "src/app/[[...todo]]/page.tsx"]),
        ]),
      ),
    ).toEqual([]);
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

describe("las dependencias del plan", () => {
  const withDeps = (deps: Partial<Subtask>) =>
    subtaskSchema.safeParse({
      id: "ST-1",
      titulo: "t",
      descripcion: "d",
      alcance: ["src/"],
      dependencias: [],
      depende_de: [],
      ...deps,
    });

  // Si regresiona, un texto como «jsqr (devDependency)» llega pegado al comando de instalación y la sub-task se traba.
  test("una dependencia con aclaraciones se rechaza, con un motivo que dice dónde va la de desarrollo", () => {
    const result = withDeps({ dependencias: ["uqr", "jsqr (devDependency)"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("dependencias_dev");
  });

  test("acepta nombres con scope y versión, y las de desarrollo aparte", () => {
    expect(
      withDeps({ dependencias: ["@scope/qr", "jsqr@1.4.0"], dependencias_dev: ["@types/qrcode"] })
        .success,
    ).toBe(true);
    expect(withDeps({ dependencias_dev: ["jsqr; rm -rf /"] }).success).toBe(false);
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

  // Regresión: en COMPARTIR-1 (rskate) el criterio «verify en verde» pasaba sobre main, como debe, y
  // el gate lo rechazaba por no estar en rojo: una vuelta entera de planificar. Ese criterio lo
  // comprueba verificar, sobre la rama integrada.
  test("un criterio que el gate no debe correr en rojo no se corre", async () => {
    const dir = repoWith({ "a.txt": "x\n" });
    const p = plan(
      [task("ST-1", ["a"]), task("ST-2", ["b"])],
      [
        { id: "AC-1", comando: "touch corrio.txt", subtarea: "ST-1" },
        { id: "AC-2", comando: "test -f no-existe.txt", subtarea: "ST-2" },
      ],
    );
    expect(await checkCommandsFail(p, dir, process.env, (c) => c.startsWith("touch"))).toEqual([]);
    expect(existsSync(join(dir, "corrio.txt"))).toBe(false);
  });

  // Regresión: en COMPARTIR-1 (rskate) los cuatro criterios tenían el mismo `pnpm test:e2e` de una
  // spec entera, y el gate la corrió cuatro veces: 6 minutos en vez de 1,5.
  test("un comando que comparten varios criterios corre una vez, y cuenta para cada uno", async () => {
    const dir = repoWith({ "a.txt": "x\n" });
    const shared = "echo corrida >> corridas.log; exit 1";
    const p = plan(
      [task("ST-1", ["a"]), task("ST-2", ["b"])],
      [
        { id: "AC-1", comando: shared, subtarea: "ST-1" },
        { id: "AC-2", comando: shared, subtarea: "ST-2" },
      ],
    );
    expect(await checkCommandsFail(p, dir, process.env)).toEqual([]);
    expect(readFileSync(join(dir, "corridas.log"), "utf8")).toBe("corrida\n");

    const passing = "echo corrida >> pasa.log";
    const q = plan(
      [task("ST-1", ["a"]), task("ST-2", ["b"])],
      [
        { id: "AC-1", comando: passing, subtarea: "ST-1" },
        { id: "AC-2", comando: passing, subtarea: "ST-2" },
      ],
    );
    expect(await checkCommandsFail(q, dir, process.env)).toEqual([
      `AC-1 ya pasa antes de implementar: \`${passing}\` tiene que fallar`,
      `AC-2 ya pasa antes de implementar: \`${passing}\` tiene que fallar`,
    ]);
    expect(readFileSync(join(dir, "pasa.log"), "utf8")).toBe("corrida\n");
  });
});
