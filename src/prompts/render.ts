// Las plantillas de prompt viven en `prompts/<nombre>.md` con marcas `{{variable}}`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS = join(import.meta.dirname, "..", "..", "prompts");

export function render(name: string, vars: Readonly<Record<string, string>>): string {
  const template = readFileSync(join(PROMPTS, `${name}.md`), "utf8");
  const missing = [...template.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1] ?? "")
    .filter((v) => !(v in vars));
  if (missing.length > 0)
    throw new Error(`a la plantilla ${name} le faltan: ${missing.join(", ")}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function featureText(feature: {
  clave: string;
  titulo: string;
  descripcion: string;
  criterios: readonly { id: string; text: string }[];
  aclaraciones: readonly { question: string; answer: string }[];
  fueraDeAlcance: readonly string[];
}): string {
  return [
    `## ${feature.clave} · ${feature.titulo}`,
    "",
    feature.descripcion,
    "",
    "### Criterios",
    ...feature.criterios.map((c) => `- ${c.id}: ${c.text}`),
    ...(feature.aclaraciones.length === 0
      ? []
      : [
          "",
          "### Aclaraciones de la persona",
          ...feature.aclaraciones.map((a) => `- ${a.question} ${a.answer}`),
        ]),
    ...(feature.fueraDeAlcance.length === 0
      ? []
      : ["", "### Fuera de alcance", ...feature.fueraDeAlcance.map((f) => `- ${f}`)]),
  ].join("\n");
}
