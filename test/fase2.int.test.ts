// Gate de la Fase 2: un run por CLI con preparar real y el resto de las fases falsas.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { homeWith, runCli } from "./helpers/cli.ts";
import { git, tempDir } from "./helpers/git.ts";
import { makeProject } from "./helpers/project.ts";
import { FAKE_PHASES, FEATURE, waitFor } from "./helpers/runs.ts";
import { writeFileSync } from "node:fs";
import { stateOf } from "../src/engine/engine.ts";

function launchOn(verify: string) {
  const { work } = makeProject({ verify });
  const env: NodeJS.ProcessEnv = {
    ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
    FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
    FAKE_KEEP_REAL: "preparar",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const feature = join(tempDir(), "SHOP-214.md");
  writeFileSync(feature, FEATURE);
  const started = runCli(["run", feature, "--json"], env);
  expect(started.status, started.stderr).toBe(0);
  const id = (JSON.parse(started.stdout) as { id: string }).id;
  const dir = join(env.HOME ?? "", ".flowrunner", "runs", id);
  const stateNow = () => stateOf(readLog(dir).events);
  return { id, dir, stateNow, env, work };
}

describe("Fase 2 ensamblada", () => {
  test("con la base verde, preparar real deja el worktree y el índice de graft, y el run llega a entregado", async () => {
    const r = launchOn("exit 0");
    await waitFor("entregado", () => r.stateNow().status === "entregado", 60_000);
    const preparado = readLog(r.dir).events.find((e) => e.tipo === "preparado");
    expect(
      preparado?.tipo === "preparado" && git(preparado.worktree, "status", "--porcelain"),
    ).toBe("");
    expect(existsSync(join(r.dir, "graft"))).toBe(true);
  });

  // Si regresiona, flowrunner arranca a gastar suscripción sobre una base rota.
  test("con la base roja, el run se detiene en preparar sin ningún evento de uso", async () => {
    const r = launchOn('echo "falla un test" >&2\nexit 1');
    await waitFor("detenido", () => r.stateNow().status === "detenido", 60_000);
    const state = r.stateNow();
    expect(state.fase).toBe("preparar");
    expect(state.halt?.motivo).toMatch(/no está en verde[\s\S]*falla un test/);
    expect(readLog(r.dir).events.filter((e) => e.tipo === "uso")).toEqual([]);
    const status = runCli(["status", r.id], r.env);
    expect(status.stdout).toContain(
      `Opciones:\n  flowrunner resume ${r.id}  ·  retomar en preparar\n  flowrunner abort ${r.id}  ·  `,
    );
  });
});
