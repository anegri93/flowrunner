import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannedRun } from "../../test/helpers/planned.ts";
import { freePort, serverScript } from "../../test/helpers/puerto.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { simQuery } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import { responds } from "../probar/entorno.ts";
import { readLog } from "../store/run-log.ts";
import { lastTestDir, probar, type Pruebas } from "./probar.ts";

const plan: Plan = {
  plan: "dos sub-tasks",
  subtareas: ["ST-1", "ST-2"].map((id) => ({
    id,
    titulo: id,
    descripcion: id,
    alcance: [`src/${id}/`],
    dependencias: [],
    depende_de: [],
  })),
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

const prueba = (extra: Partial<Pruebas["pruebas"][number]>): Pruebas["pruebas"][number] => ({
  criterio: "AC-1",
  que: "crear una cuenta",
  pasos: ["POST /cuentas con un correo"],
  resultado: "ok",
  evidencia: "201 {id: 7}",
  subtarea: "",
  ...extra,
});

async function testWith(output: Pruebas | undefined, withConfig = true) {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const sim = simQuery([{ output }]);
  const deps = testDeps({ query: sim.query });
  const { run } = await plannedRun(plan, { "tests/ac1.mjs": "process.exit(0);\n" }, deps, {
    files: { "server.cjs": serverScript(port) },
    ...(withConfig
      ? {
          config: {
            setup: "true",
            tests_globs: ["tests/**"],
            probar: { levantar: "node server.cjs", urls: { api: url }, notas: "usuario demo" },
          },
        }
      : {}),
  });
  const outcome = await probar(contextFor(run, "probar", deps));
  return { outcome, sim, run, url };
}

describe("probar", () => {
  // Si regresiona, la PR se abre aunque la feature no haga en el entorno lo que dice el criterio.
  test("una prueba en falla devuelve su sub-task con la evidencia, y el entorno queda abajo", async () => {
    const { outcome, sim, run, url } = await testWith({
      pruebas: [
        prueba({ resultado: "falla", evidencia: "500 Internal Server Error", subtarea: "ST-2" }),
      ],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "vuelve", unidades: ["ST-2"] });
    const dir = lastTestDir(run) ?? "";
    expect(outcome.tipo === "vuelve" && outcome.motivo).toContain(
      `- ST-2 · AC-1 crear una cuenta: 500 Internal Server Error\nLa evidencia, con el log de la API y el video, está en ${dir}`,
    );
    expect(existsSync(join(dir, "pruebas.json"))).toBe(true);
    expect(await responds(url)).toBe(false);
    // La sesión recibe el entorno y las dos herramientas, y nada que corra comandos.
    const [record] = sim.records;
    expect(record?.prompt).toContain(`- api: ${url}`);
    expect(record?.prompt).toContain("usuario demo");
    expect(Object.keys(record?.options?.mcpServers ?? {})).toEqual(["navegador", "http"]);
    expect(record?.options?.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  test("todo en verde avanza; lo que no se pudo probar queda como aviso", async () => {
    const { outcome, run } = await testWith({
      pruebas: [
        prueba({}),
        prueba({ criterio: "AC-2", resultado: "no_probado", evidencia: "no hay usuario admin" }),
      ],
      decisiones: [],
    });
    expect(outcome).toEqual({ tipo: "ok" });
    expect(readLog(run.dir).events).toContainEqual(
      expect.objectContaining({
        tipo: "aviso",
        texto: "no se pudo probar AC-2 (crear una cuenta): no hay usuario admin",
      }),
    );
  });

  test("una falla que nombra una sub-task que no existe es un gate", async () => {
    const { outcome } = await testWith({
      pruebas: [prueba({ resultado: "falla", subtarea: "ST-9" })],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
  });

  // Si regresiona, un repo sin entorno configurado queda trabado en probar.
  test("sin `probar` en la config se saltea con un aviso y sin sesión", async () => {
    const { outcome, sim, run } = await testWith(undefined, false);
    expect(outcome).toEqual({ tipo: "ok" });
    expect(sim.records).toHaveLength(0);
    expect(readFileSync(join(run.dir, "events.jsonl"), "utf8")).toContain("probar se salteó");
  });
});
