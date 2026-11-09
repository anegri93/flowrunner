// Fases falsas para los tests de integración, cargadas por FLOWRUNNER_TEST_HOOKS.
// FAKE_DELAY_MS: cuánto tarda cada fase. Cada ejecución deja su nombre en ejecuciones.txt del run.
// FAKE_KEEP_REAL: fases separadas por comas que corren de verdad, como "preparar".
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PhaseFn, PhaseRegistry } from "../../src/runner/types.ts";
import { PHASES } from "../../src/store/events.ts";

const delay = Number(process.env.FAKE_DELAY_MS ?? "0");

const fake: PhaseFn = async (ctx) => {
  appendFileSync(join(ctx.run.dir, "ejecuciones.txt"), `${ctx.action.fase}\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  // FAKE_SIN_PROBAR: probar deja un criterio sin probar, como cuando falta simular una falla.
  if (ctx.action.fase === "probar" && process.env.FAKE_SIN_PROBAR === "1") {
    return {
      tipo: "falla",
      clase: "sin_probar",
      motivo: "1 de 1 criterios quedaron sin probar:\n- AC-1 (exportar): falta simular la falla",
    };
  }
  return { tipo: "ok" };
};

const keepReal = new Set((process.env.FAKE_KEEP_REAL ?? "").split(",").filter((f) => f !== ""));

export const phases: Partial<PhaseRegistry> = Object.fromEntries(
  PHASES.filter((f) => !keepReal.has(f)).map((f) => [f, fake]),
);
