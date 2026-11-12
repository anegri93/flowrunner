// Las formas `--json` del CLI. La skill de consola lee estas formas; cambiarlas es cambiar su contrato.
import { z } from "zod";
import type { RunState } from "../engine/engine.ts";
import { arregloSchema, phaseSchema, type RunEvent } from "../store/events.ts";

export const runSummarySchema = z.strictObject({
  id: z.string(),
  clave: z.string(),
  proyecto: z.string(),
  /** La ruta del repo del run: lo que una vista necesita para abrir sus archivos. */
  repo: z.string(),
  status: z.enum([
    "en_curso",
    "en_cola",
    "esperando_aprobacion",
    "entregado",
    "cerrado",
    "detenido",
    "pausado_por_limite",
    "pausado",
    "abortado",
  ]),
  fase: phaseSchema,
  costo_usd: z.number(),
  detenido: z
    .strictObject({
      motivo: z.string(),
      siguiente: z.string(),
      /** Las respuestas posibles, en orden; la primera es `siguiente` (ADR 0023). */
      opciones: z
        .array(
          z.strictObject({
            comando: z.string(),
            que: z.string(),
            /** Un `fix --unidad` con la instrucción ya escrita (ADR 0028). */
            arreglo: arregloSchema.optional(),
          }),
        )
        .min(1),
      /** Las sub-tasks a las que se atribuye el problema, si hay. */
      unidades: z.array(z.string()).optional(),
    })
    .nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const phaseStepSchema = z.strictObject({
  fase: phaseSchema,
  inicio: z.string(),
  fin: z.string().nullable(),
  resultado: z.string().nullable(),
  motivo: z.string().nullable(),
});

export const statusListSchema = z.strictObject({
  ok: z.literal(true),
  runs: z.array(runSummarySchema),
});
export const statusRunSchema = z.strictObject({
  ok: z.literal(true),
  run: runSummarySchema,
  pasos: z.array(phaseStepSchema),
});
export const runStartedSchema = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  accion: z.string(),
  /** Solo si no había lugar en el repo: su posición en la cola y los runs que ocupan los lugares. */
  cola: z.strictObject({ posicion: z.int().positive(), corriendo: z.array(z.string()) }).optional(),
});

export function summarize(state: RunState): RunSummary {
  return runSummarySchema.parse({
    id: state.runId,
    clave: state.clave,
    proyecto: state.proyecto,
    repo: state.repo,
    status: state.status,
    fase: state.fase,
    costo_usd: Math.round(state.costoUsd * 10_000) / 10_000,
    detenido: state.status === "detenido" && state.halt !== undefined ? state.halt : null,
  });
}

/** Cada acción del log como un paso: cuándo empezó, cuándo terminó y cómo. */
export function steps(events: readonly RunEvent[]): z.infer<typeof phaseStepSchema>[] {
  const out: z.infer<typeof phaseStepSchema>[] = [];
  for (const event of events) {
    if (event.tipo === "accion_iniciada") {
      out.push({ fase: event.fase, inicio: event.at, fin: null, resultado: null, motivo: null });
    } else if (event.tipo === "accion_terminada") {
      const open = out.findLast((s) => s.fase === event.fase && s.fin === null);
      const r = event.resultado;
      const step = open ?? {
        fase: event.fase,
        inicio: event.at,
        fin: null,
        resultado: null,
        motivo: null,
      };
      step.fin = event.at;
      step.resultado = r.tipo === "falla" ? `falla ${r.clase}` : r.tipo;
      step.motivo =
        r.tipo === "falla" || r.tipo === "vuelve" || r.tipo === "pregunta" ? r.motivo : null;
      if (open === undefined) out.push(step);
    }
  }
  return out;
}
