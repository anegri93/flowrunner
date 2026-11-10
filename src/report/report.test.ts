import { describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STREAMS } from "../../test/helpers/fake-query.ts";
import { tempDir } from "../../test/helpers/git.ts";
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
const uso = (fase: Phase, costo: number, modelo = "m"): RunEvent =>
  ev({
    tipo: "uso",
    fase,
    sesion: `${fase}-1`,
    modelo,
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

// Si regresiona, la PR llega sin decir que cambia una regla vigente, y se mergea sin verlo.
test("la PR arranca con lo que cambia de lo existente: lo aceptado al aprobar y lo que nadie declaró", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "cambios-existentes.json"),
    JSON.stringify([{ que: "el alta acepta <gmail>", donde: "src/alta.ts:12", criterio: "AC-1" }]),
  );
  const body = prBody(
    [
      ev({
        tipo: "aviso",
        fase: "implementar",
        texto:
          "test existente cambiado: ST-2 cambió tests/viejo.test.ts, que ya existía y el plan aprobado no declaraba",
      }),
      ev({
        tipo: "aviso",
        fase: "implementar",
        texto:
          "test existente cambiado: ST-2 cambió tests/viejo.test.ts, que ya existía y el plan aprobado no declaraba",
      }),
    ],
    { id: "R", home: "/nada", dir, worktrees: "/nada" },
  );
  expect(body.startsWith("## ⚠ Cambia lo que ya existe")).toBe(true);
  expect(body).toContain(
    "- el alta acepta &lt;gmail&gt; (`src/alta.ts:12`) ← AC-1. Aceptado al aprobar.",
  );
  expect(
    body.match(/\*\*Sin declarar en el plan:\*\* ST-2 cambió tests\/viejo\.test\.ts/g),
  ).toHaveLength(1);
});

test("sin cambios a lo existente, la PR arranca por los criterios como siempre", () => {
  const body = prBody([], { id: "R", home: "/nada", dir: tempDir(), worktrees: "/nada" });
  expect(body.startsWith("## Criterios")).toBe(true);
});

// Si regresiona, el informe no dice qué modelo corrió cada fase y no se puede comparar costo con modelo.
test("cada fase con sesiones nombra sus modelos; las que no tienen sesión no nombran ninguno", () => {
  const report = buildReport(
    [
      created,
      ...step("preparar", { tipo: "ok" }),
      uso("implementar", 1, "claude-sonnet-5-5"),
      uso("implementar", 1, "claude-opus-5-5"),
      uso("implementar", 1, "claude-sonnet-5-5"),
      ...step("implementar", { tipo: "ok" }),
    ],
    run,
  );
  expect(report).toContain("1 ejecución, modelos claude-sonnet-5-5, claude-opus-5-5\n");
  expect(report).toMatch(/- \*\*preparar:\*\* [^\n]*1 ejecución\n/);
});

// Si regresiona, la persona recibe la PR sin saber cómo probar a mano lo que implementa.
test("el informe y la PR traen el paso a paso de la revisión para probarlo", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "review.json"),
    JSON.stringify({
      hallazgos: [],
      decisiones: [],
      como_probar: ["Levantá la API con `pnpm dev`", "curl localhost:3000/a <b>"],
    }),
  );
  const paths = { id: "R", home: "/nada", dir, worktrees: "/nada" };
  const expected =
    "## Cómo probarlo\n\n1. Levantá la API con `pnpm dev`\n2. curl localhost:3000/a &lt;b&gt;";
  expect(buildReport([created], paths)).toContain(expected);
  expect(prBody([], paths)).toContain(expected);
});

// Si regresiona, la persona no ve qué probó flowrunner en el entorno ni encuentra el video para validarlo.
test("el informe trae las pruebas en el entorno con su evidencia; la PR, sin rutas locales", () => {
  const dir = tempDir();
  const tests = join(dir, "pruebas", "probar-1");
  mkdirSync(join(tests, "video"), { recursive: true });
  writeFileSync(join(tests, "http.md"), "## GET /\n");
  writeFileSync(join(tests, "video", "page@1.webm"), "");
  writeFileSync(
    join(tests, "pruebas.json"),
    JSON.stringify({
      pruebas: [
        {
          criterio: "AC-1",
          que: "crear una cuenta",
          pasos: ["POST /cuentas"],
          resultado: "falla",
          evidencia: "500",
          subtarea: "ST-1",
        },
      ],
      decisiones: [],
    }),
  );
  const paths = { id: "R", home: "/nada", dir, worktrees: "/nada" };
  const results =
    "## Pruebas en el entorno\n\n- ❌ **AC-1** crear una cuenta\n    1. POST /cuentas\n    - Evidencia: 500";
  const report = buildReport([created], paths);
  expect(report).toContain(results);
  expect(report).toContain(`- [Video page@1.webm](file://${tests}/video/page@1.webm)`);
  expect(report).toContain(`- [Log de la API](file://${tests}/http.md)`);
  const body = prBody([], paths);
  expect(body).toContain(results);
  expect(body).not.toContain("file://");
});

// Si regresiona, la PR no dice que se entregó con criterios sin probar ni por qué (ADR 0017).
test("si la persona aceptó entregar sin probar, el informe y la PR lo dicen con su motivo", () => {
  const dir = tempDir();
  const tests = join(dir, "pruebas", "probar-1");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(tests, "pruebas.json"),
    JSON.stringify({
      pruebas: [
        {
          criterio: "AC-2",
          que: "el job nocturno",
          pasos: [],
          resultado: "no_probado",
          evidencia: "no hay forma de dispararlo en el entorno",
          subtarea: "",
        },
      ],
      decisiones: [],
    }),
  );
  const paths = { id: "R", home: "/nada", dir, worktrees: "/nada" };
  const aceptado = ev({ tipo: "sin_probar_aceptado", motivo: "lo cubre el e2e del cron" });
  const aviso =
    "> ⚠️ Se entregó con criterios sin probar, por decisión de la persona: lo cubre el e2e del cron";
  expect(buildReport([created, aceptado], paths)).toContain(aviso);
  expect(prBody([created, aceptado], paths)).toContain(aviso);
  expect(prBody([created], paths)).not.toContain("Se entregó con criterios sin probar");
});

// Si regresiona, la PR se aprueba sin saber que la persona dejó pasar un rojo o lo arregló a mano, o
// lista una respuesta que el run ignoró porque otra llegó antes.
test("el informe y la PR listan lo que aceptaste, con su fase y su motivo", () => {
  const dir = tempDir();
  const tests = join(dir, "pruebas", "probar-1");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(tests, "pruebas.json"),
    JSON.stringify({
      pruebas: [
        {
          criterio: "AC-2",
          que: "el job nocturno",
          pasos: [],
          resultado: "no_probado",
          evidencia: "no hay cómo dispararlo",
          subtarea: "",
        },
      ],
      decisiones: [],
    }),
  );
  const paths = { id: "R", home: "/nada", dir, worktrees: "/nada" };
  const sinProbar: Outcome = { tipo: "falla", clase: "sin_probar", motivo: "AC-2 sin probar" };
  const events = [
    { ...created, vueltas: 0 } as RunEvent,
    ...(["preparar", "planificar", "aprobar", "implementar"] as const).flatMap((f) =>
      step(f, { tipo: "ok" }),
    ),
    ...step("verificar", { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-3 en rojo" }),
    ev({ tipo: "aceptado", fase: "verificar", motivo: "AC-3 es flaky en CI", origen: "terminal" }),
    // Llegó después de la primera: el run ya estaba en revisar y la ignoró.
    ev({ tipo: "aceptado", fase: "verificar", motivo: "la segunda", origen: "orca" }),
    ...step("revisar", { tipo: "ok" }),
    ...step("probar", sinProbar),
    ev({ tipo: "arreglo_manual_iniciado", origen: "terminal", base: "abc1234" }),
    ev({ tipo: "arreglo_manual", sha: "abc1234def5678" }),
    ...step("verificar", { tipo: "ok" }),
    ...step("revisar", { tipo: "ok" }),
    ...step("probar", sinProbar),
    ev({ tipo: "aceptado", fase: "probar", motivo: "lo cubre el e2e del cron", origen: "orca" }),
  ];
  const section = [
    "## Lo que aceptaste al seguir",
    "",
    "- en verificar: AC-3 es flaky en CI",
    "- arreglo a mano: abc1234",
    "- en probar: lo cubre el e2e del cron",
  ].join("\n");
  const report = buildReport(events, paths);
  const pr = prBody(events, paths);
  expect(report).toContain(section);
  expect(pr).toContain(section);
  expect(report).not.toContain("la segunda");
  // El aviso de probar toma el `accept` de probar, como el de `accept-untested`.
  const aviso =
    "> ⚠️ Se entregó con criterios sin probar, por decisión de la persona: lo cubre el e2e del cron";
  expect(report).toContain(aviso);
  expect(pr).toContain(aviso);
  expect(buildReport([created], paths)).not.toContain("Lo que aceptaste al seguir");
});

/** Un evento a una hora fija del 9/11, en UTC: la demora se mide entre dos de estos. */
const atHour = (e: NewEvent, hora: string): RunEvent => ({ ...e, at: `2026-11-09T${hora}.000Z` });
/** Un run que llegó a esperar tu aprobación a las 01:07:36. */
const waitingForYou = (): RunEvent[] => [
  created,
  ...step("preparar", { tipo: "ok" }),
  ...step("planificar", { tipo: "ok" }),
  atHour({ tipo: "accion_iniciada", fase: "aprobar" }, "01:07:35"),
  atHour({ tipo: "accion_terminada", fase: "aprobar", resultado: { tipo: "espera" } }, "01:07:36"),
];

// Si regresiona, no se puede saber de dónde vino una aprobación ni cuánto se miró el plan antes: en
// VF-6 hubo cuatro, entre 6 y 64 s después del plan listo, y ninguna decía si salió de Orca.
test("el informe dice de dónde vino cada decisión y cuánto tardó", () => {
  const fromOrca = [
    ...waitingForYou(),
    atHour({ tipo: "aprobado", cambios_aceptados: 7, origen: "orca" }, "01:07:51"),
  ];
  const report = buildReport(fromOrca, run);
  expect(report).toContain("## Tus decisiones");
  expect(report).toContain(
    "aprobaste el plan desde orca, 15 s después de que te esperó (7 cambios aceptados)",
  );
  // Es para la persona: la PR no lo lleva.
  expect(prBody(fromOrca, run)).not.toContain("Tus decisiones");
  // Un log de antes de esta PR no tiene `origen`.
  const old = [...waitingForYou(), atHour({ tipo: "aprobado" }, "01:07:51")];
  expect(buildReport(old, run)).toContain("aprobaste el plan desde un origen desconocido");
  expect(buildReport(waitingForYou(), run)).not.toContain("Tus decisiones");
});

// Si regresiona, el informe lista como tuya una respuesta que el run ignoró porque otra llegó antes, o
// mide la demora de una respuesta a una pregunta desde una espera que no era la suya.
test("Tus decisiones lista solo las que el run tomó, con la demora desde que te esperó", () => {
  const events = [
    { ...waitingForYou()[0], vueltas: 0 } as RunEvent,
    ...waitingForYou().slice(1),
    atHour(
      { tipo: "cambios_pedidos", motivo: "separá la validación", origen: "claude" },
      "01:07:37",
    ),
    // Llegó cuando el run ya planificaba de nuevo: el engine la ignoró.
    atHour({ tipo: "aprobado", origen: "orca" }, "01:07:40"),
    atHour({ tipo: "accion_iniciada", fase: "planificar" }, "01:08:00"),
    atHour({ tipo: "accion_terminada", fase: "planificar", resultado: { tipo: "ok" } }, "01:10:00"),
    atHour({ tipo: "accion_iniciada", fase: "aprobar" }, "01:10:01"),
    atHour(
      { tipo: "accion_terminada", fase: "aprobar", resultado: { tipo: "espera" } },
      "01:10:02",
    ),
    atHour({ tipo: "aprobado", origen: "terminal" }, "01:11:06"),
    atHour({ tipo: "accion_iniciada", fase: "implementar" }, "01:11:07"),
    atHour(
      { tipo: "accion_terminada", fase: "implementar", resultado: { tipo: "ok" } },
      "01:20:00",
    ),
    atHour({ tipo: "accion_iniciada", fase: "verificar" }, "01:20:01"),
    atHour(
      {
        tipo: "accion_terminada",
        fase: "verificar",
        resultado: { tipo: "vuelve", unidades: ["ST-1"], motivo: "AC-3 en rojo" },
      },
      "01:21:00",
    ),
    atHour(
      { tipo: "aceptado", fase: "verificar", motivo: "AC-3 es flaky", origen: "orca" },
      "01:21:03",
    ),
    // La segunda respuesta a la misma pregunta: el run ya estaba en revisar.
    atHour(
      { tipo: "aceptado", fase: "verificar", motivo: "la segunda", origen: "claude" },
      "01:21:09",
    ),
  ];
  const section = buildReport(events, run).split("## Tus decisiones")[1]?.split("\n## ")[0] ?? "";
  const lines = section.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(
    /^- \d\d:\d\d:\d\d · pediste cambios desde claude, 1 s después de que te esperó: «separá la validación»$/,
  );
  expect(lines[1]).toMatch(
    /· aprobaste el plan desde terminal, 1 min 4 s después de que te esperó$/,
  );
  expect(lines[2]).toMatch(
    /· aceptaste seguir con verificar en rojo desde orca, 3 s después de que te esperó: «AC-3 es flaky»$/,
  );
});
