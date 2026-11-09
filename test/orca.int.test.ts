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
