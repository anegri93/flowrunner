import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { freePort } from "../../test/helpers/puerto.ts";
import { GUION_DEL_VIDEO } from "./guion-del-video.ts";
import { fallasServer, httpRequest } from "./herramientas.ts";

// Si regresiona, el agente llega a cualquier URL, o el log de evidencia guarda un token.
test("el pedido solo llega al entorno y queda en el log con las cabeceras secretas tapadas", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const server = createServer((q, r) => {
    r.statusCode = 201;
    r.setHeader("content-type", "application/json");
    q.on("data", () => undefined).on("end", () => r.end('{"id":7}'));
  }).listen(port, "127.0.0.1");
  const log = join(tempDir("fr-http-"), "http.md");
  try {
    const out = await httpRequest(
      {
        method: "post",
        url: `${base}/cuentas`,
        headers: { authorization: "Bearer secreto123", "content-type": "application/json" },
        body: '{"correo":"a@b.c"}',
      },
      [base],
      log,
    );
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^201 Created[\s\S]*\{"id":7\}$/);
    const written = readFileSync(log, "utf8");
    expect(written).toContain(`## POST ${base}/cuentas`);
    expect(written).toContain('{"correo":"a@b.c"}');
    expect(written).toContain("authorization: ***");
    expect(written).not.toContain("secreto123");

    const outside = await httpRequest({ method: "GET", url: "https://example.com/" }, [base], log);
    expect(outside).toEqual({
      ok: false,
      text: `https://example.com/ está fuera del entorno: solo se puede pedir a ${base}`,
    });
    expect(readFileSync(log, "utf8")).not.toContain("example.com");
  } finally {
    server.close();
  }
});

describe("fallas", () => {
  const preparar = () => {
    const cwd = tempDir("fr-fallas-");
    const fallas = fallasServer(
      {
        kms_colgado: {
          que: "KMS no contesta",
          simular: "echo puesta > estado.txt",
          restaurar: "echo sana > estado.txt",
        },
        rota: { que: "no se puede restaurar", simular: "true", restaurar: "exit 3" },
      },
      { cwd, env: process.env, log: join(cwd, "fallas.md") },
    );
    return { cwd, fallas, estado: () => readFileSync(join(cwd, "estado.txt"), "utf8").trim() };
  };

  // Si regresiona, el agente corre un comando que el repo no escribió (ADR 0016 y 0017).
  test("el agente elige el nombre, no el comando: un nombre que no está no corre nada", async () => {
    const { cwd, fallas } = preparar();
    const out = await fallas.simular("rm -rf /");
    expect(out).toEqual({
      ok: false,
      text: 'no hay una falla "rm -rf /": las que declaró el repo son kms_colgado, rota',
    });
    expect(existsSync(join(cwd, "fallas.md"))).toBe(false);
  });

  test("simular y restaurar corren lo declarado y quedan en el log", async () => {
    const { cwd, fallas, estado } = preparar();
    expect(await fallas.simular("kms_colgado")).toEqual({
      ok: true,
      text: "puesta: kms_colgado (KMS no contesta)",
    });
    expect(estado()).toBe("puesta");
    expect((await fallas.restaurar("kms_colgado")).ok).toBe(true);
    expect(estado()).toBe("sana");
    const log = readFileSync(join(cwd, "fallas.md"), "utf8");
    expect(log).toContain("## simular kms_colgado\n\n`echo puesta > estado.txt` → ok");
    expect(log).toContain("## restaurar kms_colgado");
  });

  // Si regresiona, un run deja a LocalStack pausado y el entorno de la persona sin KMS.
  test("al bajar se restaura lo que quedó puesto, y se informa lo que no se pudo restaurar", async () => {
    const { fallas, estado } = preparar();
    await fallas.simular("kms_colgado");
    await fallas.simular("rota");
    const fallidas = await fallas.restaurarTodas();
    expect(estado()).toBe("sana");
    expect(fallidas).toHaveLength(1);
    expect(fallidas[0]).toMatch(/^no se pudo restaurar rota/);
    expect(await fallas.restaurarTodas()).toEqual([fallidas[0]]);
  });
});

// Si regresiona, el script del navegador tira un error de sintaxis y el video vuelve a ser ilegible.
test("el guion del video es JavaScript válido y define las ayudas del agente", () => {
  expect(() => new Script(GUION_DEL_VIDEO)).not.toThrow();
  for (const ayuda of ["placa(", "rotulo(", "veredicto("]) expect(GUION_DEL_VIDEO).toContain(ayuda);
  expect(GUION_DEL_VIDEO).toContain('scrollIntoView({ block: "center"');
});
