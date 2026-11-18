// `flowrunner orca install` con un CLI de Orca falso que registra lo que recibe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli, TEST_BIN } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";

const PLUGIN = join(import.meta.dirname, "..", "orca");

function env(orca = join(TEST_BIN, "orca")): NodeJS.ProcessEnv {
  return { HOME: tempDir("orca-home-"), PATH: process.env.PATH ?? "", ORCA: orca };
}
const calls = (e: NodeJS.ProcessEnv) =>
  readFileSync(join(e.HOME ?? "", "orca.log"), "utf8")
    .trim()
    .split("\n");

describe("orca install", () => {
  // Si regresiona, la instalación vuelve a depender de dónde se clonó flowrunner, y un repo mudado
  // deja a Orca sin la pestaña de flowrunner.
  test("carga el plugin de la carpeta de este flowrunner y muestra el fingerprint que pide Orca", () => {
    const e = env();
    const result = runCli(["orca", "install"], e);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--approve ap1-test");
    expect(calls(e)).toEqual([`plugin dev load ${PLUGIN}`]);
  });

  test("con --approve le pasa el fingerprint a Orca y sale 0", () => {
    const e = env();
    expect(runCli(["orca", "install", "--approve", "ap1-test"], e).status).toBe(0);
    expect(calls(e)).toEqual([`plugin dev load ${PLUGIN} --approve ap1-test`]);
  });

  test("sin el CLI de Orca dice dónde lo buscó", () => {
    const result = runCli(["orca", "install"], env("/no/existe/orca"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no encontré el CLI de Orca en /no/existe/orca");
  });
});

interface TareaJson {
  nombre: string;
  estado: string;
  mensaje: string;
  siguiente: string | null;
}

/** Las tareas hasta que la del plugin termina; el proceso de fondo escribe su estado al salir. */
async function esperarTarea(e: NodeJS.ProcessEnv): Promise<TareaJson> {
  const hasta = Date.now() + 30_000;
  for (;;) {
    const out = runCli(["tareas", "--json"], e);
    const { tareas } = JSON.parse(out.stdout) as { tareas: TareaJson[] };
    const tarea = tareas.find((t) => t.nombre === "orca-install");
    if (tarea !== undefined && tarea.estado !== "corriendo") return tarea;
    if (Date.now() > hasta) throw new Error(`la tarea no terminó: ${out.stdout}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("orca install --fondo", () => {
  // Si regresiona, el botón del panel no dice qué correr cuando Orca pide aprobar el plugin, o lo
  // aprueba solo.
  test("corre aparte y, si Orca pide aprobarlo, deja el --approve para correr en la terminal", async () => {
    // El osascript falso: el aviso del final no sale en el escritorio de quien corre los tests.
    const e = { ...env(), PATH: `${TEST_BIN}:${process.env.PATH ?? ""}` };
    const started = runCli(["orca", "install", "--fondo", "--json"], e);
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ ok: true, tarea: "orca-install" });
    expect(await esperarTarea(e)).toMatchObject({
      estado: "falla",
      siguiente: "flowrunner orca install --approve ap1-test",
    });
    expect(calls(e)).toEqual([`plugin dev load ${PLUGIN}`]);
  });

  test("--approve con --fondo se rechaza: aprobar es de la persona", () => {
    const result = runCli(["orca", "install", "--fondo", "--approve", "ap1-test", "--json"], env());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("aprobar el plugin lo hacés vos en la terminal");
  });
});
