import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { freePort, serverScript } from "../../test/helpers/puerto.ts";
import { levantarEntorno, responds, type ProbarConfig } from "./entorno.ts";

const config = (port: number, extra: Partial<ProbarConfig> = {}): ProbarConfig => ({
  levantar: "node server.cjs",
  urls: { api: `http://127.0.0.1:${String(port)}` },
  env_files: [],
  notas: "",
  espera_segundos: 20,
  ...extra,
});

function setup(port: number) {
  const worktree = tempDir("fr-entorno-");
  const repo = tempDir("fr-repo-");
  writeFileSync(join(worktree, "server.cjs"), serverScript(port));
  return { worktree, repo, log: join(tempDir("fr-pruebas-"), "entorno.log"), env: process.env };
}

describe("levantarEntorno", () => {
  // Si regresiona, probar corre contra el entorno que ya tenía la persona y da verde sin la feature.
  test("si algo ya responde en una URL, no levanta nada y dice cuál", async () => {
    const port = await freePort();
    const other = createServer((_, r) => r.end("otro")).listen(port, "127.0.0.1");
    try {
      const out = await levantarEntorno({ ...setup(port), probar: config(port) });
      expect(out.tipo).toBe("falla");
      expect(out.tipo === "falla" && out.motivo).toContain(
        `ya hay algo respondiendo en http://127.0.0.1:${String(port)}`,
      );
    } finally {
      other.close();
    }
  });

  // Si regresiona, el entorno queda vivo después de probar, o no tiene los .env que no están en git.
  test("copia los archivos de fuera de git, espera a que responda y al bajar no queda nada", async () => {
    const port = await freePort();
    const s = setup(port);
    writeFileSync(join(s.repo, ".env"), "CLAVE=1\n");
    const out = await levantarEntorno({
      ...s,
      probar: config(port, { env_files: [".env"] }),
    });
    expect(out.tipo).toBe("ok");
    expect(readFileSync(join(s.worktree, ".env"), "utf8")).toBe("CLAVE=1\n");
    expect(await responds(`http://127.0.0.1:${String(port)}`)).toBe(true);
    if (out.tipo !== "ok") return;
    expect(await out.entorno.bajar()).toEqual([]);
    expect(await responds(`http://127.0.0.1:${String(port)}`)).toBe(false);
  });

  // Si regresiona, un `levantar` roto se espera hasta el timeout y el motivo no dice por qué.
  test("si levantar sale con error, falla enseguida con el final de su salida", async () => {
    const port = await freePort();
    const started = Date.now();
    const out = await levantarEntorno({
      ...setup(port),
      probar: config(port, { levantar: "echo falta la base de datos >&2; exit 3" }),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.tipo === "falla" && out.motivo).toMatch(/salió 3[\s\S]*falta la base de datos/);
  });

  test("un archivo de fuera de git que no está en el repo falla sin levantar", async () => {
    const port = await freePort();
    const s = setup(port);
    const out = await levantarEntorno({ ...s, probar: config(port, { env_files: [".env"] }) });
    expect(out).toEqual({ tipo: "falla", motivo: `.env no existe en ${s.repo}` });
    expect(existsSync(s.log)).toBe(false);
  });
});
