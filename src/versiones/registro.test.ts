// `npmRegistro` contra un `npm` falso en el PATH: sin red, y con lo que devuelve el npm de verdad.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { esFallaDeRed } from "../engine/motivos.ts";
import { npmRegistro } from "./registro.ts";

/** Un PATH con un `npm` que corre `script` y nada más. */
function conNpm(script: string): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "fr-npm-"));
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh\n${script}\n`);
  chmodSync(npm, 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
}
const cwd = tmpdir();

describe("npmRegistro", () => {
  test("lee versiones, engines, deprecadas y latest; con una sola versión npm devuelve un objeto", async () => {
    const lista = conNpm(`cat <<'EOF'
[{"version":"1.9.1","engines":{"node":">=22"},"dist-tags":{"latest":"2.1.0"}},
 {"version":"2.0.0","engines":["node >= 0.4"],"deprecated":"usá la 2.1","dist-tags":{"latest":"2.1.0"}}]
EOF`);
    expect(await npmRegistro(lista)("unpdf", cwd)).toEqual({
      tipo: "ok",
      versiones: [
        { version: "1.9.1", node: ">=22", deprecada: false },
        { version: "2.0.0", deprecada: true },
      ],
      latest: "2.1.0",
    });
    const una = conNpm(`echo '{"version":"0.1.0","dist-tags":{"latest":"0.1.0"}}'`);
    expect(await npmRegistro(una)("x", cwd)).toEqual({
      tipo: "ok",
      versiones: [{ version: "0.1.0", deprecada: false }],
      latest: "0.1.0",
    });
  });

  test("E404 es un paquete que no existe; «No match found», uno sin versiones estables", async () => {
    const noExiste = conNpm(
      `echo '{"error":{"code":"E404","summary":"Not Found - GET https://registry.npmjs.org/x"}}'; exit 1`,
    );
    expect(await npmRegistro(noExiste)("x", cwd)).toEqual({ tipo: "no_existe" });
    const sinEstables = conNpm(
      `echo '{"error":{"code":"E404","summary":"No match found for version >=0.0.0"}}'; exit 1`,
    );
    expect(await npmRegistro(sinEstables)("x", cwd)).toEqual({ tipo: "ok", versiones: [] });
  });

  // Si regresiona, un registro colgado cuelga el run, o su corte no espera como uno de red.
  test("un registro que no responde corta en el plazo, con un motivo que el engine trata como red", async () => {
    // `exec`: que el proceso que se corta sea el mismo que tiene la salida abierta, como npm.
    const colgado = conNpm("exec sleep 30");
    const start = Date.now();
    const error = await npmRegistro(colgado, 300)("unpdf", cwd).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(Error);
    const motivo = (error as Error).message;
    expect(motivo).toContain("no respondió");
    expect(esFallaDeRed(motivo)).toBe(true);
    const sinRed = conNpm(
      `echo '{"error":{"code":"ENOTFOUND","summary":"request to https://registry.npmjs.org/unpdf failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org"}}'; exit 1`,
    );
    const offline = await npmRegistro(sinRed)("unpdf", cwd).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
    expect(esFallaDeRed(offline)).toBe(true);
  });
});
