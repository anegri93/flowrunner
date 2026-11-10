// Fases falsas para los tests de integración, cargadas por FLOWRUNNER_TEST_HOOKS.
// FAKE_DELAY_MS: cuánto tarda cada fase. Cada ejecución deja su nombre en ejecuciones.txt del run.
// FAKE_KEEP_REAL: fases separadas por comas que corren de verdad, como "preparar".
// FAKE_ESPERA_APROBAR: aprobar espera la aprobación, como el de verdad.
// FAKE_SEMAFORO: cada fase espera a que exista ese archivo, para que el test decida cuándo sigue.
// FAKE_VUELVE: una sub-task, como "ST-1": verificar se la devuelve a implementar solo la primera vez.
// FAKE_PREGUNTA: sub-tasks separadas por comas: implementar pregunta por ellas la primera vez.
// FAKE_FALLA: "fase:clase", como "preparar:entorno": esa fase falla siempre, con otro motivo cada vez.
//   Con la clase "credencial", falla de entorno con el texto de la credencial rechazada.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_REJECTED } from "../../src/engine/motivos.ts";
import type { PhaseFn, PhaseRegistry } from "../../src/runner/types.ts";
import { PHASES } from "../../src/store/events.ts";

const delay = Number(process.env.FAKE_DELAY_MS ?? "0");

const fake: PhaseFn = async (ctx) => {
  appendFileSync(join(ctx.run.dir, "ejecuciones.txt"), `${ctx.action.fase}\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  const semaforo = process.env.FAKE_SEMAFORO;
  while (semaforo !== undefined && !existsSync(semaforo)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (ctx.action.fase === "aprobar" && process.env.FAKE_ESPERA_APROBAR === "1") {
    return { tipo: "espera" };
  }
  const vuelve = process.env.FAKE_VUELVE;
  if (ctx.action.fase === "verificar" && vuelve !== undefined && vuelve !== "") {
    const ran = readFileSync(join(ctx.run.dir, "ejecuciones.txt"), "utf8").split("\n");
    if (ran.filter((f) => f === "verificar").length === 1) {
      return { tipo: "vuelve", unidades: [vuelve], motivo: "AC-1 sigue en rojo" };
    }
  }
  const ran = () =>
    readFileSync(join(ctx.run.dir, "ejecuciones.txt"), "utf8")
      .split("\n")
      .filter((f) => f === ctx.action.fase).length;
  const pregunta = (process.env.FAKE_PREGUNTA ?? "").split(",").filter((u) => u !== "");
  if (ctx.action.fase === "implementar" && pregunta.length > 0 && ran() === 1) {
    return { tipo: "pregunta", motivo: "una sub-task no pudo terminar", unidades: pregunta };
  }
  const [fase, clase] = (process.env.FAKE_FALLA ?? "").split(":");
  if (ctx.action.fase === fase && (clase === "entorno" || clase === "gate")) {
    return { tipo: "falla", clase, motivo: `falla ${String(ran())}` };
  }
  if (ctx.action.fase === fase && clase === "credencial") {
    return { tipo: "falla", clase: "entorno", motivo: TOKEN_REJECTED };
  }
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
