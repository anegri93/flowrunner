import { describe, expect, test } from "vitest";
import { ciStepsVerifyMisses, inferRepo, verifyScript } from "./infer.ts";

const pkg = (scripts: Record<string, string>) => ({ name: "x", scripts });

describe("inferRepo", () => {
  // Si regresiona, init le escribe a un repo npm un setup de pnpm y el primer run se detiene.
  test("repo npm con script check: npm ci, verify con check, tests colocados y vitest.config", () => {
    const inferred = inferRepo({
      baseBranch: "main",
      files: [
        "package.json",
        "package-lock.json",
        "vitest.config.ts",
        "vite.config.ts",
        "compartido/dictado.test.ts",
        "compartido/markdown.test.ts",
        "servidor/api.test.ts",
        "servidor/index.ts",
      ],
      packageJson: pkg({ check: "npm run lint && npm test", lint: "eslint .", test: "vitest run" }),
    });
    expect(inferred.config).toEqual({
      base_branch: "main",
      setup: "npm ci",
      tests_globs: ["compartido/**/*.test.ts", "servidor/**/*.test.ts"],
      harness_files: ["vitest.config.ts"],
      lockfiles: ["package-lock.json"],
      manifests: ["package.json"],
    });
    expect(inferred.verify).toContain("\npaso npm run check\nif");
    expect(inferred.hallazgos.filter((h) => h.estado === "falta")).toEqual([]);
  });

  test("repo pnpm sin check: corre los scripts que existen, los tests primero", () => {
    const inferred = inferRepo({
      baseBranch: "develop",
      files: ["package.json", "pnpm-lock.yaml", "test/a.test.ts", "src/b.spec.tsx"],
      packageJson: pkg({ build: "tsc", test: "vitest", lint: "eslint .", dev: "vite" }),
    });
    expect(inferred.config?.setup).toBe("pnpm install --frozen-lockfile");
    expect(inferred.config?.tests_globs).toEqual(["src/**/*.spec.tsx", "test/**"]);
    expect(inferred.verify).toContain("\npaso pnpm test\npaso pnpm lint\npaso pnpm build\nif");
    expect(inferred.verify).not.toContain("set -e");
  });

  // Si regresiona, planificar escribe tests sin formato, los bloquea, y verify queda en rojo sin arreglo.
  test("con prettier en las dependencias infiere el formateador según el gestor; sin prettier, ninguno", () => {
    const withPrettier = (lockfile: string) =>
      inferRepo({
        baseBranch: "main",
        files: ["package.json", lockfile],
        packageJson: { scripts: { test: "vitest" }, devDependencies: { prettier: "^3.0.0" } },
      }).config?.format;
    expect(withPrettier("package-lock.json")).toBe("npx prettier --write --ignore-unknown");
    expect(withPrettier("pnpm-lock.yaml")).toBe("pnpm exec prettier --write --ignore-unknown");
    const without = inferRepo({
      baseBranch: "main",
      files: ["package.json", "package-lock.json"],
      packageJson: pkg({ test: "vitest" }),
    });
    expect(without.config).not.toHaveProperty("format");
  });

  // Si regresiona, planificar bloquea tests que el lint del repo rechaza, como el `let` de VF-4.
  test("con eslint en las dependencias infiere el lint en modo arreglar; sin eslint, ninguno", () => {
    const withEslint = inferRepo({
      baseBranch: "main",
      files: ["package.json", "pnpm-lock.yaml"],
      packageJson: { scripts: { test: "vitest" }, devDependencies: { eslint: "^9.0.0" } },
    });
    expect(withEslint.config?.lint_fix).toBe("pnpm exec eslint --fix");
    expect(
      inferRepo({
        baseBranch: "main",
        files: ["package.json"],
        packageJson: pkg({ test: "vitest" }),
      }).config,
    ).not.toHaveProperty("lint_fix");
  });

  // Si regresiona, un repo sin tests pasa por bueno y verify no prueba nada.
  test("sin script de test: falta, y lo dice", () => {
    const inferred = inferRepo({
      baseBranch: "main",
      files: ["package.json", "package-lock.json"],
      packageJson: pkg({ lint: "eslint ." }),
    });
    expect(inferred.hallazgos).toContainEqual(
      expect.objectContaining({ que: "verify.sh", estado: "falta" }),
    );
  });

  test("sin package.json: no infiere config y dice que el stack no se reconoce", () => {
    const inferred = inferRepo({ baseBranch: "main", files: ["go.mod"], packageJson: undefined });
    expect(inferred.config).toBeUndefined();
    expect(inferred.hallazgos).toEqual([
      expect.objectContaining({ que: "stack", estado: "falta" }),
    ]);
  });
});

const CI = `
name: ci
on: [pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - run: |
          pnpm --filter @app/api test:e2e
          pnpm audit --audit-level high --prod
`;

describe("ciStepsVerifyMisses", () => {
  // Regresión: en mango-portal-colaborador verify.sh salió sin los e2e que corre el CI, y un run
  // podía quedar en verde con los controles de autorización rotos sin que nada lo dijera.
  test("nombra lo que el CI corre y verify no, sin contar la instalación", () => {
    const verify = verifyScript("pnpm", ["test", "lint"]);
    expect(ciStepsVerifyMisses([CI], verify, {}, "pnpm install --frozen-lockfile")).toEqual([
      "pnpm --filter @app/api test:e2e",
      "pnpm audit --audit-level high --prod",
    ]);
  });

  // Si regresiona, un repo con un script `verify` que ya corre todo recibe un aviso falso por paso.
  test("cuenta como cubierto lo que corre un script que verify llama", () => {
    const verify = verifyScript("pnpm", ["verify"]);
    const scripts = {
      verify: "pnpm lint && pnpm test && pnpm --filter @app/api test:e2e",
      lint: "eslint .",
    };
    expect(ciStepsVerifyMisses([CI], verify, scripts, "pnpm install --frozen-lockfile")).toEqual([
      "pnpm audit --audit-level high --prod",
    ]);
  });

  // Si regresiona, un workflow roto tira abajo init entero en vez de no avisar nada.
  test("ignora un workflow que no es YAML válido", () => {
    expect(ciStepsVerifyMisses(["jobs: [", CI], "pnpm lint\npnpm test", {}, "")).toHaveLength(2);
  });
});
