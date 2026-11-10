// Gate de la Fase 3: una sesión con un Edit fuera del alcance, sobre un worktree real, con el hook,
// el doble control y el log del run reales.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runSession } from "../src/agent/session.ts";
import { addWorktree, changesSince } from "../src/git/git.ts";
import { appendEvent, readLog } from "../src/store/run-log.ts";
import { SIN_COMANDOS } from "../src/tripwires/comandos.ts";
import { checkChanges } from "../src/tripwires/diff.ts";
import { tripwireHook, type HookPolicy } from "../src/tripwires/hook.ts";
import { repoWithRemote, tempDir } from "./helpers/git.ts";
import { newRun, testDeps } from "./helpers/project.ts";
import { simQuery } from "./helpers/sim-sdk.ts";

describe("Fase 3 ensamblada", () => {
  // Si regresiona, un agente escribe fuera de su sub-task y el cambio llega al commit.
  test("el hook rechaza el Edit fuera del alcance, el diff queda limpio y el log registra rechazo y uso", async () => {
    const deps = testDeps({ env: { ...testDeps().env, FLOWRUNNER_AUTH: "login" } });
    const { work } = repoWithRemote({
      "src/auth/roles.ts": "export const roles = [];\n",
      "src/billing/tarifas.ts": "export const tarifa = 1;\n",
    });
    const wt = join(tempDir(), "ST-2");
    const base = await addWorktree(work, wt, "feat/SHOP-214/ST-2", "origin/main", deps.env);
    const run = newRun(work);
    const policy: HookPolicy = {
      scope: {
        root: realpathSync(wt),
        owner: "ST-2",
        writable: ["src/auth/roles.ts"],
        writeGlobs: [],
        locked: [],
        harness: [],
        lockfiles: [],
        manifests: [],
        depsDeclared: false,
        testGlobs: ["tests/**"],
        comandos: SIN_COMANDOS,
      },
      fase: "implementar",
      unidad: "ST-2",
      write: true,
      bash: false,
      agents: false,
      graft: false,
    };
    const emit = (e: Parameters<typeof appendEvent>[1]) => appendEvent(run.dir, e);
    const sim = simQuery([
      {
        calls: [
          {
            tool: "Edit",
            input: { file_path: "src/billing/tarifas.ts", old_string: "1", new_string: "2" },
          },
        ],
        costUsd: 0.07,
      },
    ]);
    const result = await runSession(
      {
        fase: "implementar",
        unidad: "ST-2",
        nombre: "implementar-ST-2-1",
        prompt: "agregá el permiso",
        cwd: wt,
        model: { model: "claude-sonnet-5-5", effort: "high" },
        tools: ["Read", "Edit"],
        hook: tripwireHook(policy, emit),
        maxBudgetUsd: 2,
        timeoutMs: 60_000,
      },
      { run, deps: { ...deps, query: sim.query }, emit },
    );
    expect(result.tipo).toBe("ok");
    expect(sim.records[0]?.decisions).toEqual([
      {
        tool: "Edit",
        decision: "deny",
        reason: "src/billing/tarifas.ts está fuera del alcance de ST-2",
      },
    ]);
    expect(checkChanges(policy.scope, await changesSince(wt, base, deps.env))).toEqual([]);
    expect(await changesSince(wt, base, deps.env)).toEqual([]);
    const events = readLog(run.dir).events;
    expect(events.filter((e) => e.tipo === "rechazo")).toHaveLength(1);
    expect(events.find((e) => e.tipo === "uso")).toMatchObject({ costo_usd: 0.07, unidad: "ST-2" });
  });
});
