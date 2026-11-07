// El CLI real como proceso hijo, con un HOME propio por test.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./git.ts";

export const BIN = join(import.meta.dirname, "..", "..", "bin", "flowrunner.js");
export const TEST_BIN = join(import.meta.dirname, "..", "bin");

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(args: readonly string[], env: NodeJS.ProcessEnv, input?: string): CliResult {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", BIN, ...args],
    {
      env,
      encoding: "utf8",
      timeout: 60_000,
      ...(input === undefined ? {} : { input }),
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Un HOME con `~/.flowrunner/config.yaml` y el PATH con los binarios falsos de test/bin primero. */
export function homeWith(globalYaml: string): NodeJS.ProcessEnv {
  const home = tempDir("flowrunner-home-");
  mkdirSync(join(home, ".flowrunner"), { recursive: true });
  writeFileSync(join(home, ".flowrunner", "config.yaml"), globalYaml);
  return {
    HOME: home,
    PATH: `${TEST_BIN}:${process.env.PATH ?? ""}`,
    USER: process.env.USER ?? "test",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
}
