// `flowrunner report <run> --fase <fase>`: lo que el panel de Orca abre al tocar una etapa.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { showPhase } from "../src/cli/etapa.ts";
import { appendEvent } from "../src/store/run-log.ts";
import { plannedRun } from "./helpers/planned.ts";
import { PLAN } from "./helpers/plan-fixtures.ts";
import { testDeps } from "./helpers/project.ts";

const TESTS = { "tests/ac1.mjs": "process.exit(1);\n" };

describe("report --fase", () => {
  // Si regresiona, tocar una etapa en el panel no muestra cómo le fue: sus intentos, lo propio de la
  // etapa, ni lo que pasó en ella y no en otra.
  test("cada etapa trae sus intentos, lo propio y solo sus decisiones, rechazos, avisos y sesiones", async () => {
    const { run } = await plannedRun(PLAN, TESTS, testDeps());
    appendEvent(run.dir, {
      tipo: "decision",
      fase: "planificar",
      que: "node:fs",
      por_que: "sin deps",
    });
    appendEvent(run.dir, {
      tipo: "uso",
      fase: "implementar",
      unidad: "ST-1",
      sesion: "implementar-ST-1-1",
      modelo: "claude-sonnet-5-5",
      costo_usd: 0.42,
      tokens_entrada: 100,
      tokens_salida: 20,
      duracion_ms: 65_000,
    });
    appendEvent(run.dir, {
      tipo: "rechazo",
      fase: "implementar",
      unidad: "ST-1",
      herramienta: "Bash",
      motivo: "`rm -rf` no está en la lista",
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "iniciada",
    });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "integrada",
      sha: "abcdef1234567890",
    });
    appendEvent(run.dir, {
      tipo: "accion_terminada",
      fase: "implementar",
      resultado: { tipo: "ok" },
    });
    appendEvent(run.dir, { tipo: "accion_iniciada", fase: "revisar" });
    writeFileSync(
      join(run.dir, "review.json"),
      JSON.stringify({
        hallazgos: [
          {
            severidad: "bloqueante",
            archivo: "src/export/csv.js",
            linea: 3,
            afirmacion: "no escapa las comas <b>",
            regla: "convenciones: CSV con comillas",
            subtarea: "ST-1",
          },
        ],
        decisiones: [],
      }),
    );
    appendEvent(run.dir, {
      tipo: "accion_terminada",
      fase: "revisar",
      resultado: { tipo: "vuelve", unidades: ["ST-1"], motivo: "faltan comillas" },
    });

    const planning = showPhase(run.home, run.id, "planificar").texto;
    expect(planning).toContain("# SHOP-214 · Planificar");
    expect(planning).toContain("- **ST-1** Serializador CSV");
    expect(planning).toContain("- **AC-1** → ST-1: `node tests/ac1.mjs`");
    expect(planning).toContain("- `tests/ac1.mjs`");
    expect(planning).toContain("- node:fs: sin deps");
    expect(planning).not.toContain("implementar-ST-1-1");

    const implementing = showPhase(run.home, run.id, "implementar");
    expect(implementing.estado).toBe("ok");
    expect(implementing.texto).toContain("ok · ≥ $0.42 · claude-sonnet-5-5");
    expect(implementing.texto).toContain(
      "- **ST-1** Serializador CSV: integrada · 1 intento · commit abcdef1",
    );
    expect(implementing.texto).toContain("- ST-1 · Bash: `rm -rf` no está en la lista");
    expect(implementing.texto).toContain(
      "- `implementar-ST-1-1`: claude-sonnet-5-5, 1:05, ≥ $0.42, 120 tokens",
    );
    expect(implementing.texto).not.toContain("node:fs");

    const review = showPhase(run.home, run.id, "revisar");
    expect(review.estado).toBe("devolvió ST-1 a implementar");
    expect(review.texto).toContain(
      "- **bloqueante** `src/export/csv.js:3` (ST-1): no escapa las comas &lt;b&gt; · convenciones: CSV con comillas",
    );

    expect(showPhase(run.home, run.id, "entregar")).toMatchObject({ estado: "pendiente" });
  });

  // Si regresiona, Aprobar dice «quedó esperando» de un plan aprobado, y un run abortado muestra
  // para siempre una etapa «en curso».
  test("Aprobar dice cuándo se aprobó y cuánto esperó; abortar corta la etapa abierta", async () => {
    const { run } = await plannedRun(PLAN, TESTS, testDeps());
    appendEvent(run.dir, { tipo: "cambios_pedidos", motivo: "separá la validación" });
    appendEvent(run.dir, { tipo: "aprobado" });
    appendEvent(run.dir, {
      tipo: "unidad",
      fase: "implementar",
      unidad: "ST-1",
      estado: "iniciada",
    });
    appendEvent(run.dir, { tipo: "abortado" });

    const approval = showPhase(run.home, run.id, "aprobar");
    expect(approval.estado).toBe("aprobado");
    expect(approval.texto).toMatch(/: separá la validación/);
    expect(approval.texto).toMatch(
      /Aprobado el \d\d\/\d\d \d\d:\d\d, después de esperar \d+:\d\d\./,
    );

    const implementing = showPhase(run.home, run.id, "implementar");
    expect(implementing.estado).toBe("cortado al abortar");
    expect(implementing.texto).toContain(
      "- **ST-1** Serializador CSV: cortada al abortar · 1 intento",
    );
  });

  test("una fase que no existe dice cuáles hay", async () => {
    const { run } = await plannedRun(PLAN, TESTS, testDeps());
    expect(() => showPhase(run.home, run.id, "todo")).toThrow("fase inválida: todo");
  });
});
