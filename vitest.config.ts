import { defineConfig } from "vitest/config";

// unit: sin red, sin suscripción. integration: git real, CLI como proceso hijo, query y gh falsos.
// smoke: el SDK real con la suscripción; nunca en CI.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/**/*.int.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "smoke",
          include: ["smoke/**/*.smoke.ts"],
          testTimeout: 300_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
