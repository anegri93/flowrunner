import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git as gitSync, repoWithRemote, tempDir } from "../../test/helpers/git.ts";
import {
  addWorktree,
  changesSince,
  cherryPick,
  commitAll,
  GitError,
  headSha,
  pushBranch,
} from "./git.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

describe("git", () => {
  // Si regresiona, la feature arranca desde una base local vieja en vez de la del remote.
  test("el worktree nace en el sha de origin/main aunque la base local esté atrasada", async () => {
    const { work, remote } = repoWithRemote({ "a.txt": "1\n" });
    const other = tempDir();
    gitSync(other, "clone", "-q", remote, "c");
    writeFileSync(join(other, "c", "a.txt"), "2\n");
    gitSync(join(other, "c"), "commit", "-qam", "avance");
    gitSync(join(other, "c"), "push", "-q", "origin", "main");
    gitSync(work, "fetch", "-q", "origin");
    const wt = join(tempDir(), "feature");
    const sha = await addWorktree(work, wt, "feat/x", "origin/main", ENV);
    expect(sha).toBe(gitSync(work, "rev-parse", "origin/main"));
    expect(sha).not.toBe(gitSync(work, "rev-parse", "main"));
  });

  // Si regresiona, un conflicto deja el worktree a mitad de un cherry-pick y todo lo que sigue falla.
  test("un cherry-pick con conflicto devuelve el conflicto y deja el worktree sin cambios", async () => {
    const { work } = repoWithRemote({ "a.txt": "base\n" });
    const a = join(tempDir(), "a");
    const b = join(tempDir(), "b");
    await addWorktree(work, a, "feat/a", "origin/main", ENV);
    await addWorktree(work, b, "feat/b", "origin/main", ENV);
    writeFileSync(join(a, "a.txt"), "de a\n");
    const shaA = await commitAll(a, "a", {}, ENV);
    writeFileSync(join(b, "a.txt"), "de b\n");
    await commitAll(b, "b", {}, ENV);
    const before = await headSha(b, ENV);
    const result = await cherryPick(b, shaA ?? "", ENV);
    expect(result).toEqual({ ok: false, conflicts: ["a.txt"] });
    expect(await headSha(b, ENV)).toBe(before);
    expect(gitSync(b, "status", "--porcelain")).toBe("");
  });

  test("commitAll deja el trailer y no commitea si no hay cambios", async () => {
    const { work } = repoWithRemote({ "a.txt": "1\n" });
    const wt = join(tempDir(), "w");
    await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    expect(await commitAll(wt, "nada", {}, ENV)).toBeUndefined();
    writeFileSync(join(wt, "b.txt"), "x\n");
    const sha = await commitAll(wt, "agrega b", { "Flowrunner-Subtask": "ST-1" }, ENV);
    expect(gitSync(wt, "log", "-1", "--format=%B", sha ?? "")).toContain(
      "Flowrunner-Subtask: ST-1",
    );
  });

  // Si regresiona, flowrunner empuja a main y se saltea la PR.
  test("push a main o a una rama ajena falla sin tocar el remote", async () => {
    const { work, remote } = repoWithRemote({ "a.txt": "1\n" });
    const before = gitSync(remote, "rev-parse", "main");
    writeFileSync(join(work, "a.txt"), "2\n");
    gitSync(work, "commit", "-qam", "cambio");
    await expect(pushBranch(work, "main", ENV)).rejects.toThrow(GitError);
    await expect(pushBranch(work, "fix/otra", ENV)).rejects.toThrow(/solo empuja/);
    expect(gitSync(remote, "rev-parse", "main")).toBe(before);
  });

  test("push con el remote movido por otro falla por lease", async () => {
    const { work, remote } = repoWithRemote({ "a.txt": "1\n" });
    const wt = join(tempDir(), "w");
    await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    writeFileSync(join(wt, "a.txt"), "w\n");
    await commitAll(wt, "w", {}, ENV);
    await pushBranch(wt, "feat/w", ENV);
    const other = tempDir();
    gitSync(other, "clone", "-q", "-b", "feat/w", remote, "c");
    writeFileSync(join(other, "c", "a.txt"), "otro\n");
    gitSync(join(other, "c"), "commit", "-qam", "otro");
    gitSync(join(other, "c"), "push", "-q", "origin", "feat/w");
    gitSync(wt, "fetch", "-q", "origin");
    writeFileSync(join(wt, "a.txt"), "w2\n");
    await commitAll(wt, "w2", {}, ENV);
    gitSync(wt, "reset", "-q", "--hard", "HEAD~2");
    writeFileSync(join(wt, "z.txt"), "z\n");
    await commitAll(wt, "z", {}, ENV);
    // El lease compara contra lo que este clon cree del remote, no contra lo que hay ahora.
    gitSync(wt, "update-ref", "refs/remotes/origin/feat/w", gitSync(wt, "rev-parse", "HEAD~1"));
    await expect(pushBranch(wt, "feat/w", ENV)).rejects.toThrow(GitError);
  });

  // Si regresiona, el doble control no ve un archivo que un comando creó sin pasar por Edit.
  test("changesSince incluye modificados, borrados y sin seguimiento con sus líneas agregadas", async () => {
    const { work } = repoWithRemote({ "a.txt": "uno\n", "b.txt": "b\n" });
    const wt = join(tempDir(), "w");
    const base = await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    writeFileSync(join(wt, "a.txt"), "uno\ndos\n");
    gitSync(wt, "rm", "-q", "b.txt");
    writeFileSync(join(wt, "nuevo.txt"), "hola\n");
    const changes = await changesSince(wt, base, ENV);
    expect(changes).toEqual([
      { path: "a.txt", status: "modificado", added: ["dos"] },
      { path: "b.txt", status: "borrado", added: [] },
      { path: "nuevo.txt", status: "agregado", added: ["hola", ""] },
    ]);
  });
});
