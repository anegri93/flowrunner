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
