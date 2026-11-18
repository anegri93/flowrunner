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

/** Lo que la persona puede pedir desde el doctor; cada una es un comando fijo de flowrunner. */
export type Mantenimiento = { readonly accion: "actualizar" } | { readonly accion: "plugin" };

/** El nombre de la tarea que lanza cada mantenimiento, como lo escribe flowrunner. */
export const TAREA_DE: Record<Mantenimiento["accion"], string> = {
  actualizar: "self-update",
  plugin: "orca-install",
};

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

/** El mantenimiento como argumentos fijos de flowrunner: nada del panel llega al shell sin validar. */
export function mantenimientoArgs(m: Mantenimiento): string {
  switch (m.accion) {
    case "actualizar":
      return "self-update --fondo";
    case "plugin":
      return "orca install --fondo";
    default:
      throw new Error("mantenimiento desconocido");
  }
}

/** Las tareas que terminaron entre dos lecturas: las que corrían y ya no. */
export function terminadas(antes: readonly Tarea[], ahora: readonly Tarea[]): Tarea[] {
  return ahora.filter(
    (t) =>
      t.estado !== "corriendo" &&
      antes.some((a) => a.nombre === t.nombre && a.estado === "corriendo"),
  );
}
