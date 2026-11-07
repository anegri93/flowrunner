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

/** Un remote bare y un clon de trabajo con `files`, con `origin` apuntando al bare. */
export function repoWithRemote(files: Record<string, string>): { work: string; remote: string } {
  const work = repoWith(files);
  const remote = tempDir("flowrunner-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  git(work, "fetch", "-q", "origin");
  return { work, remote };
}
