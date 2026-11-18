// `flowrunner brain audit` y `brain apply`: una sesión de solo lectura revisa el cerebro de un repo
// contra su código y contra la historia de sus runs, y propone decisiones concretas, cada una con sus
// ediciones exactas a `.flowrunner/`. Nada se aplica solo: la persona elige cuáles, y van en una PR
// chica que revisa antes de mergear (ADR 0040).
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadBrain } from "../brain/brain.ts";
import { UserError } from "../cli/output.ts";
import { gitRootOf } from "../cli/project.ts";
import { flowrunnerHome, loadGlobalConfig, loadRepoConfig } from "../config/load.ts";
import { ConfigError } from "../config/schemas.ts";
import { initialState, reduce, type Halt } from "../engine/engine.ts";
import { addDetachedWorktree, fetchOrigin, git, GitError, removeWorktree } from "../git/git.ts";
import { render } from "../prompts/render.ts";
import { stats } from "../report/stats.ts";
import type { Deps, RunPaths } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import { listRunIds, runPaths } from "../store/runs.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import type { Progress } from "./draft.ts";
import { defaultBranch, hasBrain, openBrainPr } from "./init.ts";

const AUDIT_TIMEOUT_MS = 15 * 60_000;
/** La historia que ve la sesión: las detenciones más recientes, con sus respuestas. */
const MAX_HISTORIA = 160;

/**
 * Lo único que una decisión puede editar: los textos del cerebro, las propuestas y la config. Ni
 * `verify.sh`, que corre en cada run, ni `ejemplos/`, que son PRs de la persona.
 */
const PERMITIDO = /^\.flowrunner\/(?:[a-z0-9-]+\.md|propuestas\/[A-Za-z0-9._-]+\.md|config\.yaml)$/;
export const PERMITIDOS_TEXTO =
  "`.flowrunner/<archivo>.md`, `.flowrunner/propuestas/<clave>.md` o `.flowrunner/config.yaml`";

const edicionSchema = z.object({
  archivo: z.string().min(1).max(200),
  buscar: z.string().min(1).max(8_000),
  reemplazar: z.string().max(8_000),
});
const hallazgoSchema = z.object({
  id: z.string().regex(/^H\d+$/),
  tipo: z.enum(["contradiccion", "duplicada", "obsoleta", "sin_valor", "no_alcanzo", "falta"]),
  archivo: z.string().min(1).max(200),
  que: z.string().min(1).max(800),
  evidencia: z.string().min(1).max(1_200),
});
const decisionSchema = z.object({
  id: z.string().regex(/^D\d+$/),
  titulo: z.string().min(1).max(200),
  por_que: z.string().min(1).max(1_500),
  reduce: z.string().min(1).max(500),
  hallazgos: z.array(z.string().regex(/^H\d+$/)).max(20),
  ediciones: z.array(edicionSchema).min(1).max(10),
});
/** Lo que devuelve la sesión. Los campos van siempre: la salida estructurada no admite opcionales. */
export const auditoriaSchema = z.object({
  resumen: z.string().min(1).max(2_000),
  hallazgos: z.array(hallazgoSchema).max(40),
  decisiones: z.array(decisionSchema).max(15),
});
export type Auditoria = z.infer<typeof auditoriaSchema>;
export type Decision = z.infer<typeof decisionSchema>;

/** Una decisión como quedó guardada: si se puede aplicar y, si no, por qué. */
const decisionRevisadaSchema = decisionSchema.extend({
  aplicable: z.boolean(),
  motivo: z.string().nullable(),
});
export type DecisionRevisada = z.infer<typeof decisionRevisadaSchema>;

export const registroSchema = z.object({
  id: z.string().regex(/^\d{8}-\d{6}$/),
  proyecto: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
  /** El commit de la base que se auditó. */
  commit: z.string().min(1),
  fecha: z.iso.datetime(),
  costo_usd: z.number().nonnegative(),
  /** El sha256 de cada archivo que tocan las decisiones, como estaba al auditar. */
  archivos: z.record(z.string(), z.string()),
  resumen: z.string(),
  hallazgos: z.array(hallazgoSchema),
  decisiones: z.array(decisionRevisadaSchema),
  aplicadas: z.array(
    z.object({ decisiones: z.array(z.string()), pr: z.string(), at: z.iso.datetime() }),
  ),
});
export type Registro = z.infer<typeof registroSchema>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Las veces que aparece `buscar` en `text`, sin solaparse. */
function ocurrencias(text: string, buscar: string): number {
  let n = 0;
  for (let at = text.indexOf(buscar); at !== -1; at = text.indexOf(buscar, at + buscar.length)) n++;
  return n;
}

/** El archivo normalizado si una decisión lo puede editar; undefined si no. */
export function archivoPermitido(archivo: string): string | undefined {
  const norm = posix.normalize(archivo.replace(/^\.\//, ""));
  return PERMITIDO.test(norm) && norm === archivo.replace(/^\.\//, "") ? norm : undefined;
}

/**
 * Aplica las ediciones a los textos, en orden; `undefined` si alguna no encuentra su `buscar` una
 * sola vez. Lo de `textos` no cambia: devuelve una copia.
 */
export function aplicarEdiciones(
  textos: ReadonlyMap<string, string>,
  ediciones: readonly z.infer<typeof edicionSchema>[],
): { textos: Map<string, string> } | { motivo: string } {
  const out = new Map(textos);
  for (const e of ediciones) {
    const archivo = archivoPermitido(e.archivo);
    if (archivo === undefined)
      return { motivo: `${e.archivo} no se puede editar: solo ${PERMITIDOS_TEXTO}` };
    const text = out.get(archivo);
    if (text === undefined) return { motivo: `${archivo} no existe` };
    const n = ocurrencias(text, e.buscar);
    if (n !== 1)
      return {
        motivo:
          n === 0
            ? `en ${archivo} no está el texto a cambiar`
            : `en ${archivo} el texto a cambiar aparece ${String(n)} veces`,
      };
    out.set(
      archivo,
      text.replace(e.buscar, () => e.reemplazar),
    );
  }
  return { textos: out };
}

/**
 * Los textos de los archivos que nombran las ediciones, leídos de `root`: los que existen y son
 * archivos de verdad. Un link no: escribirlo editaría lo que apunta, fuera del cerebro, como
 * `loadBrain`, que tampoco los sigue.
 */
function leerArchivos(root: string, decisiones: readonly Decision[]): Map<string, string> {
  const textos = new Map<string, string>();
  const real = realpathSync(root);
  for (const d of decisiones)
    for (const e of d.ediciones) {
      const archivo = archivoPermitido(e.archivo);
      if (archivo === undefined || textos.has(archivo)) continue;
      const file = join(real, archivo);
      if (!existsSync(file) || !lstatSync(file).isFile()) continue;
      // Una carpeta del camino que es un link, como `.flowrunner/propuestas` → `~/.claude`, también
      // saca la escritura del cerebro: el camino real tiene que ser el mismo.
      if (realpathSync(dirname(file)) !== dirname(file)) continue;
      textos.set(archivo, readFileSync(file, "utf8"));
    }
  return textos;
}

/**
 * Cada decisión, revisada sola contra el cerebro auditado: si sus ediciones se pueden aplicar tal
 * cual. Una que no, queda en el informe con su motivo y no se puede elegir.
 */
export function revisarDecisiones(
  root: string,
  auditoria: Auditoria,
): { decisiones: DecisionRevisada[]; archivos: Record<string, string> } {
  const textos = leerArchivos(root, auditoria.decisiones);
  const vistos = new Set<string>();
  const decisiones = auditoria.decisiones.map((d): DecisionRevisada => {
    if (vistos.has(d.id)) return { ...d, aplicable: false, motivo: `${d.id} está repetida` };
    vistos.add(d.id);
    const r = aplicarEdiciones(textos, d.ediciones);
    return "motivo" in r
      ? { ...d, aplicable: false, motivo: r.motivo }
      : { ...d, aplicable: true, motivo: null };
  });
  return {
    decisiones,
    archivos: Object.fromEntries([...textos].map(([archivo, text]) => [archivo, sha256(text)])),
  };
}

// --- La historia de los runs -----------------------------------------------------------------

const primera = (text: string) => (text.split("\n")[0] ?? "").slice(0, 300);

/** Qué respondió la persona a una detención, en palabras; undefined si el evento no es respuesta. */
function respuesta(e: RunEvent, halt: Halt | undefined): string | undefined {
  switch (e.tipo) {
    case "arreglo_pedido": {
      const propuestos = (halt?.opciones ?? []).flatMap((o) =>
        o.arreglo === undefined ? [] : [o.arreglo],
      );
      const i = propuestos.findIndex(
        (a) => a.instruccion === e.instruccion && e.unidades.includes(a.unidad),
      );
      return i === -1
        ? `pidió a ${e.unidades.join(", ")}: ${primera(e.instruccion)}`
        : `eligió el arreglo propuesto ${String(i + 1)} de ${String(propuestos.length)}`;
    }
    case "aceptado":
      return `siguió igual: ${primera(e.motivo)}`;
    case "sin_probar_aceptado":
      return `entregó sin probar: ${primera(e.motivo)}`;
    case "autofix":
      return e.origen === "flowrunner" ? undefined : "eligió Autofix";
    case "rehacer":
      return `rehízo desde ${e.desde}`;
    case "reanudado":
      return "lo retomó sin cambiar nada";
    case "arreglo_manual_iniciado":
      return "lo arregló a mano";
    case "abortado":
      return "abortó el run";
    default:
      return undefined;
  }
}

/**
 * La historia de los runs del proyecto, para la sesión: cada detención con su motivo y lo que
 * respondió la persona, los cambios que pidió al plan y los motivos que más se repiten.
 */
export function historiaDe(home: string, proyecto: string): string {
  const lineas: string[] = [];
  let runs = 0;
  for (const id of listRunIds(home)) {
    const dir = runPaths(home, id).dir;
    if (!existsSync(join(dir, "events.jsonl"))) continue;
    const { events } = readLog(dir);
    let state = initialState();
    let detenido: Halt | undefined;
    const propias: string[] = [];
    for (const e of events) {
      const next = reduce(state, e);
      if (detenido !== undefined) {
        const r = respuesta(e, detenido);
        if (r !== undefined) {
          propias.push(`  → la persona ${r}`);
          detenido = undefined;
        }
      }
      if (e.tipo === "cambios_pedidos")
        propias.push(`- pidió cambios al plan: ${primera(e.motivo)}`);
      if (next.status === "detenido" && state.status !== "detenido" && next.halt !== undefined) {
        detenido = next.halt;
        propias.push(`- se detuvo en ${next.fase}: ${primera(next.halt.motivo)}`);
      }
      state = next;
    }
    if (state.proyecto !== proyecto) continue;
    runs++;
    lineas.push(
      `### ${state.clave} (${state.status})`,
      ...(propias.length === 0 ? ["- sin detenciones"] : propias),
    );
  }
  if (runs === 0) return "(este repo todavía no tiene runs)";
  const s = stats(home, proyecto);
  const motivos = s.motivos.map((m) => `- ${String(m.veces)}× ${m.motivo}`);
  const recientes = lineas.slice(-MAX_HISTORIA);
  return [
    `${String(runs)} runs.`,
    ...(recientes.length < lineas.length ? ["(solo lo más reciente)"] : []),
    "",
    ...recientes,
    "",
    "### Motivos que más se repiten",
    ...(motivos.length === 0 ? ["- (ninguno)"] : motivos),
  ].join("\n");
}

// --- El proyecto ------------------------------------------------------------------------------

async function commonDir(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return realpathSync(resolve(dir, await git(dir, ["rev-parse", "--git-common-dir"], env)));
  } catch (error) {
    if (error instanceof GitError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
}

/**
 * El proyecto registrado al que pertenece una ruta, también desde uno de sus worktrees, como el que
 * tiene enfocado Orca.
 */
export async function proyectoDe(
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly nombre: string; readonly repo: string }> {
  const root = await gitRootOf(path, env).catch((error: unknown) => {
    if (error instanceof UserError)
      throw new UserError(`${path} no es un proyecto de flowrunner: no es un repo git`);
    throw error;
  });
  const mine = await commonDir(root, env);
  for (const p of loadGlobalConfig(env).projects) {
    if (mine !== undefined && (await commonDir(p.path, env)) === mine)
      return { nombre: p.name, repo: p.path };
  }
  throw new UserError(
    `${root} no es un proyecto de flowrunner`,
    `flowrunner init ${root} --aplicar`,
  );
}

const auditoriasDir = (home: string, proyecto: string) => join(home, "auditorias", proyecto);
const AUDIT_REF = /^([a-z0-9-]+)\/(\d{8}-\d{6})$/;

function stampOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function guardar(home: string, registro: Registro): { json: string; md: string } {
  const dir = auditoriasDir(home, registro.proyecto);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `${registro.id}.json`);
  const md = join(dir, `${registro.id}.md`);
  writeFileSync(json, `${JSON.stringify(registro, null, 2)}\n`);
  writeFileSync(md, informe(registro));
  return { json, md };
}

/** La última auditoría del proyecto, o undefined si nunca se auditó. */
export function ultimaAuditoria(
  home: string,
  proyecto: string,
): { registro: Registro; md: string } | undefined {
  const dir = auditoriasDir(home, proyecto);
  if (!existsSync(dir)) return undefined;
  const last = readdirSync(dir)
    .filter((f) => /^\d{8}-\d{6}\.json$/.test(f))
    .sort()
    .at(-1);
  if (last === undefined) return undefined;
  return { registro: leerRegistro(join(dir, last)), md: join(dir, last.replace(/\.json$/, ".md")) };
}

function leerRegistro(file: string): Registro {
  try {
    return registroSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new UserError(
      `no se entiende la auditoría ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const TIPO: Record<z.infer<typeof hallazgoSchema>["tipo"], string> = {
  contradiccion: "contradicción",
  duplicada: "duplicada",
  obsoleta: "obsoleta",
  sin_valor: "sin valor",
  no_alcanzo: "no alcanzó",
  falta: "falta",
};

/** El informe para la persona: lo que se abre como pestaña de Orca o se lee en la terminal. */
export function informe(r: Registro): string {
  const aplicada = (id: string) => r.aplicadas.find((a) => a.decisiones.includes(id));
  return [
    `# Auditoría del cerebro de ${r.proyecto}`,
    "",
    `${r.fecha.slice(0, 16).replace("T", " ")} · origin/${r.base} en \`${r.commit.slice(0, 7)}\` · USD ${r.costo_usd.toFixed(2)}`,
    "",
    r.resumen,
    "",
    "## Hallazgos",
    "",
    ...(r.hallazgos.length === 0
      ? ["Ninguno."]
      : r.hallazgos.map(
          (h) => `- **${h.id} · ${TIPO[h.tipo]}** (\`${h.archivo}\`): ${h.que}\n  ${h.evidencia}`,
        )),
    "",
    "## Decisiones",
    "",
    ...(r.decisiones.length === 0
      ? ["Ninguna: el cerebro está bien así."]
      : r.decisiones.flatMap((d) => {
          const pr = aplicada(d.id);
          return [
            `### ${d.id} · ${d.titulo}`,
            "",
            pr !== undefined
              ? `En la PR ${pr.pr}.`
              : d.aplicable
                ? `Para aplicarla: \`flowrunner brain apply ${r.proyecto}/${r.id} --decision ${d.id}\``
                : `No se puede aplicar: ${d.motivo ?? ""}`,
            "",
            `**Por qué:** ${d.por_que}`,
            "",
            `**Qué reduce:** ${d.reduce}`,
            "",
            ...d.ediciones.flatMap((e) => [
              `\`${e.archivo}\`:`,
              "",
              "```diff",
              ...e.buscar.split("\n").map((l) => `- ${l}`),
              ...(e.reemplazar === "" ? [] : e.reemplazar.split("\n").map((l) => `+ ${l}`)),
              "```",
              "",
            ]),
          ];
        })),
  ].join("\n");
}

// --- Auditar ----------------------------------------------------------------------------------

export interface AuditarResultado {
  readonly ok: true;
  readonly id: string;
  readonly proyecto: string;
  readonly informe: string;
  readonly hallazgos: number;
  readonly decisiones: number;
  readonly aplicables: number;
  readonly costo_usd: number;
}

const CEREBRO = [
  ".flowrunner/contexto.md",
  ".flowrunner/convenciones.md",
  ".flowrunner/que-es-bien.md",
  ".flowrunner/lecciones.md",
  ".flowrunner/lecciones-detalle.md",
  ".flowrunner/config.yaml",
];

/** La sesión de solo lectura, como la del borrador: Read, Grep y Glob, sin escribir ni Bash. */
function readOnlyHook(root: string) {
  return tripwireHook(
    {
      scope: {
        root,
        owner: "revisar",
        writable: [],
        writeGlobs: [],
        locked: [],
        harness: [],
        lockfiles: [],
        manifests: [],
        depsDeclared: false,
        testGlobs: [],
        comandos: SIN_COMANDOS,
      },
      fase: "revisar",
      write: false,
      bash: false,
      agents: false,
      graft: false,
    },
    () => undefined,
  );
}

/** Dónde queda el stream de la sesión, que no es de un run. */
function auditSession(home: string, proyecto: string): RunPaths {
  return {
    id: `auditar-${proyecto}`,
    home,
    dir: join(home, "auditorias", proyecto),
    worktrees: join(home, "init"),
  };
}

export async function auditBrain(
  path: string,
  deps: Deps,
  progress: Progress,
): Promise<AuditarResultado> {
  const { env } = deps;
  const home = flowrunnerHome(env);
  const { nombre, repo } = await proyectoDe(path, env);
  progress("trayendo origin");
  await fetchOrigin(repo, env);
  const base = await defaultBranch(repo, env);
  if (!(await hasBrain(repo, base, env)))
    throw new UserError(`origin/${base} no tiene cerebro`, `flowrunner init ${repo} --aplicar`);
  const worktree = join(home, "init", `${nombre}-auditoria`);
  progress(`preparando un worktree limpio de origin/${base}`);
  await removeWorktree(repo, worktree, env);
  await addDetachedWorktree(repo, worktree, `origin/${base}`, env);
  try {
    const root = realpathSync(worktree);
    const commit = await git(root, ["rev-parse", "HEAD"], env);
    const propuestas = existsSync(join(root, ".flowrunner", "propuestas"))
      ? readdirSync(join(root, ".flowrunner", "propuestas"))
          .filter((f) => f.endsWith(".md"))
          .map((f) => `.flowrunner/propuestas/${f}`)
      : [];
    const archivos = [...CEREBRO, ...propuestas].filter((f) => existsSync(join(root, f)));
    progress(
      "Claude lee el cerebro, el código y la historia de los runs: puede tardar unos minutos",
    );
    const config = loadRepoConfig(root);
    // Como el borrador: no es una fase de un run. Usa el modelo de revisar, que es la otra sesión que
    // juzga lo escrito contra el código sin cambiarlo.
    const result = await runSession(
      {
        fase: "revisar",
        nombre: "auditar-cerebro",
        prompt: render("auditar-cerebro", {
          archivos: archivos.map((f) => `\`${f}\``).join(", "),
          historia: historiaDe(home, nombre),
          permitidos: PERMITIDOS_TEXTO,
        }),
        cwd: root,
        model: config.models.revisar,
        tools: ["Read", "Grep", "Glob"],
        hook: readOnlyHook(root),
        schema: auditoriaSchema,
        timeoutMs: AUDIT_TIMEOUT_MS,
      },
      { run: auditSession(home, nombre), deps, emit: () => undefined },
    );
    if (result.tipo === "limite")
      throw new UserError(
        `Claude llegó a su límite hasta ${new Date(result.hasta).toLocaleTimeString("es-AR")}`,
        `flowrunner brain audit ${repo}`,
      );
    if (result.tipo === "falla") throw new UserError(`no se pudo auditar: ${result.motivo}`);
    const revisadas = revisarDecisiones(root, result.output);
    const now = deps.now();
    const registro: Registro = {
      id: stampOf(now),
      proyecto: nombre,
      repo,
      base,
      commit,
      fecha: now.toISOString(),
      costo_usd: result.costoUsd,
      archivos: revisadas.archivos,
      resumen: result.output.resumen,
      hallazgos: result.output.hallazgos,
      decisiones: revisadas.decisiones,
      aplicadas: [],
    };
    const { md } = guardar(home, registro);
    return {
      ok: true,
      id: registro.id,
      proyecto: nombre,
      informe: md,
      hallazgos: registro.hallazgos.length,
      decisiones: registro.decisiones.length,
      aplicables: registro.decisiones.filter((d) => d.aplicable).length,
      costo_usd: registro.costo_usd,
    };
  } finally {
    await removeWorktree(repo, worktree, env);
  }
}

export function describeAuditar(r: AuditarResultado): string {
  return `auditoría ${r.proyecto}/${r.id} (USD ${r.costo_usd.toFixed(2)}): ${String(r.hallazgos)} hallazgos, ${String(r.decisiones)} decisiones, ${String(r.aplicables)} para aplicar. El informe: ${r.informe}`;
}

// --- Aplicar ----------------------------------------------------------------------------------

export interface AplicarResultado {
  readonly ok: true;
  readonly pr: string;
  readonly aplicadas: readonly string[];
  readonly rechazadas: readonly { readonly id: string; readonly motivo: string }[];
}

/** `<proyecto>/<id>` de una auditoría guardada. */
export function auditoriaRef(ref: string): { proyecto: string; id: string } {
  const m = AUDIT_REF.exec(ref);
  if (m?.[1] === undefined || m[2] === undefined)
    throw new UserError(`auditoría inválida: ${ref}`, "flowrunner brain audit <ruta> --ultima");
  return { proyecto: m[1], id: m[2] };
}

/**
 * Aplica las decisiones elegidas sobre el cerebro de hoy de la base y abre su PR. Una decisión cuyo
 * archivo cambió desde la auditoría, o que choca con otra elegida, no se aplica y la PR lo dice. Si
 * no queda ninguna, o el cerebro resultante no carga, no se abre nada.
 */
export async function applyAudit(
  ref: string,
  elegidas: readonly string[],
  deps: Deps,
  progress: Progress,
): Promise<AplicarResultado> {
  const { env } = deps;
  const home = flowrunnerHome(env);
  const { proyecto, id } = auditoriaRef(ref);
  if (elegidas.length === 0)
    throw new UserError(
      "elegí al menos una decisión",
      `flowrunner brain apply ${ref} --decision D1`,
    );
  const file = join(auditoriasDir(home, proyecto), `${id}.json`);
  if (!existsSync(file))
    throw new UserError(`no hay una auditoría ${ref}`, "flowrunner brain audit <ruta> --ultima");
  const registro = leerRegistro(file);
  const rechazadas: { id: string; motivo: string }[] = [];
  const pedidas: DecisionRevisada[] = [];
  for (const eid of [...new Set(elegidas)]) {
    const d = registro.decisiones.find((x) => x.id === eid);
    const ya = registro.aplicadas.find((a) => a.decisiones.includes(eid));
    if (d === undefined) rechazadas.push({ id: eid, motivo: "no está en la auditoría" });
    else if (!d.aplicable) rechazadas.push({ id: eid, motivo: d.motivo ?? "no se puede aplicar" });
    else if (ya !== undefined) rechazadas.push({ id: eid, motivo: `ya está en la PR ${ya.pr}` });
    else pedidas.push(d);
  }
  if (pedidas.length === 0)
    throw new UserError(
      `ninguna decisión se puede aplicar:\n${rechazadas.map((r) => `- ${r.id}: ${r.motivo}`).join("\n")}`,
    );

  progress("trayendo origin");
  await fetchOrigin(registro.repo, env);
  const worktree = join(home, "init", `${proyecto}-aplicar`);
  await removeWorktree(registro.repo, worktree, env);
  await addDetachedWorktree(registro.repo, worktree, `origin/${registro.base}`, env);
  try {
    const root = realpathSync(worktree);
    // Si cambió se compara contra lo de la base; las ediciones se encadenan sobre `textos`: dos
    // decisiones elegidas sobre el mismo archivo entran juntas si no chocan.
    const originales = leerArchivos(root, pedidas);
    let textos: ReadonlyMap<string, string> = originales;
    const aplicadas: DecisionRevisada[] = [];
    for (const d of pedidas) {
      const cambiado = d.ediciones
        .map((e) => archivoPermitido(e.archivo) ?? e.archivo)
        .find((a) => {
          const text = originales.get(a);
          return text === undefined || sha256(text) !== registro.archivos[a];
        });
      if (cambiado !== undefined) {
        rechazadas.push({
          id: d.id,
          motivo: `${cambiado} cambió desde la auditoría: volvé a auditar`,
        });
        continue;
      }
      const r = aplicarEdiciones(textos, d.ediciones);
      if ("motivo" in r) {
        rechazadas.push({ id: d.id, motivo: `choca con otra elegida: ${r.motivo}` });
        continue;
      }
      textos = r.textos;
      aplicadas.push(d);
    }
    if (aplicadas.length === 0)
      throw new UserError(
        `ninguna decisión se puede aplicar:\n${rechazadas.map((r) => `- ${r.id}: ${r.motivo}`).join("\n")}`,
        `flowrunner brain audit ${registro.repo}`,
      );
    for (const [archivo, text] of textos) writeFileSync(join(root, archivo), text);
    // Lo que no carga frenaría el próximo run de este repo en preparar: no se propone.
    try {
      loadBrain(root);
      loadRepoConfig(root);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw new UserError(
        `con esas decisiones el cerebro no carga: ${error.message}`,
        `flowrunner brain audit ${registro.repo}`,
      );
    }
    const ids = aplicadas.map((d) => d.id);
    progress("abriendo la PR");
    const pr = await openBrainPr(
      root,
      {
        branch: `chore/flowrunner-auditoria-${id}-${ids.join("-").toLowerCase()}`,
        base: registro.base,
        title: `chore(cerebro): ${ids.join(", ")} de la auditoría ${id}`,
        body: [
          `Las decisiones que elegiste de la auditoría del cerebro del ${registro.fecha.slice(0, 10)} (\`flowrunner brain audit\`). Revisá cada cambio antes de mergear: los próximos runs leen el cerebro de la base.`,
          "",
          ...aplicadas.flatMap((d) => [
            `## ${d.id} · ${d.titulo}`,
            "",
            `**Por qué:** ${d.por_que}`,
            "",
            `**Qué reduce:** ${d.reduce}`,
            "",
          ]),
          ...(rechazadas.length === 0
            ? []
            : ["## No entraron", "", ...rechazadas.map((r) => `- ${r.id}: ${r.motivo}`)]),
        ],
      },
      env,
    );
    const actualizado: Registro = {
      ...registro,
      aplicadas: [
        ...registro.aplicadas,
        { decisiones: ids, pr: pr.url, at: deps.now().toISOString() },
      ],
    };
    guardar(home, actualizado);
    return { ok: true, pr: pr.url, aplicadas: ids, rechazadas };
  } finally {
    await removeWorktree(registro.repo, worktree, env);
  }
}

export function describeAplicar(r: AplicarResultado): string {
  return [
    `${r.pr}: ${r.aplicadas.join(", ")}; revisala y mergeala`,
    ...r.rechazadas.map((x) => `no entró ${x.id}: ${x.motivo}`),
  ].join("\n");
}
