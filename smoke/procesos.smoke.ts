// Smoke del incidente 1 de CUENTAS-1: con el SDK real, un comando permitido que no termina, como un
// Jest que no sale, no deja la sesión colgada ni el proceso vivo.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { runSession } from "../src/agent/session.ts";
import type { QueryFn } from "../src/runner/types.ts";
import type { NewEvent } from "../src/store/events.ts";
import { tripwireHook, type HookPolicy } from "../src/tripwires/hook.ts";
import { newRun, testDeps } from "../test/helpers/project.ts";
import { copyToyRepo } from "./helpers.ts";

const alive = (marker: string) => {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
};

// Si regresiona, una sub-task cuyo runner de tests no sale queda trabada hasta el timeout de la sesión.
test("una sesión real con un comando que no termina vuelve sola y no deja el proceso vivo", async () => {
  const repo = realpathSync(copyToyRepo());
  // Un marcador nuevo en cada corrida: ningún otro proceso, ni la terminal que lanzó el test, lo lleva
  // en su línea de comando.
  const script = `colgado-${randomBytes(4).toString("hex")}.js`;
  writeFileSync(
    join(repo, script),
    'console.log("tests: 1 failed"); setInterval(() => {}, 1000);\n',
  );
  const run = newRun(repo);
  const emitted: NewEvent[] = [];
  const policy: HookPolicy = {
    scope: {
      root: repo,
      owner: "ST-1",
      writable: [],
      writeGlobs: [],
      locked: [],
      harness: [],
      lockfiles: [],
      manifests: [],
      depsDeclared: false,
      testGlobs: [],
      bash: [`node ${script}`],
    },
    fase: "implementar",
    unidad: "ST-1",
    write: false,
    bash: true,
    agents: false,
    graft: false,
  };
  const started = Date.now();
  const result = await runSession(
    {
      fase: "implementar",
      unidad: "ST-1",
      nombre: "implementar-ST-1-1",
      prompt: `Run exactly this command once with the Bash tool, with the Bash tool's timeout parameter set to 5000: \`node ${script}\`. Do not run it again and do not run anything else. Then answer with one sentence saying what it printed, and stop.`,
      cwd: repo,
      model: { model: "claude-haiku-5-5", effort: "low" },
      tools: ["Bash"],
      hook: tripwireHook(policy, (e) => emitted.push(e)),
      maxBudgetUsd: 1,
      timeoutMs: 240_000,
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
  // Bien por debajo del timeout de la sesión: no la sostuvo el proceso colgado.
  expect(Date.now() - started).toBeLessThan(180_000);
  await expect.poll(() => alive(script), { timeout: 5_000 }).toBe(false);
}, 300_000);
