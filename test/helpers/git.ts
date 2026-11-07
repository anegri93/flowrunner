// Repos git reales en tmpdir para los tests de integración.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tempDir(prefix = "flowrunner-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** Un repo con un commit que contiene `files`, en la rama `main`. */
export function repoWith(files: Record<string, string>): string {
  const dir = tempDir("flowrunner-repo-");
  git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "inicial");
  return dir;
}
