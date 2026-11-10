import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith } from "../../test/helpers/git.ts";
import { llamarHerramienta as llamar } from "../../test/helpers/mcp.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import type { Plan } from "./plan.ts";
import { respuestaValidar, validarPlanServer } from "./validar-plan.ts";

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
});
