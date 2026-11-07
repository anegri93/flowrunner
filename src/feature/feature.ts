// El archivo de una feature: frontmatter YAML y secciones Markdown, validado entero de una vez.
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError, problemsFrom, type Problem } from "../config/schemas.ts";

const frontmatterSchema = z.strictObject({
  clave: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, "tiene que tener la forma ABC-123"),
  proyecto: z.string().min(1),
  titulo: z.string().min(1),
});

export interface Criterion {
  readonly id: string;
  readonly text: string;
}

export interface Clarification {
  readonly question: string;
  readonly answer: string;
}

export interface Feature {
  readonly clave: string;
  readonly proyecto: string;
  readonly titulo: string;
  readonly descripcion: string;
  readonly criterios: readonly Criterion[];
  readonly aclaraciones: readonly Clarification[];
  readonly fueraDeAlcance: readonly string[];
}

const SECTIONS = {
  descripción: "descripcion",
  criterios: "criterios",
  aclaraciones: "aclaraciones",
  "fuera de alcance": "fuera",
} as const;
type SectionKey = (typeof SECTIONS)[keyof typeof SECTIONS];

/** Junta los ítems `- ...` de una sección, con sus líneas de continuación indentadas. */
function listItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && items.length > 0) {
      items.push(`${items.pop() ?? ""} ${line.trim()}`);
    }
  }
  return items;
}

export function parseFeature(file: string, text: string): Feature {
  const problems: Problem[] = [];
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new ConfigError([{ where: file, message: "falta el frontmatter entre dos líneas ---" }]);
  }
  const [, yamlText = "", body = ""] = match;
  let frontmatter: z.infer<typeof frontmatterSchema> | undefined;
  try {
    const result = frontmatterSchema.safeParse(parse(yamlText) as unknown);
    if (result.success) frontmatter = result.data;
    else problems.push(...problemsFrom(`${file} › frontmatter`, result.error));
  } catch (error) {
    problems.push({ where: `${file} › frontmatter`, message: `YAML inválido: ${String(error)}` });
  }

  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | undefined;
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = (heading[1] ?? "").toLowerCase();
      current = name in SECTIONS ? SECTIONS[name as keyof typeof SECTIONS] : undefined;
      if (current === undefined) {
        problems.push({ where: file, message: `sección desconocida: "## ${heading[1] ?? ""}"` });
      } else if (sections.has(current)) {
        problems.push({ where: file, message: `sección repetida: "## ${heading[1] ?? ""}"` });
      }
      if (current !== undefined) sections.set(current, []);
      continue;
    }
    if (current !== undefined) sections.get(current)?.push(line);
  }

  const descripcion = (sections.get("descripcion") ?? []).join("\n").trim();
  if (descripcion === "")
    problems.push({ where: file, message: "falta la sección ## Descripción" });

  const criterios: Criterion[] = [];
  const seen = new Set<string>();
  for (const item of listItems(sections.get("criterios") ?? [])) {
    const criterion = /^(AC-\d+):\s*(.+)$/.exec(item);
    if (criterion === null) {
      problems.push({
        where: `${file} › Criterios`,
        message: `el criterio "${item}" no empieza con AC-n:`,
      });
      continue;
    }
    const [, id = "", criterionText = ""] = criterion;
    if (seen.has(id))
      problems.push({ where: `${file} › Criterios`, message: `${id} está repetido` });
    seen.add(id);
    criterios.push({ id, text: criterionText });
  }
  if (criterios.length === 0 && !problems.some((p) => p.where.endsWith("Criterios"))) {
    problems.push({
      where: file,
      message: "la feature no tiene criterios: hace falta al menos un AC-1",
    });
  }

  const aclaraciones: Clarification[] = [];
  for (const item of listItems(sections.get("aclaraciones") ?? [])) {
    const qa = /^P:\s*(.+?)\s+R:\s*(.+)$/.exec(item);
    if (qa === null) {
      problems.push({
        where: `${file} › Aclaraciones`,
        message: `"${item}" no tiene la forma P: … R: …`,
      });
    } else {
      aclaraciones.push({ question: qa[1] ?? "", answer: qa[2] ?? "" });
    }
  }

  if (problems.length > 0 || frontmatter === undefined) throw new ConfigError(problems);
  return {
    ...frontmatter,
    descripcion,
    criterios,
    aclaraciones,
    fueraDeAlcance: listItems(sections.get("fuera") ?? []),
  };
}
