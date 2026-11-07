// Smoke de la Fase 5: Haiku real implementa dos sub-tasks en paralelo sobre el repo de juguete, y
// verificar real corre sus criterios.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { Plan } from "../src/gates/plan.ts";
import { commitAll } from "../src/git/git.ts";
import { implementar } from "../src/phases/implementar.ts";
import { prepared } from "../src/phases/inputs.ts";
import { writePlanArtifacts } from "../src/phases/planificar.ts";
import { preparar } from "../src/phases/preparar.ts";
import { verificar } from "../src/phases/verificar.ts";
import { runUntilStop } from "../src/runner/runner.ts";
import type { PhaseFn, PhaseRegistry, QueryFn } from "../src/runner/types.ts";
import { PHASES } from "../src/store/events.ts";
import { appendEvent, readLog } from "../src/store/run-log.ts";
import { git, tempDir } from "../test/helpers/git.ts";
import { contextFor, newRun, testDeps, writeFiles } from "../test/helpers/project.ts";
import { copyToyRepo } from "./helpers.ts";

const FEATURE = `---
clave: TOY-2
proyecto: toy
titulo: Filtros de pedidos
---
## Descripción
Dos filtros de pedidos por estado.

## Criterios
- AC-1: \`confirmados(lista)\` de src/confirmados.js devuelve los pedidos con estado "confirmado".
- AC-2: \`cancelados(lista)\` de src/cancelados.js devuelve los pedidos con estado "cancelado".
`;

const testFor = (fn: string, estado: string) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { ${fn} } from "../src/${fn}.js";
import { pedidos } from "../src/pedidos.js";

test("${fn} devuelve solo los ${estado}", () => {
  assert.deepEqual(${fn}(pedidos).map((p) => p.id), pedidos.filter((p) => p.estado === "${estado}").map((p) => p.id));
});
`;

const plan: Plan = {
  plan: "Dos funciones nuevas, cada una en su archivo, con filter sobre el estado.",
  subtareas: [
    {
      id: "ST-1",
      titulo: "Filtro de confirmados",
      descripcion: "Crear src/confirmados.js que exporta confirmados(lista).",
      alcance: ["src/confirmados.js"],
      dependencias: [],
      depende_de: [],
    },
    {
      id: "ST-2",
      titulo: "Filtro de cancelados",
      descripcion: "Crear src/cancelados.js que exporta cancelados(lista).",
      alcance: ["src/cancelados.js"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [
    { id: "AC-1", comando: "node --test test/confirmados.test.js", subtarea: "ST-1" },
    { id: "AC-2", comando: "node --test test/cancelados.test.js", subtarea: "ST-2" },
  ],
  tests: ["test/confirmados.test.js", "test/cancelados.test.js"],
  decisiones: [],
};

test("dos sub-tasks reales en paralelo quedan integradas y verificar las da por verdes", async () => {
  const repo = copyToyRepo();
  const remote = tempDir("toy-remote-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);
  const deps = testDeps({
    query: query as QueryFn,
    env: { ...process.env, FLOWRUNNER_AUTH: "login" },
  });
  const run = newRun(repo, FEATURE);
  expect(await preparar(contextFor(run, "preparar", deps))).toEqual({ tipo: "ok" });
  const wt = prepared(readLog(run.dir).events).worktree;
  const tests = {
    "test/confirmados.test.js": testFor("confirmados", "confirmado"),
    "test/cancelados.test.js": testFor("cancelados", "cancelado"),
  };
  writeFiles(wt, tests);
  await commitAll(wt, "test: criterios de TOY-2, en rojo", {}, deps.env);
  writePlanArtifacts(
    run,
    plan,
    Object.fromEntries(
      Object.keys(tests).map((p) => [
        p,
        createHash("sha256")
          .update(readFileSync(join(wt, p), "utf8"))
          .digest("hex"),
      ]),
    ),
  );
  for (const fase of ["planificar", "aprobar"] as const) {
    appendEvent(run.dir, { tipo: "accion_iniciada", fase });
    appendEvent(run.dir, { tipo: "accion_terminada", fase, resultado: { tipo: "ok" } });
  }
  const ok: PhaseFn = () => Promise.resolve({ tipo: "ok" });
  const registry = Object.fromEntries(PHASES.map((f) => [f, ok])) as PhaseRegistry;
  registry.implementar = implementar;
  registry.verificar = verificar;
  const final = await runUntilStop(run, registry, deps);
  expect(final.halt?.motivo).toBeUndefined();
  expect(final.status).toBe("entregado");
  const subjects = git(wt, "log", "--format=%s", "-2").split("\n").sort();
  expect(subjects).toEqual([
    "feat: Filtro de cancelados · ST-2",
    "feat: Filtro de confirmados · ST-1",
  ]);
}, 600_000);
