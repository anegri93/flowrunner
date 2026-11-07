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
  return { file, feature, project, repoConfig: loadRepoConfig(project.path) };
}

export function describeCheckedFeature(checked: CheckedFeature): string {
  const { feature, project } = checked;
  return [
    `${feature.clave} · ${feature.titulo}`,
    `proyecto ${project.name} en ${project.path}`,
    `${feature.criterios.length} criterios, ${feature.aclaraciones.length} aclaraciones`,
    ...feature.criterios.map((c) => `  ${c.id}: ${c.text}`),
  ].join("\n");
}
