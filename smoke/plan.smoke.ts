// Smoke de la Fase 4: con el SDK real, un run del repo de juguete llega a la espera del plan.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stateOf } from "../src/engine/engine.ts";
import { readLog } from "../src/store/run-log.ts";
import { homeWith, runCli, TEST_BIN } from "../test/helpers/cli.ts";
import { tempDir } from "../test/helpers/git.ts";
import { waitFor } from "../test/helpers/runs.ts";
import { copyToyRepo } from "./helpers.ts";

const FEATURE = `---
clave: TOY-1
proyecto: toy
titulo: Filtrar pedidos confirmados
---
## Descripción
Una función que devuelve solo los pedidos confirmados.

## Criterios
- AC-1: \`confirmados(pedidos)\` exportada de src/pedidos.js devuelve solo los pedidos con estado "confirmado".
`;

test("un plan real del repo de juguete pasa el gate y deja el run esperando aprobación", async () => {
  const repo = copyToyRepo();
  const remote = tempDir("toy-remote-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);
  // El HOME real conserva la sesión de Claude Code; flowrunner usa un home propio.
  const fakeHome = homeWith(`github_user: yo\nprojects:\n  - { name: toy, path: ${repo} }\n`);
  // Solo el osascript falso: el `security` falso de test/bin le ocultaría al CLI de Claude su credencial.
  const onlyNotices = tempDir("smoke-bin-");
  copyFileSync(join(TEST_BIN, "osascript"), join(onlyNotices, "osascript"));
  chmodSync(join(onlyNotices, "osascript"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${onlyNotices}:${process.env.PATH ?? ""}`,
    FLOWRUNNER_HOME: join(fakeHome.HOME ?? "", ".flowrunner"),
    FLOWRUNNER_AUTH: "login",
    // Los falsos escriben acá y no en el HOME real de la persona.
    FAKE_LOG_DIR: tempDir("smoke-logs-"),
  };
  const feature = join(tempDir(), "TOY-1.md");
  writeFileSync(feature, FEATURE);
  const started = runCli(["run", feature, "--json"], env);
  expect(started.status, started.stderr).toBe(0);
  const id = (JSON.parse(started.stdout) as { id: string }).id;
  const dir = join(env.FLOWRUNNER_HOME ?? "", "runs", id);
  const state = await waitFor(
    "el plan real",
    () => {
      const s = stateOf(readLog(dir).events);
      return s.status === "en_curso" ? undefined : s;
    },
    280_000,
  );
  expect(state.halt?.motivo).toBeUndefined();
  expect(state.status).toBe("esperando_aprobacion");
  const plan = runCli(["plan", id], env);
  expect(plan.status).toBe(0);
  expect(plan.stdout).toContain("AC-1");
}, 300_000);
