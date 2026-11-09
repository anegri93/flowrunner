import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
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

async function testWith(
  output: Pruebas | undefined,
  withConfig = true,
  probarExtra: Record<string, unknown> = {},
) {
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
            probar: {
              levantar: "node server.cjs",
              sigue_corriendo: true,
              urls: { api: url },
              notas: "usuario demo",
              ...probarExtra,
            },
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

  test("todo probado y en verde avanza", async () => {
    const { outcome } = await testWith({
      pruebas: [prueba({}), prueba({ criterio: "AC-2" })],
      decisiones: [],
    });
    expect(outcome).toEqual({ tipo: "ok" });
  });

  // Si regresiona, la PR se abre con criterios que nadie probó: en KMS-1 fueron 9 de 10 (ADR 0017).
  test("un criterio sin probar detiene el run con qué faltó, en vez de seguir a entregar", async () => {
    const { outcome, run } = await testWith({
      pruebas: [
        prueba({}),
        prueba({ criterio: "AC-2", resultado: "no_probado", evidencia: "no hay usuario admin" }),
      ],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "falla", clase: "sin_probar" });
    const dir = lastTestDir(run) ?? "";
    expect(outcome.tipo === "falla" && outcome.motivo).toBe(
      `1 de 2 criterios quedaron sin probar:\n- AC-2 (crear una cuenta): no hay usuario admin\nLa evidencia de lo que sí se probó está en ${dir}`,
    );
    expect(readLog(run.dir).events).toContainEqual(
      expect.objectContaining({
        tipo: "aviso",
        texto: "no se pudo probar AC-2 (crear una cuenta): no hay usuario admin",
      }),
    );
  });

  // Primero se arregla el código: lo que no se pudo probar se mira cuando probar vuelva a correr.
  test("con una falla y un criterio sin probar, gana la falla y vuelve a implementar", async () => {
    const { outcome } = await testWith({
      pruebas: [
        prueba({ resultado: "falla", evidencia: "500", subtarea: "ST-1" }),
        prueba({ criterio: "AC-2", resultado: "no_probado", evidencia: "falta un dato" }),
      ],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "vuelve", unidades: ["ST-1"] });
  });

  test("una falla que nombra una sub-task que no existe es un gate", async () => {
    const { outcome } = await testWith({
      pruebas: [prueba({ resultado: "falla", subtarea: "ST-9" })],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
  });

  // Si regresiona, el agente no tiene cómo probar un criterio de error (KMS-1) o el video sale sin guion.
  test("con fallas declaradas la sesión las recibe por nombre, y el navegador sale con ventana y guion", async () => {
    const { sim, run } = await testWith({ pruebas: [prueba({})], decisiones: [] }, true, {
      fallas: {
        kms_colgado: { que: "KMS no contesta", simular: "true", restaurar: "true" },
      },
      navegador_visible: true,
    });
    const [record] = sim.records;
    expect(Object.keys(record?.options?.mcpServers ?? {})).toEqual(["navegador", "http", "fallas"]);
    expect(record?.prompt).toContain("- `kms_colgado`: KMS no contesta");
    expect(record?.prompt).not.toContain("echo");
    const dir = lastTestDir(run) ?? "";
    const navegador = JSON.parse(readFileSync(join(dir, "navegador.json"), "utf8")) as {
      browser: { launchOptions: { headless: boolean }; initScript: string[] };
    };
    expect(navegador.browser.launchOptions.headless).toBe(false);
    expect(navegador.browser.initScript).toEqual([join(dir, "guion-del-video.js")]);
    expect(readFileSync(join(dir, "guion-del-video.js"), "utf8")).toContain(
      "window.flowrunner = {",
    );
  });

  // Si regresiona, el navegador no llega al Supabase o al Mailpit del repo: sin fotos, sin tiempo real
  // y sin el código de ingreso, el agente no puede probar nada que pida entrar.
  test("los servicios llegan al navegador y al prompt junto a las URLs", async () => {
    const port = await freePort();
    const correo = createServer((_, r) => r.end("mailpit")).listen(port, "127.0.0.1");
    try {
      const { sim, run } = await testWith({ pruebas: [prueba({})], decisiones: [] }, true, {
        servicios: { correo: `http://127.0.0.1:${String(port)}/api/v1` },
      });
      const dir = lastTestDir(run) ?? "";
      const navegador = JSON.parse(readFileSync(join(dir, "navegador.json"), "utf8")) as {
        network: { allowedOrigins: string[] };
      };
      expect(navegador.network.allowedOrigins).toContain(`http://127.0.0.1:${String(port)}`);
      expect(sim.records[0]?.prompt).toContain(`- correo: http://127.0.0.1:${String(port)}/api/v1`);
    } finally {
      correo.close();
    }
  });

  // Si regresiona, un repo sin entorno configurado queda trabado en probar.
  test("sin `probar` en la config se saltea con un aviso y sin sesión", async () => {
    const { outcome, sim, run } = await testWith(undefined, false);
    expect(outcome).toEqual({ tipo: "ok" });
    expect(sim.records).toHaveLength(0);
    expect(readFileSync(join(run.dir, "events.jsonl"), "utf8")).toContain("probar se salteó");
  });
});
