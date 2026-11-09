// Lo que `flowrunner init` deduce de un repo para su `.flowrunner/config.yaml` y su `verify.sh`, a
// partir de los archivos versionados y el package.json. Solo reconoce repos JavaScript/TypeScript.
import { z } from "zod";

export interface Finding {
  readonly que: string;
  readonly estado: "inferido" | "falta";
  readonly detalle: string;
}

export interface InferredConfig {
  readonly base_branch: string;
  readonly setup: string;
  readonly tests_globs: string[];
  readonly harness_files: string[];
  readonly lockfiles: string[];
  readonly manifests: string[];
}

export interface Inferred {
  /** Undefined si el stack no se reconoce: init no inventa una config. */
  readonly config: InferredConfig | undefined;
  /** El contenido de `.flowrunner/verify.sh`; undefined si no hay con qué armarlo. */
  readonly verify: string | undefined;
  readonly hallazgos: Finding[];
}

export interface RepoFacts {
  readonly baseBranch: string;
  /** `git ls-files` de la base, relativo a la raíz del repo. */
  readonly files: readonly string[];
  readonly packageJson: unknown;
}

const MANAGERS = [
  { lockfile: "pnpm-lock.yaml", setup: "pnpm install --frozen-lockfile", run: "pnpm" },
  { lockfile: "package-lock.json", setup: "npm ci", run: "npm run" },
  { lockfile: "yarn.lock", setup: "yarn install --frozen-lockfile", run: "yarn" },
  { lockfile: "bun.lock", setup: "bun install --frozen-lockfile", run: "bun run" },
] as const;

/**
 * Un script propio que ya corre todo gana; si no, los que existan, en este orden. Los tests van
 * primero: son los que más dicen de un rojo, y el formato y el lint, los que menos.
 */
const ALL_IN_ONE = ["check", "verify"] as const;
const CHAIN = ["test", "typecheck", "lint", "format:check", "build"] as const;

const HARNESS = /^(vitest|jest|playwright)\.(config|workspace)\.[cm]?[jt]s$/;
const TEST_DIR = /^(tests?)\//;
const TEST_FILE = /\.(test|spec)\.([cm]?[jt]sx?)$/;

const packageSchema = z.object({ scripts: z.record(z.string(), z.string()).default({}) });

function testGlobs(files: readonly string[]): string[] {
  const globs = new Set<string>();
  for (const file of files) {
    const dir = TEST_DIR.exec(file);
    if (dir !== null) {
      globs.add(`${dir[1] ?? "test"}/**`);
      continue;
    }
    const match = TEST_FILE.exec(file);
    if (match === null) continue;
    const pattern = `*.${match[1] ?? "test"}.${match[2] ?? "ts"}`;
    const slash = file.indexOf("/");
    globs.add(slash === -1 ? pattern : `${file.slice(0, slash)}/**/${pattern}`);
  }
  return [...globs].sort();
}

/**
 * Corre todos los pasos aunque alguno falle, y al final lista los que fallaron: con `set -e`, un
 * formato rojo escondía los tests rotos que venían después. Sale 0 solo si todos pasan.
 */
export function verifyScript(run: string, steps: readonly string[]): string {
  return [
    "#!/bin/sh",
    "# Lo armó `flowrunner init` con los scripts del package.json. Corre todos los pasos aunque alguno",
    "# falle y sale 0 solo si el repo está en verde.",
    'fallaron=""',
    'paso() { "$@" || fallaron="$fallaron $*;"; }',
    ...steps.map((name) => `paso ${run} ${name}`),
    'if [ -n "$fallaron" ]; then',
    '  echo "verify en rojo:$fallaron"',
    "  exit 1",
    "fi",
    "",
  ].join("\n");
}

function verifySteps(scripts: Record<string, string>): string[] | undefined {
  const own = ALL_IN_ONE.find((name) => name in scripts);
  if (own !== undefined) return [own];
  return "test" in scripts ? CHAIN.filter((name) => name in scripts) : undefined;
}

export function inferRepo(facts: RepoFacts): Inferred {
  const parsed = packageSchema.safeParse(facts.packageJson);
  if (facts.packageJson === undefined || !parsed.success) {
    return {
      config: undefined,
      verify: undefined,
      hallazgos: [
        {
          que: "stack",
          estado: "falta",
          detalle:
            "no hay un package.json válido en la raíz: escribí .flowrunner/config.yaml y verify.sh a mano",
        },
      ],
    };
  }
  const hallazgos: Finding[] = [];
  const manager = MANAGERS.find((m) => facts.files.includes(m.lockfile));
  const setup = manager?.setup ?? "npm install";
  hallazgos.push({
    que: "setup",
    estado: "inferido",
    detalle:
      manager === undefined
        ? "`npm install`: no hay lockfile, así que cada worktree puede instalar versiones distintas"
        : `\`${setup}\`, por ${manager.lockfile}`,
  });

  const run = manager?.run ?? "npm run";
  const steps = verifySteps(parsed.data.scripts);
  const verify = steps === undefined ? undefined : verifyScript(run, steps);
  hallazgos.push(
    steps === undefined
      ? {
          que: "verify.sh",
          estado: "falta",
          detalle:
            "el package.json no tiene script `test` ni `check`: sin tests no hay verde que comprobar",
        }
      : {
          que: "verify.sh",
          estado: "inferido",
          detalle: steps.map((name) => `${run} ${name}`).join(", "),
        },
  );

  const found = testGlobs(facts.files);
  const tests_globs = found.length > 0 ? found : ["test/**"];
  hallazgos.push({
    que: "tests_globs",
    estado: "inferido",
    detalle:
      found.length > 0
        ? found.join(", ")
        : "no encontré tests: planificar va a escribir los suyos en test/",
  });

  const harness_files = facts.files.filter((f) => HARNESS.test(f)).sort();
  if (harness_files.length > 0) {
    hallazgos.push({ que: "harness_files", estado: "inferido", detalle: harness_files.join(", ") });
  }

  return {
    config: {
      base_branch: facts.baseBranch,
      setup,
      tests_globs,
      harness_files,
      lockfiles: manager === undefined ? [] : [manager.lockfile],
      manifests: ["package.json"],
    },
    verify,
    hallazgos,
  };
}
