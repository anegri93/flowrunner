// `flowrunner feature check <archivo>`: la feature, su proyecto y la config de su repo, validados.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadGlobalConfig, loadRepoConfig } from "../config/load.ts";
import { ConfigError, type RepoConfig } from "../config/schemas.ts";
import { checkCitas } from "../feature/citas.ts";
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

/** Los scripts de un package.json, o undefined si no hay o no se lee. */
export function scriptsDe(packageJsonText: string | undefined): Record<string, string> | undefined {
  if (packageJsonText === undefined) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return undefined;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  // Sin `scripts`, npm no tiene ninguno: cada `npm run x` falla.
  if (scripts === undefined) return {};
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return undefined;
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Los comandos propios de pnpm y yarn: `pnpm install` no es un script. `test` y `start` sí lo son. */
const GESTOR_BUILTINS = new Set(
  `add install i remove rm uninstall update up upgrade exec dlx create init link unlink list ls
   outdated why store env patch publish pack audit import rebuild prune fetch deploy setup config
   root bin licenses doctor server self-update dedupe approve-builds info workspaces workspace
   cache set plugin npm constraints explain node version run`.split(/\s+/),
);

/**
 * Un script empieza con una letra, así `--filter` no cuenta; y termina en letra o número, así el punto
 * que cierra la oración no es parte del nombre.
 */
const SCRIPT = String.raw`[A-Za-z](?:[\w:.-]*\w)?`;
const SCRIPT_USES = new RegExp(
  String.raw`(?<![\w./@-])(?:npm\s+(?:run|run-script)\s+(${SCRIPT})|npm\s+(test|start)\b|(?:pnpm|yarn)\s+(?:run\s+)?(${SCRIPT}))`,
  "g",
);

/** Avisos para los criterios que usan un script que hoy no existe. */
export function scriptsInexistentes(
  feature: Feature,
  scripts: Record<string, string> | undefined,
  /**
   * Los binarios de `node_modules/.bin`: sin un script con ese nombre, `pnpm tsc` y `yarn jest` los
   * corren igual. `npm run tsc`, no.
   */
  binarios: ReadonlySet<string> = new Set(),
): string[] {
  if (scripts === undefined) return [];
  const avisos: string[] = [];
  for (const c of feature.criterios) {
    const vistos = new Set<string>();
    for (const m of c.text.matchAll(SCRIPT_USES)) {
      const [comando, npmRun, npmBuiltin, gestor] = m;
      const s = npmRun ?? npmBuiltin ?? gestor;
      // `pnpm run x` lo toma la primera opción del grupo; `pnpm run` solo, o `pnpm install`, no son scripts.
      if (s === undefined || (gestor !== undefined && GESTOR_BUILTINS.has(gestor))) continue;
      if (gestor !== undefined && binarios.has(gestor)) continue;
      if (Object.hasOwn(scripts, s) || vistos.has(s)) continue;
      vistos.add(s);
      avisos.push(
        `${c.id} usa \`${comando}\`, y el package.json del repo no tiene el script "${s}". Si la feature lo crea, el plan tiene que poner package.json en el alcance de una sub-task; si no, el criterio no se puede cumplir`,
      );
    }
  }
  return avisos;
}

/** Un archivo de documentación, la palabra README o una ruta bajo `docs/` o `doc/`. */
const DOC_MENTIONS =
  /(?<![\w./-])(?:[\w./-]*\.(?:mdx?|rst|adoc|txt)\b|docs?\/(?:[\w./-]*[\w/-])?|README\b)/g;
/** De esos ya avisa `protectedMentions`, y más fuerte: ningún agente los puede escribir. */
const PROTECTED_DOC = /(^|\/)(CLAUDE|AGENTS)\.md$|(^|\/)\.(claude|flowrunner)\//;

/** Avisos para los criterios que solo se comprueban leyendo documentación. */
export function soloDocumentacion(feature: Feature): string[] {
  const avisos: string[] = [];
  for (const c of feature.criterios) {
    const docs = [
      ...new Set(
        [...c.text.matchAll(DOC_MENTIONS)].map(([m]) => m).filter((m) => !PROTECTED_DOC.test(m)),
      ),
    ];
    if (docs.length > 0)
      avisos.push(
        `${c.id} se comprueba en documentación (${docs.join(", ")}): un test de eso solo busca texto y no prueba que lo documentado funcione. Si documenta un comando, un script o un endpoint, sumá un criterio que lo ejecute`,
      );
  }
  return avisos;
}

/** Sin package.json en la raíz, o si no se puede leer, no hay chequeo de scripts. */
function readPackageJson(repo: string): string | undefined {
  const pkg = join(repo, "package.json");
  if (!existsSync(pkg)) return undefined;
  try {
    return readFileSync(pkg, "utf8");
  } catch {
    return undefined;
  }
}

/** Los binarios instalados en la raíz del repo; vacío si no hay node_modules o no se lee. */
function localBinaries(repo: string): Set<string> {
  try {
    return new Set(readdirSync(join(repo, "node_modules", ".bin")));
  } catch {
    return new Set();
  }
}

/** Sin `probar` en la config, la fase probar se saltea: ningún criterio se prueba en la app. */
export function sinProbar(config: RepoConfig): string[] {
  return config.probar === undefined
    ? [
        "el repo no tiene `probar` en .flowrunner/config.yaml: la fase probar se va a saltear y ningún criterio se va a probar en la app. Para que pruebe, agregá cómo levantar el entorno (README, «Probar la feature en el entorno»)",
      ]
    : [];
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
  // Las citas son del código de hoy: una a un archivo que no está, o a una línea de más, frena la
  // feature antes de que el planificador la tome por cierta.
  const problemas = checkCitas(feature.contexto, (ruta) => {
    const abs = join(project.path, ruta);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
  });
  if (problemas.length > 0)
    throw new ConfigError(problemas.map((message) => ({ where: `${file} › Contexto`, message })));
  const repoConfig = loadRepoConfig(project.path);
  return {
    file,
    feature,
    project,
    repoConfig,
    avisos: [
      ...protectedMentions(feature),
      ...scriptsInexistentes(
        feature,
        scriptsDe(readPackageJson(project.path)),
        localBinaries(project.path),
      ),
      ...soloDocumentacion(feature),
      ...sinProbar(repoConfig),
    ],
  };
}

export function describeCheckedFeature(checked: CheckedFeature): string {
  const { feature, project } = checked;
  return [
    `${feature.clave} · ${feature.titulo}`,
    `proyecto ${project.name} en ${project.path}`,
    `${feature.criterios.length} criterios, ${feature.aclaraciones.length} aclaraciones`,
    `${feature.contexto.length} citas de código en Contexto`,
    ...feature.criterios.map((c) => `  ${c.id}: ${c.text}`),
    ...checked.avisos.map((a) => `⚠ ${a}`),
  ].join("\n");
}
