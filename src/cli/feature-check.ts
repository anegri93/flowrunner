// `flowrunner feature check <archivo>`: la feature, su proyecto y la config de su repo, validados.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGlobalConfig, loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { parseFeature, type Feature } from "../feature/feature.ts";
import { UserError } from "./output.ts";

export interface CheckedFeature {
  readonly file: string;
  readonly feature: Feature;
  readonly project: { readonly name: string; readonly path: string };
  readonly repoConfig: RepoConfig;
  /** Lo que no frena la feature pero va a trabar el run, como un criterio sobre CLAUDE.md. */
  readonly avisos: string[];
}

/** Archivos que ningún agente escribe, como los nombraría una feature. `.git` no: es una palabra común. */
const PROTECTED_MENTIONS: readonly [RegExp, string][] = [
  [/(^|[^\w.])CLAUDE\.md\b/, "CLAUDE.md"],
  [/(^|[^\w.])AGENTS\.md\b/, "AGENTS.md"],
  [/(^|[^\w])\.claude\//, ".claude/"],
  [/(^|[^\w])\.flowrunner\//, ".flowrunner/"],
];

/**
 * Un criterio que nombra un archivo protegido probablemente pida escribirlo, y ninguna sub-task
 * puede: en VF-6 eso costó cuatro replans. Avisa; no frena, porque leerlo sí se puede.
 */
export function protectedMentions(feature: Feature): string[] {
  const avisos: string[] = [];
  for (const c of feature.criterios) {
    for (const [pattern, name] of PROTECTED_MENTIONS) {
      if (pattern.test(c.text))
        avisos.push(
          `${c.id} nombra ${name}, que ningún agente del run puede escribir. Si el criterio pide cambiarlo, sacalo de la feature y hacelo a mano`,
        );
    }
  }
  return avisos;
}

export function checkFeature(path: string, env: NodeJS.ProcessEnv): CheckedFeature {
  const file = resolve(path);
  if (!existsSync(file)) throw new UserError(`no existe la feature ${file}`);
  const feature = parseFeature(file, readFileSync(file, "utf8"));
  const global = loadGlobalConfig(env);
  const project = global.projects.find((p) => p.name === feature.proyecto);
  if (project === undefined) {
    throw new UserError(
      `el proyecto "${feature.proyecto}" no está registrado`,
      `flowrunner project add <ruta del repo>`,
    );
  }
  return {
    file,
    feature,
    project,
    repoConfig: loadRepoConfig(project.path),
    avisos: protectedMentions(feature),
  };
}

export function describeCheckedFeature(checked: CheckedFeature): string {
  const { feature, project } = checked;
  return [
    `${feature.clave} · ${feature.titulo}`,
    `proyecto ${project.name} en ${project.path}`,
    `${feature.criterios.length} criterios, ${feature.aclaraciones.length} aclaraciones`,
    ...feature.criterios.map((c) => `  ${c.id}: ${c.text}`),
    ...checked.avisos.map((a) => `⚠ ${a}`),
  ].join("\n");
}
