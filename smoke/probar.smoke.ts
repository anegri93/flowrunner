// Smoke de la fase probar: con el SDK real y el Chrome de la máquina, el agente usa una app de
// juguete por la API y por el navegador, y la evidencia queda en el run: el log de la API y el video.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { featureWorktree } from "../src/phases/inputs.ts";
import { probar, lastTestDir, readTests } from "../src/phases/probar.ts";
import type { QueryFn } from "../src/runner/types.ts";
import { responds } from "../src/probar/entorno.ts";
import { plannedRun } from "../test/helpers/planned.ts";
import { PLAN } from "../test/helpers/plan-fixtures.ts";
import { contextFor, testDeps } from "../test/helpers/project.ts";
import { freePort } from "../test/helpers/puerto.ts";

const app = (port: number) => `const http = require("node:http");
http.createServer((q, r) => {
  if (q.url === "/api/saludo") {
    if (require("node:fs").existsSync("caido")) {
      r.statusCode = 503;
      return r.end("el servicio de saludo no responde");
    }
    r.setHeader("content-type", "application/json");
    return r.end(JSON.stringify({ saludo: "hola" }));
  }
  r.setHeader("content-type", "text/html");
  r.end('<h1>Inicio</h1><button onclick="document.getElementById(\\'m\\').textContent=\\'Hola, mundo\\'">Saludar</button><p id="m"></p>');
}).listen(${String(port)}, "127.0.0.1");
`;

const FEATURE = `---
clave: TOY-1
proyecto: toy
titulo: Saludo
---
## Descripción
La app saluda por la API y en la pantalla de inicio.

## Criterios
- AC-1: GET /api/saludo responde 200 con {"saludo":"hola"}.
- AC-2: en la pantalla de inicio, al tocar «Saludar» aparece «Hola, mundo».
- AC-3: con el servicio de saludo caído, GET /api/saludo responde 503.
`;

// Si regresiona, probar no llega a usar la feature, no puede probar el camino de error (KMS-1), deja
// la falla puesta, o la persona se queda sin un video que se entienda (ADR 0016 y 0017).
test("una sesión real prueba la API, la pantalla y una falla declarada, y deja el log, el video y todo restaurado", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const deps = testDeps({
    query: query as QueryFn,
    env: { ...process.env, FLOWRUNNER_AUTH: "login" },
  });
  const { run } = await plannedRun(
    { ...PLAN, criterios: [] },
    {},
    deps,
    {
      files: { "app.cjs": app(port) },
      config: {
        setup: "true",
        tests_globs: ["tests/**"],
        models: { probar: { model: "claude-haiku-5-5", effort: "low" } },
        probar: {
          levantar: "node app.cjs",
          sigue_corriendo: true,
          urls: { app: url },
          fallas: {
            saludo_caido: {
              que: "el servicio de saludo deja de responder",
              simular: "touch caido",
              restaurar: "rm -f caido",
            },
          },
        },
      },
    },
    FEATURE,
  );
  const outcome = await probar(contextFor(run, "probar", deps));
  expect(outcome).toEqual({ tipo: "ok" });
  const dir = lastTestDir(run) ?? "";
  const { pruebas, videos } = readTests(dir);
  expect(pruebas?.pruebas.map((p) => [p.criterio, p.resultado])).toEqual([
    ["AC-1", "ok"],
    ["AC-2", "ok"],
    ["AC-3", "ok"],
  ]);
  const fallas = readFileSync(join(dir, "fallas.md"), "utf8");
  expect(fallas).toContain("## simular saludo_caido");
  expect(existsSync(join(featureWorktree(run), "caido"))).toBe(false);
  expect(readFileSync(join(dir, "guion-del-video.js"), "utf8")).toContain("window.flowrunner");
  expect(readFileSync(join(dir, "http.md"), "utf8")).toContain(`GET ${url}/api/saludo`);
  expect(videos.length).toBeGreaterThan(0);
  expect(Math.max(...videos.map((v) => statSync(v).size))).toBeGreaterThan(1_000);
  // El entorno y el navegador quedaron abajo.
  expect(await responds(url)).toBe(false);
  const chrome = execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(dir));
  expect(chrome).toEqual([]);
}, 600_000);
