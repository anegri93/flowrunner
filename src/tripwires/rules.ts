// Las reglas de lo que un agente puede tocar, como funciones puras. Las usan el hook PreToolUse, en el
// momento de cada herramienta, y el doble control, sobre el diff real.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { Comandos } from "./comandos.ts";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly motivo: string };
const OK: Verdict = { ok: true };
const no = (motivo: string): Verdict => ({ ok: false, motivo });

/** Las herramientas que escriben archivos: un rechazo suyo es algo que el agente no pudo hacer. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Nunca los escribe un agente, en ninguna fase. */
export const ALWAYS_PROTECTED = [
  ".flowrunner",
  ".claude",
  "CLAUDE.md",
  "AGENTS.md",
  ".git",
] as const;

export interface Scope {
  /** La raíz del worktree, ya resuelta con realpath. */
  readonly root: string;
  /** Quién trabaja, para los motivos: "ST-2", "planificar". */
  readonly owner: string;
  /** Rutas relativas que puede escribir: archivos o carpetas. Vacío con `writeGlobs` define el alcance. */
  readonly writable: readonly string[];
  /** Globs que también puede escribir; planificar usa los tests_globs del repo. */
  readonly writeGlobs: readonly string[];
  readonly locked: readonly string[];
  readonly harness: readonly string[];
  readonly lockfiles: readonly string[];
  readonly manifests: readonly string[];
  readonly depsDeclared: boolean;
  readonly testGlobs: readonly string[];
  /** Lo que una sesión con Bash puede correr; ver `checkCommand`. */
  readonly comandos: Comandos;
  /** Archivos con secretos que no se leen ni se buscan, como los `.env` que copia probar. */
  readonly unreadable?: readonly string[];
}

/** El realpath del ancestro existente más cercano, más lo que falta: atrapa carpetas que son links. */
function realish(path: string): string {
  let current = path;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  // La versión nativa devuelve las mayúsculas del disco: en APFS, `.ENV.LOCAL` es `.env.local`.
  return resolve(realpathSync.native(current), ...missing);
}

/** La ruta relativa al worktree, o undefined si queda afuera después de resolver links y `..`. */
export function insideRoot(scope: Scope, path: string): string | undefined {
  const absolute = realish(isAbsolute(path) ? path : resolve(scope.root, path));
  const rel = relative(realish(scope.root), absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "" : undefined;
  return rel.split(sep).join("/");
}

const covers = (entry: string, rel: string) => {
  const clean = entry.replace(/\/+$/, "");
  return rel === clean || rel.startsWith(`${clean}/`);
};

export const isTestFile = (testGlobs: readonly string[], rel: string) =>
  testGlobs.some((g) => matchesGlob(rel, g)) ||
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/.test(rel);

export function checkWritePath(scope: Scope, path: string): Verdict {
  const rel = insideRoot(scope, path);
  if (rel === undefined) return no(`${path} queda fuera del worktree de ${scope.owner}`);
  if (rel === "") return no(`no se puede escribir la raíz del repo`);
  const protectedHit = ALWAYS_PROTECTED.find((p) => covers(p, rel));
  if (protectedHit !== undefined)
    return no(`${rel} es parte de ${protectedHit}: ningún agente lo escribe`);
  if (scope.locked.includes(rel))
    return no(`${rel} es un test de aceptación bloqueado: no se modifica`);
  if (scope.harness.some((h) => covers(h, rel)))
    return no(`${rel} es parte del harness de tests: no se toca`);
  const isDepFile = [...scope.lockfiles, ...scope.manifests].includes(rel);
  // Un package.json en el alcance se puede tocar sin declarar dependencias, como para agregar un
  // script (VF-6: `npm run mac` quedó documentado y sin existir). Sus dependencias no: lo controla
  // `dependencySectionsChanged` sobre el diff.
  const scriptsOnly =
    isPackageJson(rel) && !scope.depsDeclared && scope.writable.some((w) => covers(w, rel));
  if (isDepFile && !scope.depsDeclared && !scriptsOnly) {
    return no(
      `${rel} solo se toca si ${scope.owner} declaró dependencias, y no declaró ninguna${isPackageJson(rel) ? `. Para cambiar otra cosa, como un script, el plan tiene que poner ${rel} en el alcance de ${scope.owner}` : ""}`,
    );
  }
  const inScope =
    isDepFile ||
    scope.writable.some((w) => covers(w, rel)) ||
    scope.writeGlobs.some((g) => matchesGlob(rel, g));
  if (!inScope) return no(`${rel} está fuera del alcance de ${scope.owner}`);
  return OK;
}

const isPackageJson = (rel: string) => rel === "package.json" || rel.endsWith("/package.json");

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
] as const;

/**
 * Las secciones de dependencias de un package.json que cambiaron entre `before` y `after`. Un JSON
 * que no se lee cuenta como cambiado: no se puede decir que no tocó las dependencias.
 */
export function dependencySectionsChanged(before: string, after: string): string[] {
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(before) as Record<string, unknown>;
    b = JSON.parse(after) as Record<string, unknown>;
  } catch {
    return ["(el JSON no se lee)"];
  }
  return DEPENDENCY_SECTIONS.filter(
    (k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null),
  );
}

export function checkReadPath(scope: Scope, path: string | undefined): Verdict {
  if (path === undefined || path === "") return OK;
  const rel = insideRoot(scope, path);
  if (rel === undefined) return no(`${path} queda fuera del worktree`);
  const secret = scope.unreadable?.find((u) => covers(u, rel));
  return secret === undefined ? OK : no(`${secret} tiene secretos del entorno: no se lee`);
}

/** Como leer, y además una búsqueda no puede abarcar un archivo con secretos. */
export function checkSearchPath(scope: Scope, path: string | undefined): Verdict {
  const read = checkReadPath(scope, path);
  if (!read.ok) return read;
  const rel = insideRoot(scope, path === undefined || path === "" ? scope.root : path) ?? "";
  const secret = scope.unreadable?.find((u) => rel === "" || covers(rel, u));
  return secret === undefined
    ? OK
    : no(
        `buscar en ${rel === "" ? "la raíz" : rel} incluye ${secret}, que tiene secretos del entorno: buscá dentro de una carpeta que no lo tenga, como src/`,
      );
}

const DISABLED_TEST = [
  /\b(?:it|test|describe|context|suite)\s*\.\s*(?:only|skip|todo)\s*\(/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(/,
];

const SECRETS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "una clave privada"],
  [/\bAKIA[0-9A-Z]{16}\b/, "una access key de AWS"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "un token de GitHub"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "una API key de Anthropic"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "una API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "un token de Slack"],
  [
    /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    "un secreto escrito en el código",
  ],
];

/** Reglas sobre el contenido que se agrega: tests desactivados y secretos. */
export function checkContent(scope: Scope, rel: string, added: readonly string[]): Verdict {
  const test = isTestFile(scope.testGlobs, rel);
  for (const line of added) {
    if (test && DISABLED_TEST.some((p) => p.test(line))) {
      return no(
        `${rel} agrega un test desactivado o exclusivo (skip, only o todo): "${line.trim()}"`,
      );
    }
    for (const [pattern, what] of SECRETS) {
      if (pattern.test(line)) return no(`${rel} agrega ${what}; los secretos no se commitean`);
    }
  }
  return OK;
}
