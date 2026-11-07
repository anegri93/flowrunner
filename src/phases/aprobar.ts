// Aprobar: el run avisa y termina su proceso. Sigue cuando la persona aprueba o pide cambios.
import type { PhaseFn } from "../runner/types.ts";

export const aprobar: PhaseFn = (ctx) => {
  ctx.deps.notify(
    "flowrunner",
    `${ctx.state.clave}: el plan espera tu aprobación. Pedile a Claude que te lo muestre.`,
  );
  return Promise.resolve({ tipo: "espera" });
};
