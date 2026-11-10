// El primer borrador del cerebro que redacta `flowrunner init` leyendo el código del repo: las
// convenciones, el contexto con lo que conviene reusar y qué es una buena PR. Va en una sección
// propia de cada archivo, marcada como inferida, para que la persona sepa qué revisar en la PR.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES, brainDir, DRAFT_HEADING, withCurrentTemplate } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import { ConfigError, type RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { render } from "../prompts/render.ts";
import type { Deps, QueryFn, RunPaths } from "../runner/types.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";

export { DRAFT_HEADING };

/** Una línea de avance para la persona que espera en la terminal. */
export type Progress = (line: string) => void;
export const DRAFT_TIMEOUT_MS = 15 * 60_000;
/** Cada texto, bien por debajo del tope de 16.000 caracteres de su archivo. */
const MAX_TEXT = 6_000;
const MAX_LISTED_FILES = 400;
const MAX_PACKAGE_JSON = 4_000;
const MAX_DOCS = 60;

/**
 * Lo que el repo ya escribió para personas y agentes: instrucciones de agentes, reglas, docs, ADRs y
 * el CI. El primer borrador las ignoraba: redescubría del código, con menos detalle, invariantes que
 * ya estaban escritas con su porqué.
 */
const DOCS =
  /(^|\/)(CLAUDE|AGENTS|CONTRIBUTING|ARCHITECTURE|README)\.md$|^\.claude\/rules\/|^\.cursor\/rules\/|^\.cursorrules$|^\.github\/copilot-instructions\.md$|^\.github\/workflows\/[^/]+\.ya?ml$|^docs?\/.+\.md$|^\.nvmrc$|^\.node-version$/;

/** Los archivos de documentación del repo, los de la raíz primero; nunca el cerebro mismo. */
export function docFiles(files: readonly string[]): string[] {
  const depth = (f: string) => f.split("/").length;
  return files
    .filter((f) => DOCS.test(f) && !f.startsWith(".flowrunner/") && !f.includes("node_modules/"))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

const part = z.object({
  texto: z.string().min(1).max(MAX_TEXT),
  fuentes: z.array(z.string().min(1)).min(1).max(40),
});
/**
 * Cómo levanta la fase probar el entorno, deducido del repo. `config` null si no se puede levantar
 * seguro, sin datos reales ni servicios de afuera: `motivo` dice qué falta. Los campos van siempre,
 * con null, porque la salida estructurada no admite opcionales.
 */
const probarPart = z.object({
  config: z
    .object({
      levantar: z.string().min(1),
      sigue_corriendo: z.boolean(),
      bajar: z.string().min(1).nullable(),
      urls: z.record(z.string().min(1), z.string().min(1)),
      notas: z.string(),
    })
    .nullable(),
  motivo: z.string().min(1).max(1_500),
  fuentes: z.array(z.string().min(1)).min(1).max(20),
});
export const draftSchema = z.object({
  convenciones: part,
  contexto: part,
  que_es_bien: part,
  probar: probarPart,
});
export type Draft = z.infer<typeof draftSchema>;
type BrainKey = Exclude<keyof Draft, "probar">;

/** Lo que pasó con `probar` en la config: lo propuso el borrador, faltó, o ya estaba. */
export type ProbarDraft =
  | {
      readonly tipo: "propuesto";
      readonly levantar: string;
      readonly urls: string[];
      readonly motivo: string;
    }
  | { readonly tipo: "falta"; readonly motivo: string }
  | { readonly tipo: "ya estaba" };

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Las URLs que no son de esta máquina: probar nunca va contra un entorno de afuera. */
export function nonLocalUrls(urls: Readonly<Record<string, string>>): string[] {
  return Object.values(urls).filter((u) => {
    try {
      return !LOCAL.has(new URL(u).hostname);
    } catch {
      return true;
    }
  });
}

export const PROBAR_COMMENT = [
  "# Lo propuso flowrunner init leyendo el repo, sin revisión humana. La fase probar corre `levantar`",
  "# en tu máquina en cada run: revisá que sea local y que no toque datos reales antes de mergear.",
];

/**
 * El `config.yaml` con la sección `probar` propuesta al final, comentada; o, si la propuesta no sirve
 * (sin config, sin URLs o con URLs de afuera), el `motivo`.
 */
export function withProbar(
  current: string,
  probar: Draft["probar"],
): { readonly text: string } | { readonly motivo: string } {
  const { config } = probar;
  if (config === null) return { motivo: probar.motivo };
  if (Object.keys(config.urls).length === 0) return { motivo: "no propuso ninguna URL" };
  const afuera = nonLocalUrls(config.urls);
  if (afuera.length > 0)
    return { motivo: `propuso URLs que no son de esta máquina: ${afuera.join(", ")}` };
  const section = {
    probar: {
      levantar: config.levantar,
      sigue_corriendo: config.sigue_corriendo,
      ...(config.bajar === null ? {} : { bajar: config.bajar }),
      urls: config.urls,
      ...(config.notas.trim() === "" ? {} : { notas: config.notas.trim() }),
    },
  };
  return { text: [current.trimEnd(), "", ...PROBAR_COMMENT, stringify(section)].join("\n") };
}

/**
 * Suma `probar` a la config del worktree si no lo tenía, y comprueba que la config la acepte; si no,
 * la deja como estaba.
 */
function writeProbar(worktree: string, config: RepoConfig, probar: Draft["probar"]): ProbarDraft {
  if (config.probar !== undefined) return { tipo: "ya estaba" };
  const file = join(worktree, ".flowrunner", "config.yaml");
  const current = readFileSync(file, "utf8");
  const next = withProbar(current, probar);
  if ("motivo" in next) return { tipo: "falta", motivo: next.motivo };
  writeFileSync(file, next.text);
  try {
    loadRepoConfig(worktree);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    writeFileSync(file, current);
    return { tipo: "falta", motivo: `la config no acepta lo que propuso: ${error.message}` };
  }
  return {
    tipo: "propuesto",
    levantar: probar.config?.levantar ?? "",
    urls: Object.values(probar.config?.urls ?? {}),
    motivo: probar.motivo,
  };
}

const TARGETS: Record<BrainKey, { readonly file: string; readonly max: number }> = {
  convenciones: BRAIN_FILES.convenciones,
  contexto: BRAIN_FILES.contexto,
  que_es_bien: BRAIN_FILES.queEsBien,
};

/** Las fuentes que no son un archivo versionado ni una carpeta que tenga alguno. */
export function inventedSources(draft: Draft, files: readonly string[]): string[] {
  const known = (source: string) => {
    const path = source.replace(/^\.\//, "").replace(/\/+$/, "");
    return path !== "" && files.some((f) => f === path || f.startsWith(`${path}/`));
  };
  const sources = Object.values(draft).flatMap((p) => p.fuentes);
  return [...new Set(sources)].filter((s) => !known(s));
}

/**
 * Lo que escribe la persona queda arriba; el borrador, abajo, en una sección que dice de qué commit
 * salió. Las fuentes no se repiten al final: cada regla ya cita su archivo, y la lista entera se
 * cargaba en cada prompt de cada run.
 */
export function withDraft(
  current: string,
  draft: Draft[BrainKey],
  today: string,
  commit: string,
): string {
  return [
    current.trimEnd(),
    "",
    DRAFT_HEADING,
    "",
    `> Lo dedujo \`flowrunner init\` del repo en \`${commit}\` el ${today}, sin revisión humana.`,
    "> Corregí o borrá lo que no sea así; lo que escribas vos va arriba de esta sección.",
    "",
    draft.texto.trim(),
    "",
  ].join("\n");
}

/** El archivo sin la sección del borrador, que `withDraft` siempre deja al final. */
export function withoutDraft(text: string): string {
  const at = text.indexOf(DRAFT_HEADING);
  return at === -1 ? text : `${text.slice(0, at).trimEnd()}\n`;
}

export interface DraftInput {
  readonly worktree: string;
  /** `git ls-files` de la base. */
  readonly files: readonly string[];
  /** Lo que flowrunner ya sabe del repo: lo inferido por init o la config existente. */
  readonly hallazgos: readonly { readonly que: string; readonly detalle: string }[];
  readonly config: RepoConfig;
  /** Dónde queda el stream de la sesión: init no tiene un run propio. */
  readonly session: RunPaths;
  readonly deps: Deps;
  readonly progress: Progress;
}

/** Qué está mirando la sesión, en palabras: `lee src/a.ts`. Undefined si no es una lectura. */
export function describeToolUse(name: string, input: unknown, root: string): string | undefined {
  const field = (key: string): string | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" ? value : undefined;
  };
  const rel = (path: string) => {
    if (!isAbsolute(path)) return path;
    const inside = relative(root, path);
    return inside === "" ? "." : inside.startsWith("..") ? path : inside;
  };
  const path = field("path");
  const where = path === undefined ? "" : ` en ${rel(path)}`;
  switch (name) {
    case "Read": {
      const file = field("file_path");
      return file === undefined ? undefined : `lee ${rel(file)}`;
    }
    case "Grep":
      return `busca «${field("pattern") ?? ""}»${where}`;
    case "Glob":
      return `lista ${field("pattern") ?? ""}${where}`;
    default:
      return undefined;
  }
}

/** La misma `query`, avisando cada herramienta que la sesión usa. */
function reporting(query: QueryFn, root: string, progress: Progress): QueryFn {
  return (params) =>
    (async function* () {
      for await (const message of query(params)) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "tool_use") continue;
            const line = describeToolUse(block.name, block.input, root);
            if (line !== undefined) progress(`  ${line}`);
          }
        }
        yield message;
      }
    })();
}

export type DraftResult =
  | { readonly tipo: "ok"; readonly costoUsd: number; readonly probar: ProbarDraft }
  | { readonly tipo: "falla"; readonly motivo: string };

function promptVars(
  input: DraftInput,
  commits: string,
  current: Readonly<Record<BrainKey, string>>,
): Record<string, string> {
  const listed = input.files.slice(0, MAX_LISTED_FILES);
  const rest = input.files.length - listed.length;
  let packageJson: string;
  try {
    packageJson = readFileSync(join(input.worktree, "package.json"), "utf8");
  } catch {
    packageJson = "(no hay)";
  }
  const docs = docFiles(input.files);
  return {
    documentacion:
      docs.length === 0
        ? "(no hay)"
        : [
            ...docs.slice(0, MAX_DOCS),
            ...(docs.length > MAX_DOCS
              ? [`… y ${String(docs.length - MAX_DOCS)} más: usá Glob para verlos`]
              : []),
          ].join("\n"),
    hallazgos: input.hallazgos.map((h) => `- ${h.que}: ${h.detalle}`).join("\n"),
    probar_actual:
      input.config.probar === undefined
        ? "La config no tiene `probar`: proponelo."
        : "La config ya tiene `probar`: devolvé `config` en null y en `motivo`, «ya estaba».",
    cerebro: (Object.keys(TARGETS) as BrainKey[])
      .map((key) => `## ${TARGETS[key].file}\n\n${current[key].trim()}`)
      .join("\n\n"),
    stack:
      packageJson.length > MAX_PACKAGE_JSON
        ? `${packageJson.slice(0, MAX_PACKAGE_JSON)}\n… (cortado)`
        : packageJson,
    commits: commits.trim() === "" ? "(ninguno)" : commits.trim(),
    archivos: [
      ...listed,
      ...(rest > 0 ? [`… y ${String(rest)} más: usá Glob para verlos`] : []),
    ].join("\n"),
  };
}

/**
 * Una sesión de solo lectura sobre un worktree con el cerebro redacta el borrador y, si todas sus
 * fuentes existen y cada archivo sigue dentro de su tope, lo agrega a los tres. Si no, no escribe nada.
 */
export async function draftBrain(input: DraftInput): Promise<DraftResult> {
  const { worktree, deps } = input;
  const pathOf = (key: BrainKey) => join(brainDir(worktree), TARGETS[key].file);
  // Una plantilla vieja que nadie editó no queda arriba del borrador nuevo.
  const read = (key: BrainKey) =>
    withCurrentTemplate(TARGETS[key].file, readFileSync(pathOf(key), "utf8"));
  const current = {
    convenciones: read("convenciones"),
    contexto: read("contexto"),
    que_es_bien: read("que_es_bien"),
  };
  const commits = await git(worktree, ["log", "-n", "20", "--no-merges", "--format=%s"], deps.env);
  const commit = (await git(worktree, ["rev-parse", "--short", "HEAD"], deps.env)).trim();
  const root = realpathSync(worktree);
  input.progress("Claude lee el código y redacta el borrador: puede tardar unos minutos");
  // Init no es una fase de un run: la sesión usa la etiqueta y el modelo de planificar, que es la
  // otra que lee el repo para entenderlo antes de actuar.
  const result = await runSession(
    {
      fase: "planificar",
      nombre: "borrador-cerebro",
      prompt: render("borrador-cerebro", promptVars(input, commits, current)),
      cwd: root,
      model: input.config.models.planificar,
      tools: ["Read", "Grep", "Glob"],
      hook: tripwireHook(
        {
          scope: {
            root,
            owner: "planificar",
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
          fase: "planificar",
          write: false,
          bash: false,
          agents: false,
          graft: false,
        },
        () => undefined,
      ),
      schema: draftSchema,
      // Sin tope de gasto: un borrador cortado a mitad no deja nada y obliga a pagar otra vuelta.
      timeoutMs: DRAFT_TIMEOUT_MS,
    },
    {
      run: input.session,
      deps: { ...deps, query: reporting(deps.query, root, input.progress) },
      emit: () => undefined,
    },
  );
  if (result.tipo === "limite") {
    return {
      tipo: "falla",
      motivo: `Claude llegó a su límite hasta ${new Date(result.hasta).toLocaleTimeString("es-AR")}`,
    };
  }
  if (result.tipo === "falla") return { tipo: "falla", motivo: result.motivo };
  const invented = inventedSources(result.output, input.files);
  if (invented.length > 0) {
    return {
      tipo: "falla",
      motivo: `cita archivos que no están en el repo: ${invented.join(", ")}`,
    };
  }
  const today = deps.now().toISOString().slice(0, 10);
  const keys = Object.keys(TARGETS) as BrainKey[];
  const drafted = keys.map(
    (key) => [key, withDraft(current[key], result.output[key], today, commit)] as const,
  );
  // Un archivo que pasa su tope frena la carga del cerebro en el próximo run.
  const over = drafted.find(([key, text]) => Array.from(text).length > TARGETS[key].max);
  if (over !== undefined) {
    const { file, max } = TARGETS[over[0]];
    return {
      tipo: "falla",
      motivo: `con el borrador, ${file} pasaría su tope de ${String(max)} caracteres: acortalo y volvé a pedirlo`,
    };
  }
  for (const [key, text] of drafted) writeFileSync(pathOf(key), text);
  return {
    tipo: "ok",
    costoUsd: result.costoUsd,
    probar: writeProbar(worktree, input.config, result.output.probar),
  };
}
