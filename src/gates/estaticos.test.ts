import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith } from "../../test/helpers/git.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import { chequeosEstaticos, type EstaticosInput } from "./estaticos.ts";
import type { Plan } from "./plan.ts";

const feature = {
  clave: "SHOP-214",
  proyecto: "acme",
  titulo: "Exportar",
  descripcion: "x",
  criterios: [{ id: "AC-1", text: "csv" }],
  aclaraciones: [],
  fueraDeAlcance: [],
} satisfies Feature;

const config = repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"] });

const plan: Plan = {
  plan: "p",
  subtareas: [
    {
      id: "ST-1",
      titulo: "csv",
      descripcion: "csv",
      alcance: ["src/"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

/** Un worktree con un test existente; `desde` y `base` son su único commit. */
function worktree() {
  const dir = repoWith({ "src/a.js": "x\n", "tests/viejo.mjs": "process.exit(0);\n" });
  const head = git(dir, "rev-parse", "HEAD");
  const input = (over: Partial<EstaticosInput> = {}): EstaticosInput => ({
    plan,
    feature,
    worktree: dir,
    base: head,
    desde: head,
    config,
    env: process.env,
    esVerify: () => false,
    ...over,
  });
  return { dir, input };
}

describe("chequeos estáticos", () => {
  // Si regresiona, el gate de afuera y validar_plan dejan de ver lo mismo, o en otro orden: el
  // planificador corrige lo que le dijo la herramienta y el gate lo rechaza por otra cosa.
  test("los chequeos estáticos devuelven los mismos problemas que hoy daba el gate, en su orden", async () => {
    const { dir, input } = worktree();
    writeFileSync(join(dir, "tests/viejo.mjs"), "process.exit(1);\n");
    expect(await chequeosEstaticos(input())).toEqual([
      "el plan cambia tests/viejo.mjs, un test que ya existe, y no lo declara en cambia_lo_existente. Declaralo con qué cambia, dónde y qué criterio lo obliga, o dejalo como está",
      "el plan declara el test tests/ac1.mjs, pero no está escrito",
    ]);
  });

  // Si regresiona, la forma se chequea con el `esVerify` por defecto, que rechaza todo criterio del
  // run: validar_plan le diría al planificador que asigne el verify a una sub-task, y el gate no.
  test("la forma usa el esVerify que recibe: un criterio del run con el verify no es un problema", async () => {
    const { dir, input } = worktree();
    writeFileSync(join(dir, "tests/ac1.mjs"), "process.exit(1);\n");
    const delRun: Plan = {
      ...plan,
      criterios: [{ id: "AC-1", comando: "./.flowrunner/verify.sh", subtarea: "run" }],
    };
    expect(
      await chequeosEstaticos(input({ plan: delRun, esVerify: (c) => c.endsWith("verify.sh") })),
    ).toEqual([]);
    expect(await chequeosEstaticos(input({ plan: delRun }))).toEqual([
      "AC-1 es del run, pero solo un criterio cuyo comando es el verify del repo puede serlo: asignalo a la sub-task que lo cubre",
    ]);
  });

  // Si regresiona, un `conserva` inválido pasa los chequeos estáticos y solo lo frena el resto del gate.
  test("con conserva, sus problemas van después de los tests declarados sin escribir", async () => {
    const { input } = worktree();
    const conservaPlan: Plan = {
      ...plan,
      subtareas: plan.subtareas.map((t) => ({ ...t, conserva: true })),
    };
    expect(
      await chequeosEstaticos(
        input({
          plan: conservaPlan,
          conserva: {
            plan: conservaPlan,
            anteriores: [],
            candidatas: [],
            pedidos: [],
            llamadores: new Map(),
          },
        }),
      ),
    ).toEqual([
      "planificar no escribió ningún test",
      "el plan declara el test tests/ac1.mjs, pero no está escrito",
      "ST-1 tiene conserva: true pero no estaba implementada: sacale conserva o dejala como nueva",
      "ST-1 cambió su alcance (antes: (no estaba); ahora: src): no se puede conservar",
    ]);
  });

  // Si regresiona, un test que escribió una sub-task conservada cuenta como existente: lo que existía
  // se mide contra la base, no contra donde empiezan los tests.
  test("un test del alcance que no estaba en la base no es existente, aunque esté antes de desde", async () => {
    const { dir, input } = worktree();
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "tests/conservado.mjs"), "process.exit(0);\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "conservada");
    const desde = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "tests/ac1.mjs"), "process.exit(1);\n");
    const scoped: Plan = {
      ...plan,
      subtareas: plan.subtareas.map((t) => ({ ...t, alcance: ["src/", "tests/conservado.mjs"] })),
    };
    expect(await chequeosEstaticos(input({ plan: scoped, base, desde }))).toEqual([]);
  });
});
