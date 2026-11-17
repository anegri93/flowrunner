import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith, tempDir } from "../../test/helpers/git.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import { reusarDependencias, soloInstala } from "./reinstalar.ts";

const config = (setup: string) =>
  repoConfigSchema.parse({
    setup,
    tests_globs: ["tests/**"],
    lockfiles: ["package-lock.json"],
    manifests: ["package.json"],
  });

/** Un repo con node_modules instalado e ignorado, y una carpeta vacía para la sub-task. */
function instalado() {
  const repo = repoWith({
    ".gitignore": "node_modules/\n",
    "package.json": '{"name":"x"}\n',
    "package-lock.json": "{}\n",
    "packages/a/package.json": '{"name":"a"}\n',
  });
  mkdirSync(join(repo, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "lib", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, "packages", "a", "node_modules", "b"), { recursive: true });
  writeFileSync(join(repo, "packages", "a", "node_modules", "b", "index.js"), "1\n");
  const base = git(repo, "rev-parse", "HEAD");
  return { repo, base, destino: tempDir() };
}

describe("reusar las dependencias de la feature en una sub-task (ADR 0035)", () => {
  // Si regresiona, flowrunner se saltea un setup que hace más que instalar, como un `prisma generate`.
  test("solo un setup que únicamente instala paquetes de node", () => {
    for (const ok of [
      "npm ci",
      "npm install",
      "pnpm install --frozen-lockfile",
      "yarn",
      "yarn install",
    ])
      expect(soloInstala(ok), ok).toBe(true);
    for (const no of [
      "npm ci && npx prisma generate",
      "make setup",
      "true",
      "npm run build",
      "pip install -r r.txt",
    ])
      expect(soloInstala(no), no).toBe(false);
  });

  // Si regresiona, cada sub-task vuelve a correr `npm ci` entero: unos 25 a 37 s en pizarra-en-vivo.
  test("clona cada node_modules, también los de los paquetes, sin correr el setup", async () => {
    const { repo, base, destino } = instalado();
    expect(await reusarDependencias(repo, destino, config("npm ci"), base, base, process.env)).toBe(
      true,
    );
    expect(readFileSync(join(destino, "node_modules", "lib", "index.js"), "utf8")).toContain("1");
    expect(existsSync(join(destino, "packages", "a", "node_modules", "b", "index.js"))).toBe(true);
  });

  // Si regresiona, una sub-task arranca con los paquetes de la base cuando la rama ya cambió el
  // lockfile o un manifiesto, o se saltea un setup que no es solo instalar.
  test("no reusa si la rama cambió un manifiesto o el lockfile, ni con otro setup", async () => {
    const { repo, base, destino } = instalado();
    expect(
      await reusarDependencias(repo, destino, config("make setup"), base, base, process.env),
    ).toBe(false);
    writeFileSync(join(repo, "packages", "a", "package.json"), '{"name":"a","version":"2"}\n');
    git(repo, "commit", "-qam", "sube a");
    const start = git(repo, "rev-parse", "HEAD");
    expect(
      await reusarDependencias(repo, destino, config("npm ci"), base, start, process.env),
    ).toBe(false);
    expect(existsSync(join(destino, "node_modules"))).toBe(false);
  });
});
