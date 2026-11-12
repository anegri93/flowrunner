// Un aviso por cada cambio de estado del run que pasa sin que la persona lo pida: lo que hace ella,
// desde la terminal, Claude u Orca, ya se lo dice la respuesta del comando.
import type { RunState, RunStatus } from "../engine/engine.ts";
import { readPlan } from "../phases/planificar.ts";
import type { RunPaths } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";

export interface Aviso {
  readonly title: string;
  readonly body: string;
}

export interface Contexto {
  readonly events: readonly RunEvent[];
  /**
   * Cuántas cosas que ya existen cambia el plan: un plan así no avisa igual que uno que no.
   * Undefined si el plan no se pudo leer.
   */
  readonly cambiosExistentes: () => number | undefined;
  /** La hora local de un instante, como `15:40`. */
  readonly hora?: (ms: number) => string;
}

const horaLocal = (ms: number) =>
  new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });

/** El aviso de pasar de `antes` al estado de `despues`, o nada si el estado no cambió. */
export function avisoDeEstado(
  antes: RunStatus,
  despues: RunState,
  ctx: Contexto,
): Aviso | undefined {
  if (antes === despues.status) return undefined;
  const { clave, fase } = despues;
  const aviso = (body: string): Aviso => ({ title: "flowrunner", body });
  switch (despues.status) {
    case "esperando_aprobacion": {
      // El aviso genérico es el que se aprueba sin leer: un plan que cambia lo existente lo dice.
      const n = ctx.cambiosExistentes();
      // Sin saber qué cambia, el aviso no puede ser el tranquilo.
      if (n === undefined)
        return aviso(
          `⚠ ${clave}: el plan espera tu aprobación, y no pude leer si cambia lo que ya existe. Pedile a Claude que te lo muestre antes de aprobar.`,
        );
      return aviso(
        n === 0
          ? `${clave}: el plan espera tu aprobación. Pedile a Claude que te lo muestre.`
          : `⚠ ${clave}: el plan cambia ${n === 1 ? "1 cosa que ya existe" : `${String(n)} cosas que ya existen`}. Pedile a Claude que te lo muestre antes de aprobar.`,
      );
    }
    case "detenido": {
      // La primera respuesta, para que el aviso diga qué hacer y no solo qué pasó (ADR 0023).
      const halt = despues.halt;
      const first = halt?.opciones[0]?.comando;
      return {
        title: `${clave}: el run se detuvo`,
        body: `${halt?.motivo ?? "sin motivo"}${first === undefined ? "" : `\nPara seguir: ${first}`}`,
      };
    }
    case "entregado": {
      const rounds = Object.values(despues.vueltas).reduce((a, b) => a + b, 0);
      return aviso(
        `${clave}: PR abierta${rounds === 0 ? "" : `, ${String(rounds)} ${rounds === 1 ? "vuelta" : "vueltas"}`}. Pedile a Claude que te explique el informe.`,
      );
    }
    case "pausado_por_limite":
      return aviso(
        despues.pausaHasta === undefined
          ? `${clave}: en pausa por el límite de la suscripción; sigue solo cuando se libere`
          : `${clave}: en pausa por el límite de la suscripción; sigue solo a las ${(ctx.hora ?? horaLocal)(despues.pausaHasta)}`,
      );
    case "en_cola":
      return aviso(`${clave}: en cola, esperando un lugar del repo`);
    case "pausado":
      return aviso(`${clave}: pausado en ${fase}; sigue cuando lo reanudes`);
    case "en_curso":
      return aviso(
        antes === "en_cola"
          ? `${clave}: salió de la cola y arrancó en ${fase}`
          : antes === "pausado_por_limite"
            ? `${clave}: retomado en ${fase} después del límite`
            : antes === "pausado"
              ? `${clave}: reanudado en ${fase}`
              : `${clave}: sigue en ${fase}`,
      );
    case "cerrado": {
      const merged = ctx.events.some((e) => e.tipo === "pr_cerrada" && e.mergeada);
      if (!merged) return aviso(`${clave}: cerrado; la PR se cerró sin merge`);
      const lessons = ctx.events.findLast((e) => e.tipo === "lecciones");
      const n = lessons?.tipo === "lecciones" ? lessons.cantidad : 0;
      return aviso(
        `${clave}: cerrado después del merge${n === 0 ? ", sin lecciones" : `, con ${String(n)} ${n === 1 ? "lección" : "lecciones"}`}`,
      );
    }
    case "abortado":
      return aviso(`${clave}: abortado`);
  }
}

/** Lo que cambia del plan, leído del run. Un aviso que no sale no puede tirar abajo el proceso. */
export function cambiosDelPlan(run: RunPaths): () => number | undefined {
  return () => {
    try {
      return readPlan(run).cambia_lo_existente.length;
    } catch {
      return undefined;
    }
  };
}
