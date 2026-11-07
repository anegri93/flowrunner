// Smoke de punta a punta: el SDK real en todas las fases sobre el repo de juguete, gh y osascript
// falsos. De la feature a la PR, con la aprobación del plan en el medio.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stateOf } from "../src/engine/engine.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli, TEST_BIN } from "../test/helpers/cli.ts";
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

test("de la feature a la PR con el SDK real: plan, aprobación, implementar, verificar, revisar y entregar", async () => {
  const repo = copyToyRepo();
  const remote = tempDir("toy-remote-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);
  const bin = tempDir("smoke-bin-");
  for (const tool of ["gh", "osascript"]) {
    copyFileSync(join(TEST_BIN, tool), join(bin, tool));
    chmodSync(join(bin, tool), 0o755);
  }
  const fakeHome = tempDir("smoke-home-");
  const frHome = join(fakeHome, ".flowrunner");
  execFileSync("mkdir", ["-p", frHome]);
  writeFileSync(
    join(frHome, "config.yaml"),
    `github_user: yo\nprojects:\n  - { name: toy, path: ${repo} }\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FLOWRUNNER_HOME: frHome,
    FLOWRUNNER_AUTH: "login",
    // Los falsos escriben acá y no en el HOME real de la persona.
    FAKE_LOG_DIR: tempDir("smoke-logs-"),
  };
  const feature = join(tempDir(), "TOY-1.md");
  writeFileSync(feature, FEATURE);
  const started = runCli(["run", feature, "--json"], env);
  expect(started.status, started.stderr).toBe(0);
  const id = (JSON.parse(started.stdout) as { id: string }).id;
  const dir = join(frHome, "runs", id);
  const settled = (until: string) => () => {
    const s = stateOf(readLog(dir).events);
    return s.status === until || s.status === "detenido" ? s : undefined;
  };
  const waiting = await waitFor("el plan", settled("esperando_aprobacion"), 280_000);
  expect(waiting.halt?.motivo).toBeUndefined();
  expect(runCli(["approve", id], env).status).toBe(0);
  const final = await waitFor("la PR", settled("entregado"), 560_000);
  expect(final.halt?.motivo).toBeUndefined();
  expect(final.status).toBe("entregado");
  const informe = runCli(["report", id], env).stdout;
  expect(informe).toContain("- **PR:** https://github.com/acme/acme-api/pull/412");
  const ghLog = readFileSync(join(env.FAKE_LOG_DIR ?? "", "gh.log"), "utf8");
  expect(ghLog).not.toMatch(/"merge"/);
  console.log(informe);
}, 900_000);
