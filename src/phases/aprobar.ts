// Aprobar: el run espera y termina su proceso. Sigue cuando la persona aprueba o pide cambios. El
// aviso de que el plan espera, y de si cambia lo que ya existe, lo da el runner al detenerse.
import type { PhaseFn } from "../runner/types.ts";

export const aprobar: PhaseFn = () => Promise.resolve({ tipo: "espera" });
