// Fases falsas para los tests de integración, cargadas por FLOWRUNNER_TEST_HOOKS.
// FAKE_DELAY_MS: cuánto tarda cada fase. Cada ejecución deja su nombre en ejecuciones.txt del run.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PhaseFn, PhaseRegistry } from "../../src/runner/types.ts";
import { PHASES } from "../../src/store/events.ts";

const delay = Number(process.env.FAKE_DELAY_MS ?? "0");

const fake: PhaseFn = async (ctx) => {
  appendFileSync(join(ctx.run.dir, "ejecuciones.txt"), `${ctx.action.fase}\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  return { tipo: "ok" };
};

export const phases: Partial<PhaseRegistry> = Object.fromEntries(PHASES.map((f) => [f, fake]));
export const notify = (): void => undefined;
