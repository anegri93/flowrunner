// Los eventos de un run. `events.jsonl` es de solo agregar y el orden de las líneas es el orden real.
import { z } from "zod";

export const PHASES = [
  "preparar",
  "planificar",
  "aprobar",
  "implementar",
  "verificar",
  "revisar",
  "probar",
  "entregar",
  "aprender",
] as const;
export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

/** Un arreglo concreto para una sub-task: la instrucción que recibiría con `fix --unidad` (ADR 0028). */
export const arregloSchema = z.strictObject({
  unidad: z.string().min(1),
  instruccion: z.string().min(1),
});
export type Arreglo = z.infer<typeof arregloSchema>;

/** Lo que devuelve una fase. El engine decide qué pasa después; la fase nunca elige la siguiente. */
export const outcomeSchema = z.discriminatedUnion("tipo", [
  z.strictObject({
    tipo: z.literal("ok"),
    /** La fase no corrió y dice por qué, como probar sin `probar` en la config: no es un ✓. */
    salteada: z.string().min(1).optional(),
  }),
  z.strictObject({
    tipo: z.literal("falla"),
    /**
     * gate: reintenta con el motivo. infra: reintenta con espera. entorno e invariante: detienen.
     * sin_probar: probar dejó criterios sin probar; detiene hasta que la persona decide (ADR 0017).
     */
    clase: z.enum(["gate", "infra", "entorno", "invariante", "sin_probar"]),
    motivo: z.string().min(1),
  }),
  /**
   * verificar, revisar o probar devuelven trabajo a implementar. `arreglos`, lo que la fase propone
   * que haga cada sub-task, una instrucción por arreglo; falta en runs anteriores (ADR 0028).
   */
  z.strictObject({
    tipo: z.literal("vuelve"),
    unidades: z.array(z.string().min(1)).min(1),
    motivo: z.string().min(1),
    arreglos: z.array(arregloSchema).min(1).optional(),
  }),
  /** La fase espera algo de afuera: la aprobación del plan o el merge de la PR. */
  z.strictObject({ tipo: z.literal("espera") }),
  /** El SDK informó el límite de la suscripción; `hasta` en milisegundos epoch. */
  z.strictObject({ tipo: z.literal("limite"), hasta: z.number() }),
  /** La persona pidió pausar y la fase paró sin terminar, entre sub-tasks: sigue al reanudar. */
  z.strictObject({ tipo: z.literal("pausa") }),
  /**
   * Reintentar solo no sirve: el run se detiene y le pregunta a la persona (ADR 0023). `unidades`,
   * las sub-tasks a las que se atribuye el problema, si hay.
   */
  z.strictObject({
    tipo: z.literal("pregunta"),
    motivo: z.string().min(1),
    unidades: z.array(z.string().min(1)).min(1).optional(),
  }),
]);
export type Outcome = z.infer<typeof outcomeSchema>;

const at = z.iso.datetime();
const unit = z.string().min(1).optional();

/** De dónde vino una decisión de la persona: la terminal, la skill de Claude Code o el panel de Orca. */
export const origenSchema = z.enum(["terminal", "claude", "orca"]);
export type Origen = z.infer<typeof origenSchema>;
/**
 * De dónde vino un Autofix: una de las de la persona, o `flowrunner`, que lo corre solo al detenerse
 * (ADR 0028). No es un `--origen` del CLI: nadie lo elige en nombre de flowrunner.
 */
export const origenAutofixSchema = z.enum([...origenSchema.options, "flowrunner"]);
export type OrigenAutofix = z.infer<typeof origenAutofixSchema>;

export const eventSchema = z.discriminatedUnion("tipo", [
  z.strictObject({
    tipo: z.literal("run_creado"),
    at,
    run_id: z.string(),
    clave: z.string(),
    proyecto: z.string(),
    repo: z.string(),
    budget_usd: z.number().positive().optional(),
    /** Vueltas automáticas, congeladas al crear el run. Un run anterior sin el campo vale 2. */
    vueltas: z.int().min(0).max(3).optional(),
    /**
     * Reintentos de un corte de red, congelados al crear el run. Un run anterior sin el campo trata un
     * corte de red como cualquier otra infraestructura: así un log viejo se sigue leyendo igual (C8).
     */
    reintentos_red: z.int().min(1).max(3).optional(),
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
    /** sin_cambios: devuelta por verificar o revisar, no encontró nada que cambiar en su código. */
    estado: z.enum(["iniciada", "commiteada", "integrada", "fallida", "sin_cambios"]),
    sha: z.string().optional(),
    motivo: z.string().optional(),
    /**
     * fallida por un corte de red: el engine reintenta la fase, y ese intento no cuenta para
     * `MAX_UNIT_ATTEMPTS` ni deja la sub-task fallida (ADR 0023).
     */
    corte_de_red: z.literal(true).optional(),
  }),
  z.strictObject({
    tipo: z.literal("preparado"),
    at,
    rama: z.string(),
    worktree: z.string(),
    base_sha: z.string(),
  }),
  z.strictObject({
    tipo: z.literal("aprobado"),
    at,
    /** Cuántos cambios a lo existente aceptó la persona al aprobar; falta en runs anteriores. */
    cambios_aceptados: z.int().nonnegative().optional(),
    /** De dónde vino la aprobación; falta en runs anteriores (ADR 0023). */
    origen: origenSchema.optional(),
  }),
  z.strictObject({
    tipo: z.literal("cambios_pedidos"),
    at,
    motivo: z.string().min(1),
    /** De dónde vino el pedido; falta en runs anteriores (ADR 0023). */
    origen: origenSchema.optional(),
  }),
  z.strictObject({ tipo: z.literal("reanudado"), at }),
  /** No había lugar en el repo (`max_runs`): espera sin proceso hasta que se libere uno. */
  z.strictObject({ tipo: z.literal("encolado"), at }),
  /**
   * La persona pidió pausar: el run termina lo que está haciendo y para, sin proceso ni lugar, hasta
   * que lo reanude. `para`, el run en cola al que le deja su lugar.
   */
  z.strictObject({
    tipo: z.literal("pausa_pedida"),
    at,
    para: z.string().min(1).optional(),
    origen: origenSchema.optional(),
  }),
  /** La persona le dio prioridad a este run en la cola: sale antes que los demás, una vez. */
  z.strictObject({ tipo: z.literal("priorizado"), at, origen: origenSchema.optional() }),
  /** La persona decidió entregar aunque probar dejó criterios sin probar, y dijo por qué. */
  z.strictObject({ tipo: z.literal("sin_probar_aceptado"), at, motivo: z.string().min(1) }),
  /** La persona eligió una respuesta de la pregunta: que esas sub-tasks lo corrijan (ADR 0023). */
  z.strictObject({
    tipo: z.literal("arreglo_pedido"),
    at,
    unidades: z.array(z.string().min(1)).min(1),
    instruccion: z.string().min(1),
    origen: origenSchema,
  }),
  /**
   * La persona lo arregla a mano en el worktree; el run espera su `resume`. `base`, el HEAD del
   * worktree en ese momento: `resume` chequea todo lo que cambió desde ahí, commiteado o no.
   */
  z.strictObject({
    tipo: z.literal("arreglo_manual_iniciado"),
    at,
    origen: origenSchema,
    base: z.string().min(1),
  }),
  /** `resume` commiteó el arreglo a mano; `sha` es null si no había cambios. */
  z.strictObject({ tipo: z.literal("arreglo_manual"), at, sha: z.string().nullable() }),
  /**
   * Autofix (ADR 0026): flowrunner pasó el lint y el formateador del repo por lo que cambió la rama y
   * vuelve a verificar; si una fase sigue en rojo, sus sub-tasks lo corrigen solas, una vez. Lo eligió
   * la persona, o, con `origen: "flowrunner"`, corrió solo al detenerse (ADR 0028). `sha`, el commit de
   * las herramientas, o null si no cambiaron nada.
   */
  z.strictObject({
    tipo: z.literal("autofix"),
    at,
    origen: origenAutofixSchema,
    sha: z.string().nullable(),
  }),
  /** La persona decidió seguir a la fase siguiente con la fase en rojo, y dijo por qué. */
  z.strictObject({
    tipo: z.literal("aceptado"),
    at,
    fase: phaseSchema,
    motivo: z.string().min(1),
    origen: origenSchema,
  }),
  z.strictObject({ tipo: z.literal("rehacer"), at, desde: phaseSchema }),
  z.strictObject({ tipo: z.literal("abortado"), at }),
  z.strictObject({ tipo: z.literal("pr"), at, url: z.string(), numero: z.int() }),
  z.strictObject({ tipo: z.literal("pr_cerrada"), at, mergeada: z.boolean() }),
  /** Lo que propuso entregar a partir de la fricción del run: `cantidad` lecciones en la PR. */
  z.strictObject({
    tipo: z.literal("lecciones_propuestas"),
    at,
    cantidad: z.int().nonnegative(),
  }),
  z.strictObject({
    tipo: z.literal("lecciones"),
    at,
    url: z.string(),
    numero: z.int(),
    cantidad: z.int().nonnegative(),
    auto_merge: z.boolean(),
  }),
]);
export type RunEvent = z.infer<typeof eventSchema>;
/** Un evento sin `at`: lo completa el store al escribirlo. */
export type NewEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "at">
    : never
  : never;
