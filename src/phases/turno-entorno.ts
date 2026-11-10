// El turno del entorno: verify, los comandos de criterio de verificar y probar usan puertos fijos o
// una base local compartida, así que dos runs del mismo repo no los corren a la vez (ADR 0019).
import type { PhaseContext } from "../runner/types.ts";
import { conTurno, turnoFile } from "../store/turno.ts";

export function conEntorno<T>(
  ctx: Pick<PhaseContext, "run" | "state" | "action" | "emit">,
  fn: () => Promise<T>,
): Promise<T> {
  return conTurno(turnoFile(ctx.run.home, ctx.state.proyecto, "entorno"), ctx.run.id, fn, {
    alEsperar: (dueño) => {
      ctx.emit({
        tipo: "aviso",
        fase: ctx.action.fase,
        texto: `esperando el turno del entorno: lo tiene ${dueño.run_id}`,
      });
    },
  });
}
