import { describe, expect, test } from "vitest";
import { inferRepo } from "./infer.ts";

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
