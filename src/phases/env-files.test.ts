import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { copyEnvFiles } from "./env-files.ts";

describe("copyEnvFiles", () => {
  // Si regresiona, los secretos quedan en el worktree que leen revisar y las sub-tasks, o se borra un
  // archivo que el worktree ya tenía.
  test("copia los que faltan y al quitar borra solo lo que copió", () => {
    const repo = tempDir("fr-env-repo-");
    const wt = tempDir("fr-env-wt-");
    writeFileSync(join(repo, ".env.local"), "DATABASE_URL=local\n");
    mkdirSync(join(repo, "apps/api"), { recursive: true });
    writeFileSync(join(repo, "apps/api/.env"), "KEY=1\n");
    writeFileSync(join(repo, ".env"), "del repo\n");
    writeFileSync(join(wt, ".env"), "del worktree\n");

    const copy = copyEnvFiles(repo, wt, [".env.local", "apps/api/.env", ".env"]);
    expect(copy.ok).toBe(true);
    expect(readFileSync(join(wt, ".env.local"), "utf8")).toBe("DATABASE_URL=local\n");
    expect(readFileSync(join(wt, "apps/api/.env"), "utf8")).toBe("KEY=1\n");
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("del worktree\n");

    if (copy.ok) copy.remove();
    expect(existsSync(join(wt, ".env.local"))).toBe(false);
    expect(existsSync(join(wt, "apps/api/.env"))).toBe(false);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("del worktree\n");
  });

  test("si falta uno en el repo, lo dice y no deja copiado ninguno", () => {
    const repo = tempDir("fr-env-repo-");
    const wt = tempDir("fr-env-wt-");
    writeFileSync(join(repo, ".env.local"), "x\n");
    const copy = copyEnvFiles(repo, wt, [".env.local", ".env.test"]);
    expect(copy).toEqual({ ok: false, motivo: `.env.test no existe en ${repo}` });
    expect(existsSync(join(wt, ".env.local"))).toBe(false);
  });
});
