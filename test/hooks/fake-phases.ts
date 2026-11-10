// Fases falsas para los tests de integración, cargadas por FLOWRUNNER_TEST_HOOKS.
// FAKE_DELAY_MS: cuánto tarda cada fase. Cada ejecución deja su nombre en ejecuciones.txt del run.
// FAKE_KEEP_REAL: fases separadas por comas que corren de verdad, como "preparar".
// FAKE_ESPERA_APROBAR: aprobar espera la aprobación, como el de verdad.
// FAKE_SEMAFORO: cada fase espera a que exista ese archivo, para que el test decida cuándo sigue.
// FAKE_VUELVE: una sub-task, como "ST-1": verificar se la devuelve a implementar hasta que la persona
//   responda (un fix, aceptar, arreglarlo a mano o un Autofix suyo). Lo que flowrunner hace solo, como
//   Autofix al detenerse (ADR 0028), no la destraba.
// FAKE_ARREGLO: con FAKE_VUELVE, el arreglo ya escrito que verificar propone para esa sub-task.
// FAKE_MAL_FORMATO: un archivo que implementar, la primera vez, escribe sin formatear y commitea en el
//   worktree de la feature, como lo dejaría una sub-task. Deja también el plan, que planificar no escribe.
// FAKE_PREGUNTA: sub-tasks separadas por comas: implementar pregunta por ellas la primera vez.
// FAKE_FALLA: "fase:clase", como "preparar:entorno": esa fase falla siempre, con otro motivo cada vez.
//   Con la clase "credencial", falla de entorno con el texto de la credencial rechazada.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_REJECTED } from "../../src/engine/motivos.ts";
import type { PhaseFn, PhaseRegistry } from "../../src/runner/types.ts";
import type { RunEvent } from "../../src/store/events.ts";
import { writePlanArtifacts } from "../../src/phases/planificar.ts";
import { PLAN } from "../helpers/plan-fixtures.ts";
import { PHASES } from "../../src/store/events.ts";

const delay = Number(process.env.FAKE_DELAY_MS ?? "0");

/** La persona ya respondió a una detención: lo que manda el run a trabajar por su decisión. */
const answered = (events: readonly RunEvent[]) =>
  events.some(
    (e) =>
      ["arreglo_pedido", "arreglo_manual_iniciado", "aceptado", "sin_probar_aceptado"].includes(
        e.tipo,
      ) ||
      (e.tipo === "autofix" && e.origen !== "flowrunner"),
  );

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
    if (!answered(ctx.events)) {
      const arreglo = process.env.FAKE_ARREGLO;
      return {
        tipo: "vuelve",
        unidades: [vuelve],
        motivo: "AC-1 sigue en rojo",
        ...(arreglo === undefined ? {} : { arreglos: [{ unidad: vuelve, instruccion: arreglo }] }),
      };
    }
  }
  const ran = () =>
    readFileSync(join(ctx.run.dir, "ejecuciones.txt"), "utf8")
      .split("\n")
      .filter((f) => f === ctx.action.fase).length;
  const malFormato = process.env.FAKE_MAL_FORMATO;
  if (ctx.action.fase === "implementar" && malFormato !== undefined && ran() === 1) {
    const preparado = ctx.events.find((e) => e.tipo === "preparado");
    if (preparado?.tipo === "preparado") {
      const wt = preparado.worktree;
      writeFileSync(join(wt, malFormato), "export const a = 1; // mal formato\n");
      execFileSync("git", ["-C", wt, "add", "--", malFormato]);
      execFileSync("git", ["-C", wt, "commit", "-q", "-m", "feat: ST-1"]);
      writePlanArtifacts(ctx.run, PLAN, {});
    }
  }
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
