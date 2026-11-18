// El doctor del panel, sin DOM ni Orca: lo que dicen `flowrunner doctor --json` y `flowrunner tareas
// --json`, y las tareas de mantenimiento como comandos fijos (ADR 0039). Lo leen el worker, que corre
// los comandos, y el panel, que los dibuja.

/** Un chequeo de `flowrunner doctor`: qué es, si está bien y cómo arreglarlo. */
export interface Check {
  readonly nombre: string;
  readonly ok: boolean;
  readonly arreglo: string;
}

/** La versión que corre contra origin/main del último fetch; null lo que no se pudo saber. */
export interface Version {
  readonly sha: string | null;
  readonly main: string | null;
  readonly atras: number | null;
}

export interface Doctor {
  readonly ok: boolean;
  readonly checks: readonly Check[];
  /** Falta con un flowrunner anterior, que no la informa. */
  readonly version?: Version;
}

/** Una tarea de fondo: actualizar flowrunner, cargar el plugin o auditar un cerebro. */
export interface Tarea {
  readonly nombre: string;
  readonly estado: "corriendo" | "ok" | "falla";
  readonly inicio: string;
  readonly fin: string | null;
  readonly mensaje: string;
  /** El comando para correr en la terminal, como el `--approve` del plugin. */
  readonly siguiente: string | null;
}

/**
 * Lo que la persona puede pedir desde el doctor; cada una es un comando fijo de flowrunner. Auditar
 * es del proyecto enfocado en Orca: la ruta la pone el worker, no el panel (ADR 0040).
 */
export type Mantenimiento =
  | { readonly accion: "actualizar" }
  | { readonly accion: "plugin" }
  | { readonly accion: "auditar" }
  | {
      readonly accion: "aplicar";
      /** `<proyecto>/<id>` de la auditoría. */
      readonly auditoria: string;
      readonly decisiones: readonly string[];
    };

/** Si la tarea es la que lanza ese mantenimiento de fondo; aplicar abre la PR en el momento. */
export function esTareaDe(m: Mantenimiento, t: Tarea): boolean {
  switch (m.accion) {
    case "actualizar":
      return t.nombre === "self-update";
    case "plugin":
      return t.nombre === "orca-install";
    case "auditar":
      return t.nombre.startsWith("auditar-");
    default:
      return false;
  }
}

/** Una decisión de la auditoría, como la muestra el panel. */
export interface DecisionCerebro {
  readonly id: string;
  readonly titulo: string;
  readonly porQue: string;
  readonly reduce: string;
  readonly aplicable: boolean;
  /** Por qué no se puede aplicar. */
  readonly motivo: string | null;
  /** La PR donde ya está, si se aplicó. */
  readonly pr: string | null;
}

export interface HallazgoCerebro {
  readonly id: string;
  readonly tipo: string;
  readonly archivo: string;
  readonly que: string;
}

export interface AuditoriaCerebro {
  /** `<proyecto>/<id>`: lo que recibe `brain apply`. */
  readonly ref: string;
  readonly fecha: string;
  readonly costoUsd: number;
  readonly resumen: string;
  readonly hallazgos: readonly HallazgoCerebro[];
  readonly decisiones: readonly DecisionCerebro[];
}

/** El cerebro del proyecto enfocado: su última auditoría, si la hay. */
export interface CerebroSnapshot {
  readonly proyecto?: string;
  readonly auditoria: AuditoriaCerebro | null;
  readonly error?: string;
}

export interface DoctorSnapshot {
  /** Undefined si flowrunner no contestó: `error` dice por qué. */
  readonly doctor?: Doctor;
  readonly tareas: readonly Tarea[];
  readonly error?: string;
}

export interface TareasSnapshot {
  readonly tareas: readonly Tarea[];
  readonly error?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function json(stdout: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`flowrunner no devolvió JSON: ${stdout.slice(0, 200)}`);
  }
  if (!isObject(data)) throw new Error("flowrunner no devolvió un objeto");
  return data;
}

/** `flowrunner doctor --json`. Sale 1 cuando falta algo, y su JSON vale igual. */
export function parseDoctor(stdout: string): Doctor {
  const data = json(stdout);
  if (!Array.isArray(data.checks)) throw new Error("la salida de doctor no trae `checks`");
  const checks = data.checks.filter(isObject).map((c): Check => ({
    nombre: str(c.nombre) ?? "(sin nombre)",
    ok: c.ok === true,
    arreglo: str(c.arreglo) ?? "",
  }));
  const v = data.version;
  return {
    ok: checks.every((c) => c.ok),
    checks,
    ...(isObject(v)
      ? { version: { sha: str(v.sha), main: str(v.main), atras: num(v.atras) } }
      : {}),
  };
}

const ESTADOS: readonly Tarea["estado"][] = ["corriendo", "ok", "falla"];

/** `flowrunner tareas --json`; un flowrunner anterior no tiene el comando y no hay tareas. */
export function parseTareas(stdout: string): Tarea[] {
  const data = json(stdout);
  if (!Array.isArray(data.tareas)) throw new Error("la salida de tareas no trae `tareas`");
  return data.tareas.filter(isObject).flatMap((t): Tarea[] => {
    const nombre = str(t.nombre);
    const estado = ESTADOS.find((e) => e === t.estado);
    if (nombre === null || estado === undefined) return [];
    return [
      {
        nombre,
        estado,
        inicio: str(t.inicio) ?? "",
        fin: str(t.fin),
        mensaje: str(t.mensaje) ?? "",
        siguiente: str(t.siguiente),
      },
    ];
  });
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const AUDITORIA = /^[a-z0-9-]+\/\d{8}-\d{6}$/;
const DECISION = /^D\d+$/;

/**
 * El mantenimiento como argumentos fijos de flowrunner: nada del panel llega al shell sin validar.
 * `ruta`, la del proyecto enfocado en Orca, la pone el worker para auditar.
 */
export function mantenimientoArgs(m: Mantenimiento, ruta?: string): string {
  switch (m.accion) {
    case "actualizar":
      return "self-update --fondo";
    case "plugin":
      return "orca install --fondo";
    case "auditar":
      if (ruta === undefined || !ruta.startsWith("/") || /[\n\0]/.test(ruta))
        throw new Error("enfocá un proyecto en Orca para auditar su cerebro");
      return `brain audit ${quote(ruta)} --fondo`;
    case "aplicar": {
      if (typeof m.auditoria !== "string" || !AUDITORIA.test(m.auditoria))
        throw new Error(`auditoría inválida: ${String(m.auditoria)}`);
      const ids: readonly unknown[] = Array.isArray(m.decisiones) ? m.decisiones : [];
      if (ids.length === 0) throw new Error("elegí al menos una decisión");
      const bad = ids.find((d) => typeof d !== "string" || !DECISION.test(d));
      if (bad !== undefined) throw new Error(`decisión inválida: ${String(bad)}`);
      return `brain apply ${m.auditoria} ${ids.map((d) => `--decision ${String(d)}`).join(" ")}`;
    }
    default:
      throw new Error("mantenimiento desconocido");
  }
}

/**
 * `flowrunner brain audit <ruta> --ultima --json`: el proyecto, su repo, su última auditoría y el
 * informe. La PR de cada decisión aplicada sale de `aplicadas`.
 */
export function parseCerebro(stdout: string): {
  readonly proyecto: string;
  readonly repo: string | null;
  readonly auditoria: AuditoriaCerebro | null;
  readonly informe: string | null;
} {
  const data = json(stdout);
  const proyecto = str(data.proyecto) ?? "";
  const r = data.auditoria;
  if (!isObject(r)) return { proyecto, repo: null, auditoria: null, informe: null };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObject) : []);
  const aplicadas = list(r.aplicadas);
  const prDe = (id: string) =>
    str(aplicadas.find((a) => Array.isArray(a.decisiones) && a.decisiones.includes(id))?.pr);
  return {
    proyecto,
    repo: str(r.repo),
    informe: str(data.informe),
    auditoria: {
      ref: `${proyecto}/${str(r.id) ?? ""}`,
      fecha: str(r.fecha) ?? "",
      costoUsd: num(r.costo_usd) ?? 0,
      resumen: str(r.resumen) ?? "",
      hallazgos: list(r.hallazgos).map((h) => ({
        id: str(h.id) ?? "",
        tipo: str(h.tipo) ?? "",
        archivo: str(h.archivo) ?? "",
        que: str(h.que) ?? "",
      })),
      decisiones: list(r.decisiones).map((d) => {
        const id = str(d.id) ?? "";
        return {
          id,
          titulo: str(d.titulo) ?? "",
          porQue: str(d.por_que) ?? "",
          reduce: str(d.reduce) ?? "",
          aplicable: d.aplicable === true,
          motivo: str(d.motivo),
          pr: prDe(id),
        };
      }),
    },
  };
}

/** Las tareas que terminaron entre dos lecturas: las que corrían y ya no. */
export function terminadas(antes: readonly Tarea[], ahora: readonly Tarea[]): Tarea[] {
  return ahora.filter(
    (t) =>
      t.estado !== "corriendo" &&
      antes.some((a) => a.nombre === t.nombre && a.estado === "corriendo"),
  );
}
