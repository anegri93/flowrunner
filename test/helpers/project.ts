// Un proyecto listo para flowrunner: repo con .flowrunner/ completo, empujado a un remote bare.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { initBrain } from "../../src/brain/brain.ts";
import { stateOf } from "../../src/engine/engine.ts";
import type { Deps, PhaseContext, RunPaths } from "../../src/runner/types.ts";
import type { NewEvent, Phase } from "../../src/store/events.ts";
import { appendEvent, readLog } from "../../src/store/run-log.ts";
import { createRun } from "../../src/store/runs.ts";
import { git, repoWith, tempDir } from "./git.ts";
import { FEATURE } from "./runs.ts";

export interface ProjectOptions {
  readonly config?: Record<string, unknown>;
  /** El cuerpo de verify.sh; por defecto sale 0. */
  readonly verify?: string;
  readonly files?: Record<string, string>;
}

export function makeProject(opts: ProjectOptions = {}): { work: string; remote: string } {
  const work = repoWith({ "README.md": "# proyecto\n", ...opts.files });
  initBrain(work);
  const config = { setup: "true", tests_globs: ["tests/**"], ...opts.config };
  writeFileSync(join(work, ".flowrunner", "config.yaml"), stringify(config));
  const verify = join(work, ".flowrunner", "verify.sh");
  writeFileSync(verify, `#!/bin/sh\n${opts.verify ?? "exit 0"}\n`);
  chmodSync(verify, 0o755);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "flowrunner");
  const remote = tempDir("flowrunner-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  return { work, remote };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export const testDeps = (overrides: Partial<Deps> = {}): Deps => ({
  now: () => new Date("2026-11-07T10:00:00Z"),
  sleep: () => Promise.resolve(),
  notify: () => undefined,
  query: () => {
    throw new Error("este test no usa modelo");
  },
  // Sin tocar el `~/.claude` de quien corre los tests.
  deleteSession: () => Promise.resolve(),
  // Sin red: un test que fija versiones pasa su registro falso.
  registro: () => Promise.reject(new Error("este test no usa el registro")),
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    FLOWRUNNER_AUTH: "login",
  },
  ...overrides,
});

/** Un run de SHOP-214 sobre `repo`, con eventos previos opcionales. */
export function newRun(repo: string, feature = FEATURE, events: NewEvent[] = []): RunPaths {
  const run = createRun(
    tempDir("flowrunner-home-"),
    { clave: "SHOP-214", proyecto: "acme-api", repo, budgetUsd: 25, featureText: feature },
    new Date("2026-11-07T10:00:00Z"),
  );
  for (const event of events) appendEvent(run.dir, event);
  return run;
}

/** El contexto con que el runner llamaría a la fase `fase` sobre este run. */
export function contextFor(
  run: RunPaths,
  fase: Phase,
  deps: Deps,
  extra: Partial<PhaseContext["action"]> = {},
): PhaseContext {
  const events = readLog(run.dir).events;
  const state = stateOf(events);
  return {
    run,
    state,
    action: {
      tipo: "fase",
      fase,
      intento: 1,
      instruccion: undefined,
      unidades: undefined,
      ...extra,
    },
    events,
    emit: (event) => appendEvent(run.dir, event),
    deps,
  };
}
