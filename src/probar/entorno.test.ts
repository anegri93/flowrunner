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
  servicios: {},
  env_files: [],
  sigue_corriendo: true,
  notas: "",
  espera_segundos: 20,
  fallas: {},
  navegador_visible: false,
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

  // Si regresiona, el entorno queda vivo después de probar, no tiene los .env que no están en git, o
  // sus secretos quedan en el worktree donde después leen revisar y las sub-tasks.
  test("copia los archivos de fuera de git, espera a que responda y al bajar no queda nada", async () => {
    const port = await freePort();
    const s = setup(port);
    writeFileSync(join(s.repo, ".env"), "CLAVE=1\n");
    writeFileSync(join(s.repo, "propio.env"), "DEL_REPO=1\n");
    writeFileSync(join(s.worktree, "propio.env"), "DEL_WORKTREE=1\n");
    const out = await levantarEntorno({
      ...s,
      probar: config(port, { env_files: [".env", "propio.env"] }),
    });
    expect(out.tipo).toBe("ok");
    expect(readFileSync(join(s.worktree, ".env"), "utf8")).toBe("CLAVE=1\n");
    expect(await responds(`http://127.0.0.1:${String(port)}`)).toBe(true);
    if (out.tipo !== "ok") return;
    expect(await out.entorno.bajar()).toEqual([]);
    expect(await responds(`http://127.0.0.1:${String(port)}`)).toBe(false);
    expect(existsSync(join(s.worktree, ".env"))).toBe(false);
    // Lo que ya estaba en el worktree no se pisa ni se borra.
    expect(readFileSync(join(s.worktree, "propio.env"), "utf8")).toBe("DEL_WORKTREE=1\n");
  });

  // Si regresiona, probar arranca con las URLs arriba mientras levantar todavía prepara datos, como
  // la sesión de prueba de mango, y el agente no los encuentra.
  test("si levantar termina, espera a que termine aunque las URLs ya respondan", async () => {
    const port = await freePort();
    const s = setup(port);
    const out = await levantarEntorno({
      ...s,
      probar: config(port, {
        levantar: "node server.cjs & sleep 2; echo listo > listo.txt",
        sigue_corriendo: false,
      }),
    });
    expect(out.tipo).toBe("ok");
    expect(existsSync(join(s.worktree, "listo.txt"))).toBe(true);
    if (out.tipo === "ok") await out.entorno.bajar();
  });

  test("un levantar que no termina sin `sigue_corriendo` falla con cómo arreglarlo", async () => {
    const port = await freePort();
    const out = await levantarEntorno({
      ...setup(port),
      probar: config(port, { sigue_corriendo: false, espera_segundos: 3 }),
    });
    expect(out.tipo === "falla" && out.motivo).toContain("poné `sigue_corriendo: true`");
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

  // Si regresiona, un repo con un servicio compartido ya prendido, como el Supabase local que usan los
  // e2e de los criterios, no puede probar nunca; o bajar el entorno avisa que el servicio quedó vivo.
  test("un servicio que ya responde no frena levantar ni cuenta como vivo al bajar", async () => {
    const port = await freePort();
    const shared = await freePort();
    const supabase = createServer((_, r) => r.end("supabase")).listen(shared, "127.0.0.1");
    try {
      const out = await levantarEntorno({
        ...setup(port),
        probar: config(port, { servicios: { supabase: `http://127.0.0.1:${String(shared)}` } }),
      });
      expect(out.tipo).toBe("ok");
      if (out.tipo !== "ok") return;
      expect(await out.entorno.bajar()).toEqual([]);
      expect(await responds(`http://127.0.0.1:${String(shared)}`)).toBe(true);
    } finally {
      supabase.close();
    }
  });

  // Si regresiona, probar arranca sin el servicio y el agente marca sin probar lo que necesitaba de él.
  test("si un servicio no responde, levantar falla y dice cuál", async () => {
    const port = await freePort();
    const shared = await freePort();
    const out = await levantarEntorno({
      ...setup(port),
      probar: config(port, {
        servicios: { correo: `http://127.0.0.1:${String(shared)}` },
        espera_segundos: 3,
      }),
    });
    expect(out.tipo === "falla" && out.motivo).toContain(
      `el entorno no respondió en 3 s (http://127.0.0.1:${String(shared)})`,
    );
    expect(await responds(`http://127.0.0.1:${String(port)}`)).toBe(false);
  });

  test("un archivo de fuera de git que no está en el repo falla sin levantar", async () => {
    const port = await freePort();
    const s = setup(port);
    const out = await levantarEntorno({ ...s, probar: config(port, { env_files: [".env"] }) });
    expect(out).toEqual({ tipo: "falla", motivo: `.env no existe en ${s.repo}` });
    expect(existsSync(s.log)).toBe(false);
  });
});
