import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith } from "../../test/helpers/git.ts";
import { llamarHerramienta as llamar } from "../../test/helpers/mcp.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import type { Plan } from "./plan.ts";
import type { ConservaInput } from "./conserva.ts";
import { respuestaValidar, sacadasDeLaRama, validarPlanServer } from "./validar-plan.ts";

const feature = {
  clave: "SHOP-214",
  proyecto: "acme",
  titulo: "Exportar",
  descripcion: "x",
  criterios: [
    { id: "AC-1", text: "csv" },
    { id: "AC-2", text: "en verde" },
  ],
  aclaraciones: [],
  fueraDeAlcance: [],
} satisfies Feature;

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
  criterios: [
    { id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" },
    { id: "AC-2", comando: "./.flowrunner/verify.sh", subtarea: "run" },
  ],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

function server() {
  const dir = repoWith({ "src/a.js": "x\n" });
  const head = git(dir, "rev-parse", "HEAD");
  mkdirSync(join(dir, "tests"));
  return {
    dir,
    gate: validarPlanServer({
      feature,
      worktree: dir,
      base: head,
      desde: head,
      config: repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"] }),
      env: process.env,
      esVerify: (c) => c === "./.flowrunner/verify.sh",
    }),
  };
}

describe("validar_plan", () => {
  // Si regresiona, el planificador recibe un texto que no le dice qué corregir, o una falla de la
  // herramienta en vez de los problemas, y deja de validar.
  test("sin problemas responde ok; con problemas, la lista y que vuelva a validar", async () => {
    expect(respuestaValidar([])).toBe(
      "ok: el plan pasa los chequeos que no corren nada. Al devolverlo, el gate además corre el comando de cada criterio, y tiene que fallar.",
    );
    expect(respuestaValidar(["uno"])).toBe(
      "El plan tiene 1 problema:\n- uno\nCorregilos y volvé a validar antes de devolver el plan.",
    );
    expect(respuestaValidar(["uno", "dos"])).toBe(
      "El plan tiene 2 problemas:\n- uno\n- dos\nCorregilos y volvé a validar antes de devolver el plan.",
    );

    const { dir, gate } = server();
    const sinTests = await llamar(gate, "validar_plan", plan);
    expect(sinTests.isError).toBe(false);
    expect(sinTests.content[0]?.text).toBe(
      respuestaValidar([
        "planificar no escribió ningún test",
        "el plan declara el test tests/ac1.mjs, pero no está escrito",
      ]),
    );
    writeFileSync(join(dir, "tests/ac1.mjs"), "process.exit(1);\n");
    const ok = await llamar(gate, "validar_plan", plan);
    expect(ok.isError).toBe(false);
    expect(ok.content[0]?.text).toBe(respuestaValidar([]));
  });

  // Si regresiona, un git que falla en medio de los chequeos llega al planificador como una falla de la
  // herramienta, y el paso 8 del prompt lo deja reintentando en vez de devolver el plan al gate.
  test("si los chequeos no se pueden correr, lo dice sin dar error: el gate de afuera chequea igual", async () => {
    const dir = repoWith({ "src/a.js": "x\n" });
    const gate = validarPlanServer({
      feature,
      worktree: dir,
      base: "no-existe",
      desde: "no-existe",
      config: repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"] }),
      env: process.env,
      esVerify: () => false,
    });
    const r = await llamar(gate, "validar_plan", plan);
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toMatch(
      /^no se pudo validar el plan \(.+\): el gate de afuera lo chequea igual al devolverlo\.$/s,
    );
  });

  // Si regresiona, validar_plan rechaza el criterio de verify que el planificador dejó en una sub-task,
  // que el gate de afuera pasa al run sin rechazar: el planificador lo corrige por nada.
  test("aplica delRun antes de chequear, como el gate de afuera", async () => {
    const { dir, gate } = server();
    writeFileSync(join(dir, "tests/ac1.mjs"), "process.exit(1);\n");
    const enOtra = {
      ...plan,
      criterios: [plan.criterios[0], { ...plan.criterios[1], subtarea: "ST-9" }],
    };
    const r = await llamar(gate, "validar_plan", enOtra);
    expect(r.content[0]?.text).toBe(respuestaValidar([]));
  });

  // Si regresiona, validar_plan juzga llamadores y tests sobre una rama que el gate va a rearmar (falsos
  // problemas que deforman el plan), o se los saltea cuando el gate chequea la misma rama.
  test("los llamadores y los tests se chequean solo si el gate va a ver la misma rama", () => {
    const st = (id: string, conserva?: boolean) => ({
      id,
      titulo: id,
      descripcion: id,
      alcance: [`src/${id}/`],
      dependencias: [],
      depende_de: [],
      ...(conserva === undefined ? {} : { conserva }),
    });
    const conserva = (marcadas: string[], anteriores = ["ST-1", "ST-2"]): ConservaInput => ({
      plan: {
        subtareas: ["ST-1", "ST-2"].map((id) => st(id, marcadas.includes(id))),
        cambia_lo_existente: [],
      },
      anteriores: anteriores.map((id) => st(id)),
      candidatas: [
        { id: "ST-1", shas: ["a"] },
        { id: "ST-2", shas: ["b"] },
      ],
      pedidos: [],
      llamadores: new Map(),
    });
    // Fuera de un replan: la misma rama.
    expect(sacadasDeLaRama([], undefined)).toBeUndefined();
    // Candidatas y ninguna conservada: el gate saca todas.
    expect(sacadasDeLaRama(["ST-1", "ST-2"], undefined)).toEqual(["ST-1", "ST-2"]);
    // Todas conservadas: la misma rama.
    expect(sacadasDeLaRama(["ST-1", "ST-2"], conserva(["ST-1", "ST-2"]))).toBeUndefined();
    // Alguna sin conservar: el gate la saca.
    expect(sacadasDeLaRama(["ST-1", "ST-2"], conserva(["ST-1"]))).toEqual(["ST-2"]);
    // Inválido (ST-2 no estaba en el plan anterior): la rama depende de cómo se corrija.
    expect(sacadasDeLaRama(["ST-1", "ST-2"], conserva(["ST-1", "ST-2"], ["ST-1"]))).toEqual([
      "ST-2",
    ]);
    // Inválido por una que no es candidata (ST-3 no estaba implementada), con las dos candidatas bien:
    // el gate no rearma ahora, pero el plan corregido puede hacerlo.
    const conST3 = conserva(["ST-1", "ST-2"]);
    expect(
      sacadasDeLaRama(["ST-1", "ST-2"], {
        ...conST3,
        plan: { ...conST3.plan, subtareas: [...conST3.plan.subtareas, st("ST-3", true)] },
      }),
    ).toEqual([]);
  });
});
