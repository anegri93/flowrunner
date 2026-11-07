// Un proyecto real con remote, registrado en un HOME propio, listo para lanzar runs por CLI con el SDK
// simulado y las fases reales que se pidan.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateOf, type RunState } from "../../src/engine/engine.ts";
import { readLog } from "../../src/store/run-log.ts";
import type { SimScript } from "./sim-sdk.ts";
import { homeWith, runCli } from "./cli.ts";
import { tempDir } from "./git.ts";
import { makeProject, type ProjectOptions } from "./project.ts";

export const SIM_HOOKS = join(import.meta.dirname, "..", "hooks", "sim.ts");

export interface SimWorld {
  readonly work: string;
  readonly remote: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly feature: string;
  launch(): string;
  state(id: string): RunState;
  dir(id: string): string;
  prompts(): string;
  notices(): string;
}

export function simWorld(opts: {
  real: string[];
  scripts: SimScript[];
  feature: string;
  project?: ProjectOptions;
  extraEnv?: Record<string, string>;
}): SimWorld {
  const { work, remote } = makeProject(opts.project);
  const scripts = join(tempDir(), "guiones.json");
  writeFileSync(scripts, JSON.stringify(opts.scripts));
  const env: NodeJS.ProcessEnv = {
    ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
    FLOWRUNNER_TEST_HOOKS: SIM_HOOKS,
    FAKE_SIM_SCRIPTS: scripts,
    FAKE_KEEP_REAL: opts.real.join(","),
    FLOWRUNNER_AUTH: "login",
    GIT_AUTHOR_NAME: "flowrunner-test",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "flowrunner-test",
    GIT_COMMITTER_EMAIL: "t@e",
    ...opts.extraEnv,
  };
  const home = join(env.HOME ?? "", ".flowrunner");
  const feature = join(tempDir(), "feature.md");
  writeFileSync(feature, opts.feature);
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return {
    work,
    remote,
    env,
    home,
    feature,
    launch() {
      const result = runCli(["run", feature, "--json"], env);
      if (result.status !== 0) throw new Error(`run falló: ${result.stdout}${result.stderr}`);
      return (JSON.parse(result.stdout) as { id: string }).id;
    },
    dir: (id) => join(home, "runs", id),
    state: (id) => stateOf(readLog(join(home, "runs", id)).events),
    prompts: () => read(join(env.HOME ?? "", "prompts.log")),
    notices: () => read(join(env.HOME ?? "", "avisos.log")),
  };
}
