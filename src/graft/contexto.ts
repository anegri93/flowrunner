// El contexto de graft para un prompt, calculado antes de la sesión: la API de los archivos y quién
// usa lo que exportan. Un dato que el agente busca en tres turnos cuesta tres veces el contexto
// entero; calculado, cuesta cero turnos (plan de raíz, principio 7). ADR 0022.
//
// Siempre con `--json`: en modo texto, graft imprime en stdout una línea dirigida al agente («tell the
// user …») que no puede llegar a un prompt. Y siempre con `--no-refresh`: el índice lo reconstruye
// quien llama, antes, y no cada consulta.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { git } from "../git/git.ts";
import { covers } from "../tripwires/rules.ts";
import { graftEnv } from "./graft.ts";

const exec = promisify(execFile);

export interface ContextoOpts {
  readonly repo: string; // el worktree que indexó graft
  readonly indexDir: string; // graftIndex(run)
  readonly archivos: readonly string[]; // rutas relativas, archivos o carpetas
  readonly env: NodeJS.ProcessEnv;
  readonly maxChars?: number; // por defecto 12_000
}

/** Una entrada de `graft skeleton --json`. */
export interface EntradaApi {
  readonly name: string;
  readonly kind: string; // "function" | "class" | "method" | "type" | "interface" | …
  readonly span: string; // "L21-L23"
  readonly signature: string;
}

/** Un hit de `graft callers --json`. */
export interface Llamador {
  readonly name: string;
  readonly kind: string; // "function" | "file" | …
  readonly path: string;
  readonly span: string;
  readonly relation: string; // "calls" | "references"
}

/** graft no pudo responder: no está instalado, no hay índice, salió con error o devolvió otra cosa. */
export class GraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraftError";
  }
}

/** Los topes de una llamada a `contextoGraft`. Una consulta tarda unos 0,26 s. */
export interface Limites {
  readonly archivos: number;
  readonly consultas: number;
  readonly paralelas: number;
  readonly totalMs: number;
}

export const LIMITES: Limites = { archivos: 30, consultas: 40, paralelas: 4, totalMs: 60_000 };

const MAX_CHARS = 12_000;
const MAX_FIRMA = 200;
/** Solo de estos se buscan llamadores: los métodos salen como `constructor` o con nombre ambiguo. */
const LLAMABLES = new Set(["function", "class"]);
const SIN_DEFINICIONES = "- (todavía no existe, o graft no le encontró definiciones)";
const LINEA_LLAMADOR = /^ {2}- ← `([^`:]+)(?::L\d+-L\d+)?`/;
/** `callers` sale con 1 y esto en stderr cuando el símbolo no está en el grafo: no es un error. */
const SIN_SIMBOLO = /no symbol ".*" in the graph/;

const entradaSchema = z.object({
  name: z.string(),
  kind: z.string(),
  span: z.string(),
  signature: z.string(),
});
const skeletonSchema = z.object({
  file: z.string(),
  entries: z.array(entradaSchema),
  note: z.string().optional(),
});
const llamadorSchema = z.object({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  span: z.string(),
  relation: z.string(),
});
const callersSchema = z.object({
  matches: z.array(
    z.object({
      symbol: z.object({ name: z.string(), path: z.string() }),
      hits: z.array(llamadorSchema),
    }),
  ),
});
type Match = z.infer<typeof callersSchema>["matches"][number];

/** Se acabó el tiempo total antes de que la consulta respondiera, o antes de empezarla. */
class SinTiempo extends Error {}

/**
 * La primera línea útil de un error de graft o de git, para decirla en el texto. Nunca la salida de
 * graft (stdout): es la que puede traer la línea dirigida al agente.
 */
function primeraLinea(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const lineas = (typeof stderr === "string" ? stderr : "")
    .split("\n")
    .map((l) => l.trim())
    // `[graft]` es la línea de ahorro; `⬆`, el aviso de versión nueva («run `graft upgrade`»); `·`,
    // el de telemetría. Las tres le hablan al agente, no dicen qué falló.
    .filter((l) => l !== "" && !/^(\[graft\]|⬆|·)/.test(l));
  const linea =
    lineas.find((l) => l.startsWith("✗")) ??
    lineas[0] ??
    (error instanceof Error ? error.message : String(error)).split("\n")[0] ??
    "";
  return linea.slice(0, 300);
}

interface Graft {
  readonly repo: string;
  readonly indexDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Corta las consultas en curso cuando ya no sirven: una falló o ya se devolvió el texto. */
  readonly signal?: AbortSignal;
}

/** Corre una consulta de graft con `--json --no-refresh` y devuelve su JSON. */
async function consultar(g: Graft, args: readonly string[], timeoutMs: number): Promise<unknown> {
  if (timeoutMs <= 0) throw new SinTiempo();
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "graft",
      ["--dir", g.indexDir, args[0] ?? "", "--json", "--no-refresh", "--", ...args.slice(1)],
      {
        cwd: g.repo,
        env: graftEnv(g.env),
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        signal: g.signal,
      },
    ));
  } catch (error) {
    const e = error as { killed?: unknown; code?: unknown };
    if (e.killed === true && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new SinTiempo();
    throw new GraftError(primeraLinea(error));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GraftError(`graft ${args[0] ?? ""} no devolvió JSON`);
  }
}

function conForma<T>(schema: z.ZodType<T>, valor: unknown, que: string): T {
  const r = schema.safeParse(valor);
  if (!r.success) throw new GraftError(`graft ${que} devolvió un JSON con otra forma`);
  return r.data;
}

async function skeleton(g: Graft, archivo: string, timeoutMs: number): Promise<EntradaApi[]> {
  const json = conForma(
    skeletonSchema,
    await consultar(g, ["skeleton", archivo, g.repo], timeoutMs),
    "skeleton",
  );
  // graft 0.29 sin índice no sale con error: devuelve `entries: []` con esta nota.
  if (json.entries.length === 0 && json.note?.startsWith("no wiring graph") === true)
    throw new GraftError(json.note.split("\n")[0] ?? json.note);
  // Un nombre suelto que no existe, graft lo resuelve a cualquier archivo con ese nombre: la API de
  // otro archivo no es la de este.
  return json.file === archivo ? json.entries : [];
}

async function callers(g: Graft, simbolo: string, timeoutMs: number): Promise<Match[]> {
  let json: unknown;
  try {
    json = await consultar(g, ["callers", simbolo, g.repo], timeoutMs);
  } catch (error) {
    if (error instanceof GraftError && SIN_SIMBOLO.test(error.message)) return [];
    throw error;
  }
  return conForma(callersSchema, json, "callers").matches;
}

/** `fn` sobre cada item, de a `n` a la vez, en orden. Después de una falla no arranca ninguno más. */
async function deAPocos<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let siguiente = 0;
  let roto = false;
  const trabajador = async () => {
    while (!roto && siguiente < items.length) {
      const i = siguiente++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (error) {
        roto = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, trabajador));
  return out;
}

/** Los archivos de `archivos`, con cada carpeta expandida a sus archivos versionados, sin repetir. */
async function expandir(
  repo: string,
  archivos: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const out: string[] = [];
  for (const entrada of archivos) {
    const ruta = entrada.replace(/^\.\//, "");
    // Literal: `[id]` o `(grupo)` de Next son rutas, no patrones.
    const versionados = (
      await git(repo, ["--literal-pathspecs", "ls-files", "-z", "--", ruta], env)
    )
      .split("\0")
      .filter((p) => p !== "")
      .sort();
    const esCarpeta = ruta.endsWith("/") || versionados.some((p) => p !== ruta);
    // Una carpeta sin nada versionado todavía no existe: su sección lo dice.
    out.push(...(esCarpeta && versionados.length > 0 ? versionados : [ruta]));
  }
  return [...new Set(out)];
}

/** `contextoGraft` con topes elegidos. Lo usan los tests; el código usa `contextoGraft`. */
export async function armarContexto(opts: ContextoOpts, limites: Limites): Promise<string> {
  const corte = new AbortController();
  try {
    const hasta = Date.now() + limites.totalMs;
    const quedan = () => hasta - Date.now();
    const g: Graft = {
      repo: opts.repo,
      indexDir: opts.indexDir,
      env: opts.env,
      signal: corte.signal,
    };
    const todos = await expandir(opts.repo, opts.archivos, opts.env);
    const archivos = todos.slice(0, limites.archivos);
    const apis = await deAPocos(archivos, limites.paralelas, (a) => skeleton(g, a, quedan()));
    const nombres = [
      ...new Set(apis.flat().flatMap((e) => (LLAMABLES.has(e.kind) ? [e.name] : []))),
    ];
    const aConsultar = nombres.slice(0, limites.consultas);
    const respuestas = await deAPocos(aConsultar, limites.paralelas, async (nombre) => {
      try {
        return await callers(g, nombre, quedan());
      } catch (error) {
        if (error instanceof SinTiempo) return undefined;
        throw error;
      }
    });
    const omitidas =
      nombres.length - aConsultar.length + respuestas.filter((r) => r === undefined).length;
    const porNombre = new Map(aConsultar.map((n, i) => [n, respuestas[i]]));
    const secciones = archivos.map((archivo, i) => {
      const api = apis[i] ?? [];
      const llamadores = new Map<string, Llamador[]>();
      for (const e of api) {
        const matches = porNombre.get(e.name);
        if (matches === undefined) continue;
        llamadores.set(
          e.name,
          matches.filter((m) => m.symbol.path === archivo).flatMap((m) => m.hits),
        );
      }
      return seccionDe(archivo, api, llamadores);
    });
    return juntar(secciones, todos.length, opts.maxChars ?? MAX_CHARS, omitidas);
  } catch (error) {
    const motivo =
      error instanceof SinTiempo
        ? `graft no respondió en ${Math.round(limites.totalMs / 1000)} s`
        : error instanceof GraftError
          ? error.message
          : primeraLinea(error);
    return `(graft no pudo armar el contexto: ${motivo})`;
  } finally {
    // Después de una falla, `deAPocos` no espera a las consultas que estaban en curso.
    corte.abort();
  }
}

/** API de cada archivo y quién llama a lo que exporta, en Markdown. Nunca tira: si graft falla, lo dice en el texto. */
export function contextoGraft(opts: ContextoOpts): Promise<string> {
  return armarContexto(opts, LIMITES);
}

/** Los archivos que llaman a `simbolo`, relativos al repo. Para decidir qué conservar en un replan. */
export async function llamadoresDe(
  repo: string,
  indexDir: string,
  simbolo: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  let matches: Match[];
  try {
    matches = await callers({ repo, indexDir, env }, simbolo, LIMITES.totalMs);
  } catch (error) {
    if (error instanceof SinTiempo)
      throw new GraftError(`graft no respondió en ${LIMITES.totalMs / 1000} s`);
    throw error;
  }
  // Con un nombre repetido, la unión de todos los matches, como pide la spec. Pero graft 0.29 no
  // lista los llamadores de otros archivos de un nombre repetido («a cross-file caller of an
  // ambiguous name is dropped», en el `note` de cada match): la unión puede quedar corta. Pendiente
  // de decisión antes de la PR 09; ver «Pendiente» en el ADR 0022.
  const rutas = matches.flatMap((m) =>
    m.hits.flatMap((h) => (h.path === m.symbol.path ? [] : [h.path])),
  );
  return [...new Set(rutas)].sort();
}

function firma(signature: string): string {
  const una = signature.replace(/\s*[\r\n]+\s*/g, " ");
  return una.length > MAX_FIRMA ? `${una.slice(0, MAX_FIRMA - 1)}…` : una;
}

/** Puro: la sección Markdown de un archivo. La prueban los tests unitarios. */
export function seccionDe(
  archivo: string,
  api: readonly EntradaApi[],
  llamadores: ReadonlyMap<string, readonly Llamador[]>,
): string {
  const lineas = [`### \`${archivo}\``, ""];
  if (api.length === 0) lineas.push(SIN_DEFINICIONES);
  for (const entrada of api) {
    lineas.push(`- ${entrada.span} · \`${firma(entrada.signature)}\``);
    if (!LLAMABLES.has(entrada.kind)) continue;
    const vistas = new Set<string>();
    for (const hit of llamadores.get(entrada.name) ?? []) {
      // Los del mismo archivo no le sirven a la sub-task: ese archivo ya lo tiene a la vista.
      if (hit.path === archivo) continue;
      const linea =
        hit.kind === "file"
          ? `  - ← \`${hit.path}\` (archivo)`
          : `  - ← \`${hit.path}:${hit.span}\` (${hit.name})`;
      if (vistas.has(linea)) continue;
      vistas.add(linea);
      lineas.push(linea);
    }
  }
  return lineas.join("\n");
}

/** Puro: junta las secciones respetando `maxChars` y lo que quedó afuera. */
export function juntar(
  secciones: readonly string[],
  total: number,
  maxChars: number,
  consultasOmitidas: number,
): string {
  const dentro: string[] = [];
  let largo = 0;
  for (const seccion of secciones) {
    const suma = (dentro.length === 0 ? 0 : 2) + seccion.length;
    if (largo + suma > maxChars) break;
    dentro.push(seccion);
    largo += suma;
  }
  const notas: string[] = [];
  if (dentro.length < total)
    notas.push(
      `(Se cortó en ${dentro.length} de ${total} archivos por tamaño: leé el resto con Read.)`,
    );
  if (consultasOmitidas > 0)
    notas.push(
      `(Quedaron ${consultasOmitidas} consultas de llamadores sin hacer: buscalos con Grep si hace falta.)`,
    );
  return [...dentro, ...notas].join("\n\n");
}

/** Puro: agrega « · fuera de tu alcance» a cada línea de llamador cuya ruta no está en `alcance`. */
export function marcarFueraDeAlcance(texto: string, alcance: readonly string[]): string {
  return texto
    .split("\n")
    .map((linea) => {
      const ruta = LINEA_LLAMADOR.exec(linea)?.[1];
      if (ruta === undefined || alcance.some((a) => covers(a, ruta))) return linea;
      return `${linea} · fuera de tu alcance`;
    })
    .join("\n");
}
