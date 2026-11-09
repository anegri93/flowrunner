import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { freePort } from "../../test/helpers/puerto.ts";
import { httpRequest } from "./herramientas.ts";

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
