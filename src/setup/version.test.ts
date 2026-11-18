import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { describeVersion, localVersion } from "./version.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

// Si regresiona, el doctor del panel no dice que hay un flowrunner nuevo, o lo dice sin poder contar.
test("cuenta los commits que le faltan para el origin/main del último fetch, sin red", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr-version-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "uno");
  const viejo = sh(dir, "rev-parse", "HEAD");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "dos");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "tres");
  // origin/main como lo deja un fetch, con HEAD dos commits atrás.
  sh(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(dir, "checkout", "-q", "--detach", viejo);

  const v = await localVersion(process.env, dir);
  expect(v).toMatchObject({ sha: viejo.slice(0, 7), atras: 2 });
  expect(describeVersion(v)).toContain("2 commits atrás de origin/main");
  expect(describeVersion(v)).toContain("flowrunner self-update");

  sh(dir, "checkout", "-q", "main");
  expect(describeVersion(await localVersion(process.env, dir))).toContain("al día");
});

test("sin origin/main dice solo la versión", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr-version-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "uno");
  const v = await localVersion(process.env, dir);
  expect(v.main).toBeNull();
  expect(v.atras).toBeNull();
  expect(describeVersion(v)).toBe(`versión ${String(v.sha)}`);
});
