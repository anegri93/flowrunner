import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { runVerify } from "../phases/verify.ts";
import { nodeSpec, repoNode, satisfies } from "./node.ts";
import { runProc } from "./proc.ts";

/** Un `node` falso en `dir` que solo sabe decir su versión. */
function fakeNode(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "node");
  writeFileSync(bin, `#!/bin/sh\necho v${version}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

/** Una máquina con el Node 25 en el PATH y, en nvm, las versiones de `nvm`. */
function machine(nvm: readonly string[], nvmrc?: string) {
  const home = tempDir("node-home-");
  const system = fakeNode(join(home, "sistema"), "25.8.2");
  for (const v of nvm) fakeNode(join(home, ".nvm", "versions", "node", `v${v}`, "bin"), v);
  const repo = tempDir("node-repo-");
  if (nvmrc !== undefined) writeFileSync(join(repo, ".nvmrc"), nvmrc);
  // HOMEBREW_PREFIX propio: un node@22 de Homebrew en la máquina que corre el test no cuenta.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HOMEBREW_PREFIX: join(home, "brew"),
    PATH: `${system}:/usr/bin:/bin`,
  };
  return { repo, env };
}

const VERIFY = { verify: ".flowrunner/verify.sh" } as unknown as RepoConfig;

function withVerify(repo: string, body: string): void {
  mkdirSync(join(repo, ".flowrunner"), { recursive: true });
  writeFileSync(join(repo, ".flowrunner", "verify.sh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(repo, ".flowrunner", "verify.sh"), 0o755);
}

const versionIn = async (repo: string, env: NodeJS.ProcessEnv) =>
  (await runProc("node", ["-v"], { cwd: repo, env })).stdout.trim();

describe("nodeSpec y satisfies", () => {
  // Si regresiona, un .nvmrc con `v22` o con un alias hace fallar verify en vez de leerse o ignorarse.
  test("leen la versión del repo por prefijo e ignoran los alias", () => {
    expect(nodeSpec(machine([], "v22\n").repo)).toEqual({ version: "22", file: ".nvmrc" });
    expect(nodeSpec(machine([], "lts/*\n").repo)).toBeUndefined();
    expect(nodeSpec(machine([]).repo)).toBeUndefined();
    expect(satisfies("22", "22.13.1")).toBe(true);
    expect(satisfies("22.13", "22.13.1")).toBe(true);
    expect(satisfies("22", "2.2.0")).toBe(false);
    expect(satisfies("22", "25.8.2")).toBe(false);
  });
});

describe("repoNode", () => {
  // Regresión: el job de launchd corría con Node 25 y mango-portal-colaborador fija 22, porque en 24
  // sus e2e crashean a veces; verify daba rojos que no eran del código.
  test("pone primero en el PATH el Node más nuevo instalado que cumple el .nvmrc", async () => {
    const { repo, env } = machine(["20.19.0", "22.1.0", "22.23.2"], "22\n");
    const node = await repoNode(repo, env);
    expect(node.tipo).toBe("ok");
    expect(await versionIn(repo, node.env)).toBe("v22.23.2");
    // verify lo resuelve solo, sin depender de quién lo llama.
    withVerify(repo, 'test "$(node -v)" = v22.23.2');
    expect(await runVerify(repo, VERIFY, env)).toEqual({ ok: true });
  });

  // Si regresiona, flowrunner cambia el Node de repos que no piden ninguno, o del que ya está bien.
  test("deja el entorno igual si el repo no pide versión o el PATH ya la trae", async () => {
    const sin = machine(["22.23.2"]);
    expect(await repoNode(sin.repo, sin.env)).toEqual({ tipo: "ok", env: sin.env });
    const igual = machine(["22.23.2"], "25\n");
    expect(await repoNode(igual.repo, igual.env)).toEqual({ tipo: "ok", env: igual.env });
  });

  // Si regresiona, verify corre con otro Node y el run diagnostica un rojo que no es del código.
  test("sin el Node que pide el repo, verify no corre y dice cómo instalarlo", async () => {
    const { repo, env } = machine(["20.19.0"], "22\n");
    const node = await repoNode(repo, env);
    expect(node).toMatchObject({ tipo: "falta" });
    expect(node.tipo === "falta" ? node.motivo : "").toContain("Node 22 en .nvmrc");
    expect(node.tipo === "falta" ? node.motivo : "").toContain("nvm install 22");

    withVerify(repo, "exit 0");
    const verify = await runVerify(repo, VERIFY, env);
    expect(verify).toMatchObject({ ok: false, unrunnable: true });
    expect(verify.ok ? "" : verify.detail).toContain("nvm install 22");
  });
});

describe("repoNode con Homebrew", () => {
  // Si regresiona, quien instaló node@22 con Homebrew en vez de nvm ve sus runs detenidos.
  test("encuentra el node@<major> de Homebrew", async () => {
    const { repo, env } = machine([], "22\n");
    fakeNode(join(env.HOMEBREW_PREFIX ?? "", "opt", "node@22", "bin"), "22.11.0");
    const node = await repoNode(repo, env);
    expect(node.tipo).toBe("ok");
    expect(await versionIn(repo, node.env)).toBe("v22.11.0");
  });
});
