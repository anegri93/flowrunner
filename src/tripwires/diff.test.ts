import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWithRemote, tempDir } from "../../test/helpers/git.ts";
import { writeFiles } from "../../test/helpers/project.ts";
import { addWorktree, changesSince } from "../git/git.ts";
import { checkChanges } from "./diff.ts";
import type { Scope } from "./rules.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function worktree() {
  const { work } = repoWithRemote({
    "src/auth/roles.ts": "export const roles = [];\n",
    "tests/ac1.test.ts": "test('ac1')\n",
  });
  const wt = join(tempDir(), "w");
  const base = await addWorktree(work, wt, "feat/x", "origin/main", ENV);
  const scope: Scope = {
    root: realpathSync(wt),
    owner: "ST-2",
    writable: ["src/auth/"],
    writeGlobs: [],
    locked: ["tests/ac1.test.ts"],
    harness: [],
    lockfiles: [],
    manifests: [],
    depsDeclared: false,
    testGlobs: ["tests/**"],
    bash: [],
  };
  return { wt, base, scope };
}

describe("doble control", () => {
  // Si regresiona, un test que escribe archivos como efecto lateral cuela cambios fuera del alcance.
  test("un archivo fuera del alcance creado por un comando, no por Edit: violación", async () => {
    const { wt, base, scope } = await worktree();
    writeFiles(wt, { "src/billing/generado.ts": "export {};\n" });
    git(wt, "add", "-A");
    expect(checkChanges(scope, await changesSince(wt, base, ENV))).toEqual([
      {
        path: "src/billing/generado.ts",
        motivo: "src/billing/generado.ts está fuera del alcance de ST-2",
      },
    ]);
  });

  test("un test bloqueado modificado: violación", async () => {
    const { wt, base, scope } = await worktree();
    writeFileSync(join(wt, "tests/ac1.test.ts"), "test.skip('ac1')\n");
    const violations = checkChanges(scope, await changesSince(wt, base, ENV));
    expect(violations.map((v) => v.motivo)).toEqual([
      "tests/ac1.test.ts es un test de aceptación bloqueado: no se modifica",
    ]);
  });

  test("un diff dentro del alcance: aprobado", async () => {
    const { wt, base, scope } = await worktree();
    writeFileSync(join(wt, "src/auth/roles.ts"), "export const roles = ['exportar'];\n");
    writeFiles(wt, { "src/auth/permisos.ts": "export {};\n" });
    expect(checkChanges(scope, await changesSince(wt, base, ENV))).toEqual([]);
  });

  test("un archivo sin seguimiento fuera del alcance: violación", async () => {
    const { wt, base, scope } = await worktree();
    writeFiles(wt, { "notas.txt": "x\n" });
    expect(checkChanges(scope, await changesSince(wt, base, ENV)).map((v) => v.path)).toEqual([
      "notas.txt",
    ]);
  });

  test("un secreto agregado dentro del alcance: violación", async () => {
    const { wt, base, scope } = await worktree();
    writeFileSync(join(wt, "src/auth/roles.ts"), `export const k = "ghp_${"b".repeat(36)}";\n`);
    expect(checkChanges(scope, await changesSince(wt, base, ENV))[0]?.motivo).toMatch(/GitHub/);
  });
});
