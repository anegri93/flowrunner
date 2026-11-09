import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STREAMS } from "../../test/helpers/fake-query.ts";
import type { NewEvent, Outcome, Phase, RunEvent } from "../store/events.ts";
import { runPaths } from "../store/runs.ts";
import { buildReport, prBody } from "./report.ts";
import { transcriptSteps } from "./transcript.ts";

let clock = Date.parse("2026-11-07T10:00:00Z");
const ev = (e: NewEvent, minutes = 0): RunEvent => {
  clock += minutes * 60_000;
  return { ...e, at: new Date(clock).toISOString() };
};
const step = (fase: Phase, resultado: Outcome, minutes = 1): RunEvent[] => [
  ev({ tipo: "accion_iniciada", fase }),
  ev({ tipo: "accion_terminada", fase, resultado }, minutes),
];
const uso = (fase: Phase, costo: number): RunEvent =>
  ev({
    tipo: "uso",
    fase,
    sesion: `${fase}-1`,
    modelo: "m",
    costo_usd: costo,
    tokens_entrada: 100,
    tokens_salida: 50,
    duracion_ms: 1,
  });
const run = runPaths("/tmp/no-existe", "SHOP-214-x");
const created = ev({
  tipo: "run_creado",
  run_id: "SHOP-214-x",
  clave: "SHOP-214",
  proyecto: "acme",
  repo: "/r",
  budget_usd: 25,
});

describe("buildReport", () => {
  // Si regresiona, la persona tiene que leer los transcripts para saber qué pasó en su run.
  test("un run completo trae la PR, decisiones, costo y duración por fase, rechazos y avisos", () => {
    const events = [
      created,
      ...step("preparar", { tipo: "ok" }),
      uso("planificar", 1.2),
      ev({ tipo: "decision", fase: "planificar", que: "reusar formatMoney", por_que: "ya existe" }),
      ...step("planificar", { tipo: "ok" }, 9),
      ...step("aprobar", { tipo: "espera" }),
      ev({ tipo: "aprobado" }),
      ev({
        tipo: "rechazo",
        fase: "implementar",
        unidad: "ST-2",
        herramienta: "Write",
        motivo: "src/billing/x.ts está fuera del alcance de ST-2",
      }),
      ...step("implementar", { tipo: "ok" }, 14),
      ...step("verificar", { tipo: "ok" }),
      ev({ tipo: "aviso", fase: "revisar", texto: "src/a.ts:3: nombre poco claro" }),
      ...step("revisar", { tipo: "ok" }),
      ev({ tipo: "pr", url: "https://github.com/acme/acme-api/pull/412", numero: 412 }),
      ...step("entregar", { tipo: "ok" }),
    ];
    const report = buildReport(events, run);
    expect(report).toContain("- **Estado:** entregado");
    expect(report).toContain("- **PR:** https://github.com/acme/acme-api/pull/412");
    expect(report).toContain("### planificar\n\n- reusar formatMoney: ya existe");
    expect(report).toContain("- **planificar:** 9.0 min, USD 1.20, 150 tokens, 1 ejecución");
    expect(report).toContain("- ST-2 · Write: src/billing/x.ts está fuera del alcance de ST-2");
    expect(report).toContain("## Avisos de la revisión\n\n- src/a.ts:3: nombre poco claro");
  });

  // Si regresiona, un run detenido no dice qué pasó ni cómo seguir.
  test("un run detenido en verificar trae el motivo y el comando para seguir", () => {
    const events = [
      created,
      ...step("preparar", { tipo: "ok" }),
      ...step("planificar", { tipo: "ok" }),
      ...step("aprobar", { tipo: "ok" }),
      ...step("implementar", { tipo: "ok" }),
      ...step("verificar", {
        tipo: "falla",
        clase: "invariante",
        motivo: "el test bloqueado tests/a.mjs cambió",
      }),
    ];
    const report = buildReport(events, run);
    expect(report).toContain("## Se detuvo\n\nverificar: el test bloqueado tests/a.mjs cambió");
    expect(report).toContain("Para seguir: `flowrunner resume SHOP-214-x`");
  });

  test("las fallas de infraestructura y de gate aparecen separadas", () => {
    const events = [
      created,
      ...step("preparar", { tipo: "ok" }),
      ...step("planificar", { tipo: "falla", clase: "gate", motivo: "AC-1 ya pasa" }),
      ...step("planificar", { tipo: "falla", clase: "infra", motivo: "timeout de la sesión" }),
    ];
    const report = buildReport(events, run);
    expect(report).toMatch(/## Reintentos por gate\n\n- planificar: AC-1 ya pasa/);
    expect(report).toMatch(/## Fallas de infraestructura\n\n- planificar: timeout de la sesión/);
  });

  // Si regresiona, un texto escrito por un modelo se interpreta como HTML al mostrar el informe.
  test("un texto de modelo con HTML aparece como texto", () => {
    const events = [
      created,
      ev({
        tipo: "decision",
        fase: "planificar",
        que: "<script>alert(1)</script>",
        por_que: "a & b",
      }),
    ];
    const report = buildReport(events, run);
    expect(report).not.toContain("<script>");
    expect(report).toContain("&lt;script&gt;alert(1)&lt;/script&gt;: a &amp; b");
  });
});

describe("transcriptSteps", () => {
  test("una sesión grabada se lee como pasos: herramientas, resultados, el rechazo y el final", () => {
    const steps = transcriptSteps(
      readFileSync(join(STREAMS, "bash-permitido-y-negado.jsonl"), "utf8"),
    );
    const tools = steps.filter((s) => s.tipo === "herramienta").map((s) => s.texto);
    expect(tools.some((t) => t.startsWith("Bash") && t.includes("node --test"))).toBe(true);
    expect(
      steps.some((s) => s.tipo === "resultado" && s.texto.includes("fuera de la lista permitida")),
    ).toBe(true);
    expect(steps.at(-1)?.tipo).toBe("final");
  });
});

// Si regresiona, un test de criterios que flowrunner cambió llega a la PR sin que la persona lo vea.
test("la PR lista lo que flowrunner cambió en los tests de criterios", () => {
  const body = prBody(
    [
      ev({
        tipo: "aviso",
        fase: "verificar",
        texto:
          "flowrunner reparó el test bloqueado tests/a.ts: let por const. El cambio está en su propio commit; revisalo en la PR.",
      }),
      ev({ tipo: "aviso", fase: "revisar", texto: "src/a.ts:3: nombre poco claro" }),
    ],
    { id: "R", home: "/nada", dir: "/nada", worktrees: "/nada" },
  );
  expect(body).toContain("## Cambios de flowrunner en los tests de criterios");
  expect(body).toContain("- flowrunner reparó el test bloqueado tests/a.ts: let por const.");
  expect(body).not.toContain("nombre poco claro");
});
