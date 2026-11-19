// Aprobar: el run espera y termina su proceso. Sigue cuando la persona aprueba o pide cambios. El
// aviso de que el plan espera, y de si cambia lo que ya existe, lo da el runner al detenerse.
//
// Antes de esperar, fija las versiones de las dependencias nuevas del plan con el registro (ADR 0029):
// la persona aprueba el plan con las versiones que se van a instalar. Va acá y no al final de
// planificar porque un registro que no responde reintenta solo esto, sin volver a pagar el plan.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PhaseFn } from "../runner/types.ts";
import { fijarVersiones } from "../versiones/versiones.ts";
import { prepared } from "./inputs.ts";
import { readPlan, writeVersiones } from "./planificar.ts";

export const aprobar: PhaseFn = async (ctx) => {
  const { worktree } = prepared(ctx.events);
  // Sin package.json no hay registro de npm que consultar ni engines que cumplir.
  if (existsSync(join(worktree, "package.json"))) {
    const plan = readPlan(ctx.run);
    try {
      const { subtareas, versiones } = await fijarVersiones(
        plan.subtareas,
        worktree,
        ctx.deps.registro,
      );
      writeVersiones(ctx.run, subtareas, versiones);
    } catch (error) {
      // Un corte de red reintenta con espera, porque el motivo lo dice; otra cosa, como infraestructura.
      const motivo = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      return {
        tipo: "falla",
        clase: "infra",
        motivo: motivo === undefined || motivo === "" ? "el registro de npm falló" : motivo,
      };
    }
  }
  // Con `aprobar: si_hace_falta`, las decisiones se tomaron en la feature: solo espera a la persona
  // una dependencia sin versión que sirva, que pide elegir otra librería o subir el Node (ADR 0044).
  // Los cambios a lo que existe se aceptan por el criterio que citan y van en la PR.
  if (ctx.state.aprobarSolo) {
    const plan = readPlan(ctx.run);
    if ((plan.versiones?.sin_version ?? []).length === 0) {
      ctx.emit({
        tipo: "aprobado",
        cambios_aceptados: plan.cambia_lo_existente.length,
        origen: "flowrunner",
      });
      return { tipo: "ok" };
    }
  }
  return { tipo: "espera" };
};
