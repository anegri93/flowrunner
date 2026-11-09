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
  readonly format?: string;
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
  {
    lockfile: "pnpm-lock.yaml",
    setup: "pnpm install --frozen-lockfile",
    run: "pnpm",
    exec: "pnpm exec",
  },
  { lockfile: "package-lock.json", setup: "npm ci", run: "npm run", exec: "npx" },
  { lockfile: "yarn.lock", setup: "yarn install --frozen-lockfile", run: "yarn", exec: "yarn" },
  { lockfile: "bun.lock", setup: "bun install --frozen-lockfile", run: "bun run", exec: "bunx" },
] as const;

/** Un script propio que ya corre todo gana; si no, los que existan, en este orden. */
const ALL_IN_ONE = ["check", "verify"] as const;
const CHAIN = ["format:check", "lint", "typecheck", "test", "build"] as const;

const HARNESS = /^(vitest|jest|playwright)\.(config|workspace)\.[cm]?[jt]s$/;
const TEST_DIR = /^(tests?)\//;
const TEST_FILE = /\.(test|spec)\.([cm]?[jt]sx?)$/;

const packageSchema = z.object({
  scripts: z.record(z.string(), z.string()).default({}),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

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

function verifyScript(run: string, scripts: Record<string, string>): string | undefined {
  const own = ALL_IN_ONE.find((name) => name in scripts);
  const steps = own === undefined ? CHAIN.filter((name) => name in scripts) : [own];
  if (own === undefined && !("test" in scripts)) return undefined;
  return [
    "#!/bin/sh",
    "# Lo armó `flowrunner init` con los scripts del package.json. Sale 0 solo si el repo está en verde.",
    "set -e",
    ...steps.map((name) => `${run} ${name}`),
    "",
  ].join("\n");
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

  const verify = verifyScript(manager?.run ?? "npm run", parsed.data.scripts);
  hallazgos.push(
    verify === undefined
      ? {
          que: "verify.sh",
          estado: "falta",
          detalle:
            "el package.json no tiene script `test` ni `check`: sin tests no hay verde que comprobar",
        }
      : {
          que: "verify.sh",
          estado: "inferido",
          detalle: verify.split("\n").slice(3).filter(Boolean).join(" && "),
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

  const { dependencies, devDependencies } = parsed.data;
  const format =
    "prettier" in devDependencies || "prettier" in dependencies
      ? `${manager?.exec ?? "npx"} prettier --write --ignore-unknown`
      : undefined;
  if (format !== undefined) {
    hallazgos.push({
      que: "format",
      estado: "inferido",
      detalle: `\`${format}\`: flowrunner formatea los tests que escribe planificar antes de bloquearlos`,
    });
  }

  const harness_files = facts.files.filter((f) => HARNESS.test(f)).sort();
  if (harness_files.length > 0) {
    hallazgos.push({ que: "harness_files", estado: "inferido", detalle: harness_files.join(", ") });
  }

  return {
    config: {
      base_branch: facts.baseBranch,
      setup,
      tests_globs,
      ...(format === undefined ? {} : { format }),
      harness_files,
      lockfiles: manager === undefined ? [] : [manager.lockfile],
      manifests: ["package.json"],
    },
    verify,
    hallazgos,
  };
}
