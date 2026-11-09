// Las reglas de lo que un agente puede tocar, como funciones puras. Las usan el hook PreToolUse, en el
// momento de cada herramienta, y el doble control, sobre el diff real.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly motivo: string };
const OK: Verdict = { ok: true };
const no = (motivo: string): Verdict => ({ ok: false, motivo });

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
  /** Comandos de Bash permitidos tal cual. */
  readonly bash: readonly string[];
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
  return resolve(realpathSync(current), ...missing);
}

/** La ruta relativa al worktree, o undefined si queda afuera después de resolver links y `..`. */
export function insideRoot(scope: Scope, path: string): string | undefined {
  const absolute = realish(isAbsolute(path) ? path : resolve(scope.root, path));
  const rel = relative(scope.root, absolute);
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
  if (isDepFile && !scope.depsDeclared) {
    return no(`${rel} solo se toca si ${scope.owner} declaró dependencias, y no declaró ninguna`);
  }
  const inScope =
    isDepFile ||
    scope.writable.some((w) => covers(w, rel)) ||
    scope.writeGlobs.some((g) => matchesGlob(rel, g));
  if (!inScope) return no(`${rel} está fuera del alcance de ${scope.owner}`);
  return OK;
}

export function checkReadPath(scope: Scope, path: string | undefined): Verdict {
  if (path === undefined || path === "") return OK;
  return insideRoot(scope, path) === undefined ? no(`${path} queda fuera del worktree`) : OK;
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

const COMPOSITION = /[;&|`]|\$\(|>|</;

export function checkBash(scope: Scope, command: string): Verdict {
  const trimmed = command.trim();
  if (scope.bash.includes(trimmed)) return OK;
  const allowed =
    scope.bash.length === 0 ? "ninguno" : scope.bash.map((c) => `\`${c}\``).join(", ");
  if (COMPOSITION.test(trimmed)) {
    return no(
      `el comando compone otros comandos y no está en la lista permitida tal cual. Permitidos: ${allowed}`,
    );
  }
  return no(
    `\`${trimmed}\` no está en la lista permitida de ${scope.owner}. Permitidos: ${allowed}`,
  );
}
