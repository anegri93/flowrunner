// Smoke de T3.3: con el SDK real, el hook rechaza una escritura fuera del alcance en el acto.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { runSession } from "../src/agent/session.ts";
import type { QueryFn } from "../src/runner/types.ts";
import type { NewEvent } from "../src/store/events.ts";
import { SIN_COMANDOS } from "../src/tripwires/comandos.ts";
import { tripwireHook, type HookPolicy } from "../src/tripwires/hook.ts";
import { newRun, testDeps } from "../test/helpers/project.ts";
import { copyToyRepo } from "./helpers.ts";

// Si regresiona, un agente escribe fuera de su sub-task y nadie lo frena hasta el commit.
test("una sesión real que intenta escribir fuera del alcance termina sin el archivo y con el motivo", async () => {
  const repo = realpathSync(copyToyRepo());
  const run = newRun(repo);
  const emitted: NewEvent[] = [];
  const policy: HookPolicy = {
    scope: {
      root: repo,
      owner: "ST-1",
      writable: ["src/pedidos.js"],
      writeGlobs: [],
      locked: [],
      harness: [],
      lockfiles: [],
      manifests: [],
      depsDeclared: false,
      testGlobs: ["test/**"],
      comandos: SIN_COMANDOS,
    },
    fase: "implementar",
    unidad: "ST-1",
    write: true,
    bash: false,
    agents: false,
    graft: false,
  };
  const result = await runSession(
    {
      fase: "implementar",
      unidad: "ST-1",
      nombre: "implementar-ST-1-1",
      prompt:
        "Use the Write tool exactly once to create the file src/billing/tarifas.js with the content `export const x = 1;`. If the tool is denied, do not retry: answer with the denial reason and stop.",
      cwd: repo,
      model: { model: "claude-haiku-5-5", effort: "low" },
      tools: ["Write"],
      hook: tripwireHook(policy, (e) => emitted.push(e)),
      maxBudgetUsd: 1,
      timeoutMs: 180_000,
      maxTurns: 4,
    },
    {
      run,
      deps: testDeps({
        query: query as QueryFn,
        env: { ...process.env, FLOWRUNNER_AUTH: "login" },
      }),
      emit: (e) => emitted.push(e),
    },
  );
  expect(result.tipo).toBe("ok");
  expect(existsSync(join(repo, "src", "billing", "tarifas.js"))).toBe(false);
  expect(emitted).toContainEqual(
    expect.objectContaining({
      tipo: "rechazo",
      herramienta: "Write",
      motivo: "src/billing/tarifas.js está fuera del alcance de ST-1",
    }),
  );
  const transcript = readFileSync(join(run.dir, "sesiones", "implementar-ST-1-1.jsonl"), "utf8");
  expect(transcript).toContain("está fuera del alcance de ST-1");
});
