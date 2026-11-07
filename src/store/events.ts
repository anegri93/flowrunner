// Los eventos de un run. `events.jsonl` es de solo agregar y el orden de las líneas es el orden real.
import { z } from "zod";

export const PHASES = [
  "preparar",
  "planificar",
  "aprobar",
  "implementar",
  "verificar",
  "revisar",
  "entregar",
  "aprender",
] as const;
export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

/** Lo que devuelve una fase. El engine decide qué pasa después; la fase nunca elige la siguiente. */
export const outcomeSchema = z.discriminatedUnion("tipo", [
  z.strictObject({ tipo: z.literal("ok") }),
  z.strictObject({
    tipo: z.literal("falla"),
    /** gate: reintenta con el motivo. infra: reintenta con espera. entorno e invariante: detienen. */
    clase: z.enum(["gate", "infra", "entorno", "invariante"]),
    motivo: z.string().min(1),
  }),
  /** verificar o revisar devuelven trabajo a implementar. */
  z.strictObject({
    tipo: z.literal("vuelve"),
    unidades: z.array(z.string().min(1)).min(1),
    motivo: z.string().min(1),
  }),
  /** La fase espera algo de afuera: la aprobación del plan o el merge de la PR. */
  z.strictObject({ tipo: z.literal("espera") }),
  /** El SDK informó el límite de la suscripción; `hasta` en milisegundos epoch. */
  z.strictObject({ tipo: z.literal("limite"), hasta: z.number() }),
]);
export type Outcome = z.infer<typeof outcomeSchema>;

const at = z.iso.datetime();
const unit = z.string().min(1).optional();

export const eventSchema = z.discriminatedUnion("tipo", [
  z.strictObject({
    tipo: z.literal("run_creado"),
    at,
    run_id: z.string(),
    clave: z.string(),
    proyecto: z.string(),
    repo: z.string(),
    budget_usd: z.number().positive(),
  }),
  z.strictObject({ tipo: z.literal("accion_iniciada"), at, fase: phaseSchema }),
  z.strictObject({
    tipo: z.literal("accion_terminada"),
    at,
    fase: phaseSchema,
    resultado: outcomeSchema,
  }),
  z.strictObject({
    tipo: z.literal("uso"),
    at,
    fase: phaseSchema,
    unidad: unit,
    sesion: z.string(),
    modelo: z.string(),
    costo_usd: z.number().nonnegative(),
    tokens_entrada: z.int().nonnegative(),
    tokens_salida: z.int().nonnegative(),
    duracion_ms: z.int().nonnegative(),
  }),
  z.strictObject({
    tipo: z.literal("rechazo"),
    at,
    fase: phaseSchema,
    unidad: unit,
    herramienta: z.string(),
    motivo: z.string(),
  }),
  z.strictObject({
    tipo: z.literal("decision"),
    at,
    fase: phaseSchema,
    unidad: unit,
    que: z.string(),
    por_que: z.string(),
  }),
  z.strictObject({ tipo: z.literal("aviso"), at, fase: phaseSchema, texto: z.string() }),
  z.strictObject({
    tipo: z.literal("unidad"),
    at,
    fase: phaseSchema,
    unidad: z.string(),
    estado: z.enum(["iniciada", "commiteada", "integrada", "fallida"]),
    sha: z.string().optional(),
    motivo: z.string().optional(),
  }),
  z.strictObject({ tipo: z.literal("aprobado"), at }),
  z.strictObject({ tipo: z.literal("cambios_pedidos"), at, motivo: z.string().min(1) }),
  z.strictObject({ tipo: z.literal("reanudado"), at }),
  z.strictObject({ tipo: z.literal("rehacer"), at, desde: phaseSchema }),
  z.strictObject({ tipo: z.literal("abortado"), at }),
  z.strictObject({ tipo: z.literal("pr"), at, url: z.string(), numero: z.int() }),
  z.strictObject({ tipo: z.literal("pr_cerrada"), at, mergeada: z.boolean() }),
]);
export type RunEvent = z.infer<typeof eventSchema>;
export type EventType = RunEvent["tipo"];
/** Un evento sin `at`: lo completa el store al escribirlo. */
export type NewEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "at">
    : never
  : never;
