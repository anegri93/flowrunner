// Aprobar: el run avisa y termina su proceso. Sigue cuando la persona aprueba o pide cambios.
import type { PhaseFn } from "../runner/types.ts";
import { readPlan } from "./planificar.ts";

export const aprobar: PhaseFn = (ctx) => {
  const n = readPlan(ctx.run).cambia_lo_existente.length;
  // Un plan que cambia lo que ya existe no avisa igual que uno que no: el aviso genérico es el que se
  // aprueba sin leer.
  ctx.deps.notify(
    "flowrunner",
    n === 0
      ? `${ctx.state.clave}: el plan espera tu aprobación. Pedile a Claude que te lo muestre.`
      : `⚠ ${ctx.state.clave}: el plan cambia ${n === 1 ? "1 cosa que ya existe" : `${String(n)} cosas que ya existen`}. Pedile a Claude que te lo muestre antes de aprobar.`,
  );
  return Promise.resolve({ tipo: "espera" });
};
