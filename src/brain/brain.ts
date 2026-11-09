// El cerebro de un repo: `.flowrunner/` leído del worktree del run, con topes y sin seguir links.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { ConfigError, type Problem } from "../config/schemas.ts";

export const BRAIN_FILES = {
  convenciones: { file: "convenciones.md", max: 16_000 },
  contexto: { file: "contexto.md", max: 16_000 },
  queEsBien: { file: "que-es-bien.md", max: 16_000 },
  lecciones: { file: "lecciones.md", max: 12_000 },
} as const;
export const MAX_EXAMPLES = 20;

/** Dónde empieza lo que redactó init; lo de arriba es de la persona. */
export const DRAFT_HEADING = "## Borrador de flowrunner init";

/**
 * Las plantillas que flowrunner dejó antes, tal cual. Si lo que está arriba del borrador es una de
 * estas, nadie lo escribió: se cambia por la plantilla de hoy. La primera decía que toda convención
 * bloquea, y quedaba arriba del borrador nuevo contradiciendo sus marcas de severidad.
 */
const OLD_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  "contexto.md": [
    "# Contexto del repo\n\nArquitectura, dónde vive cada cosa y cómo se testea. Lo leen planificar e implementar.\n\n-",
  ],
  "convenciones.md": [
    "# Convenciones del repo\n\nReglas que planificar, implementar y revisar aplican. Una violación es un bloqueante en la revisión.\nEscribí reglas concretas y verificables, con un ejemplo cuando ayude.\n\n-",
  ],
  "que-es-bien.md": [
    "# Qué es una buena PR en este repo\n\nCriterios con los que revisar compara cada diff. Poné ejemplos reales de PRs dadas por buenas en\n`ejemplos/`.\n\n-",
  ],
};

type BrainKey = keyof typeof BRAIN_FILES;

export interface Brain {
  readonly convenciones: string;
  readonly contexto: string;
  readonly queEsBien: string;
  readonly lecciones: string;
  /** Rutas relativas al repo de los archivos de `ejemplos/`, ordenadas. */
  readonly ejemplos: readonly string[];
  /** Los primeros 12 caracteres del sha256 de cada archivo que se cargó. */
  readonly hashes: Readonly<Record<string, string>>;
}

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

export function brainDir(repo: string): string {
  return join(repo, ".flowrunner");
}

export function loadBrain(repo: string): Brain {
  const dir = brainDir(repo);
  const problems: Problem[] = [];
  const texts: Partial<Record<BrainKey, string>> = {};
  const hashes: Record<string, string> = {};
  for (const [key, { file, max }] of Object.entries(BRAIN_FILES) as [
    BrainKey,
    { file: string; max: number },
  ][]) {
    const path = join(dir, file);
    const where = `.flowrunner/${file}`;
    if (!existsSync(path)) {
      problems.push({ where, message: "falta; corré `flowrunner brain init`" });
      continue;
    }
    if (lstatSync(path).isSymbolicLink()) {
      problems.push({ where, message: "es un link: flowrunner no sigue links" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const length = Array.from(text).length;
    if (length > max) {
      problems.push({
        where,
        message: `tiene ${length} caracteres: el máximo es ${max}; pasá el detalle a otro archivo`,
      });
      continue;
    }
    texts[key] = text;
    hashes[where] = sha12(text);
  }
  const examplesDir = join(dir, "ejemplos");
  const ejemplos = existsSync(examplesDir)
    ? readdirSync(examplesDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => relative(repo, join(d.parentPath, d.name)))
        .sort()
    : [];
  if (ejemplos.length > MAX_EXAMPLES) {
    problems.push({
      where: ".flowrunner/ejemplos",
      message: `tiene ${ejemplos.length} archivos: el máximo es ${MAX_EXAMPLES}`,
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    convenciones: texts.convenciones ?? "",
    contexto: texts.contexto ?? "",
    queEsBien: texts.queEsBien ?? "",
    lecciones: texts.lecciones ?? "",
    ejemplos,
    hashes,
  };
}

const TEMPLATES = join(import.meta.dirname, "..", "..", "templates", "brain");

/**
 * El texto con la plantilla de hoy en lugar de una vieja que nadie editó, y el borrador intacto. Si
 * la persona tocó algo arriba del borrador, no lo cambia.
 */
export function withCurrentTemplate(file: string, text: string): string {
  const at = text.indexOf(DRAFT_HEADING);
  const top = (at === -1 ? text : text.slice(0, at)).trimEnd();
  if (!(OLD_TEMPLATES[file] ?? []).includes(top)) return text;
  const fresh = readFileSync(join(TEMPLATES, file), "utf8").trimEnd();
  return at === -1 ? `${fresh}\n` : `${fresh}\n\n${text.slice(at)}`;
}

/** Cambia las plantillas viejas sin editar del cerebro por las de hoy; devuelve las que cambió. */
export function refreshTemplates(repo: string): string[] {
  const refreshed: string[] = [];
  for (const file of Object.keys(OLD_TEMPLATES)) {
    const path = join(brainDir(repo), file);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) continue;
    const text = readFileSync(path, "utf8");
    const fresh = withCurrentTemplate(file, text);
    if (fresh === text) continue;
    writeFileSync(path, fresh);
    refreshed.push(relative(repo, path));
  }
  return refreshed;
}

/** Escribe las plantillas que faltan en `.flowrunner/` del repo. Nunca pisa un archivo existente. */
export function initBrain(repo: string): string[] {
  const created: string[] = [];
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true });
        copy(source, target);
      } else if (!existsSync(target)) {
        mkdirSync(to, { recursive: true });
        copyFileSync(source, target);
        chmodSync(target, statSync(source).mode);
        created.push(relative(repo, target));
      }
    }
  };
  copy(TEMPLATES, brainDir(repo));
  return created.sort();
}
