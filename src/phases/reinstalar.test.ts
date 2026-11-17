import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith } from "../../test/helpers/git.ts";
import { repoConfigSchema } from "../config/schemas.ts";
import { reusarDependencias, soloInstala } from "./reinstalar.ts";

const config = (setup: string) =>
  repoConfigSchema.parse({
    setup,
    tests_globs: ["tests/**"],
    lockfiles: ["package-lock.json"],
    manifests: ["package.json"],
  });

const lock = (packages: Record<string, object>) =>
  `${JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } })}\n`;

const PAQUETES = {
  "node_modules/lib": { version: "1.0.0" },
  "packages/a/node_modules/b": { version: "2.0.0" },
  // De otra plataforma: npm no lo instala, y no cuenta como faltante.
  "node_modules/@esbuild/linux-x64": { version: "0.1.0", optional: true },
};

/** La feature con node_modules instalado e ignorado, y el worktree de la sub-task en otro lugar. */
function instalado(manifiesto = '{"name":"x"}\n', paquetes: Record<string, object> = PAQUETES) {
  const files = {
    ".gitignore": "node_modules/\n",
    "package.json": manifiesto,
    "package-lock.json": lock(paquetes),
    "packages/a/package.json": '{"name":"a"}\n',
  };
  const feature = repoWith(files);
  const instalados = Object.fromEntries(
    Object.entries(PAQUETES).filter(([, p]) => !("optional" in p)),
  );
  mkdirSync(join(feature, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(feature, "node_modules", "lib", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(feature, "node_modules", ".package-lock.json"), lock(instalados));
  mkdirSync(join(feature, "packages", "a", "node_modules", "b"), { recursive: true });
  writeFileSync(join(feature, "packages", "a", "node_modules", "b", "index.js"), "1\n");
  const destino = repoWith(files);
  return { feature, destino };
}

describe("reusar las dependencias de la feature en una sub-task (ADR 0035)", () => {
  // Si regresiona, flowrunner se saltea un setup que no es solo la instalación de npm.
  test("solo un setup que únicamente instala con npm", () => {
    for (const ok of ["npm ci", "npm install", "npm ci --no-audit"])
      expect(soloInstala(ok), ok).toBe(true);
    for (const no of [
      "npm ci && npx prisma generate",
      "pnpm install",
      "yarn",
      "make setup",
      "true",
    ])
      expect(soloInstala(no), no).toBe(false);
  });

  // Si regresiona, cada sub-task vuelve a correr `npm ci` entero: unos 25 a 37 s en pizarra-en-vivo.
  test("clona cada node_modules, también los de los paquetes, si lo instalado es lo del lockfile", async () => {
    const { feature, destino } = instalado();
    expect(await reusarDependencias(feature, destino, config("npm ci"), process.env)).toEqual({
      reusado: true,
    });
    expect(readFileSync(join(destino, "node_modules", "lib", "index.js"), "utf8")).toContain("1");
    expect(existsSync(join(destino, "packages", "a", "node_modules", "b", "index.js"))).toBe(true);
  });

  // Si regresiona, una sub-task arranca con paquetes que no son los de su lockfile: la rama lo cambió,
  // o un replan sacó commits que la feature ya había instalado (hallazgos de /code-review en la #114).
  test("no reusa si lo instalado no es lo que pide el lockfile de la sub-task", async () => {
    const { feature, destino } = instalado();
    writeFileSync(
      join(destino, "package-lock.json"),
      lock({ ...PAQUETES, "node_modules/lib": { version: "1.1.0" } }),
    );
    git(destino, "commit", "-qam", "sube lib");
    expect(await reusarDependencias(feature, destino, config("npm ci"), process.env)).toEqual({
      reusado: false,
    });
    expect(existsSync(join(destino, "node_modules"))).toBe(false);
  });

  // Si regresiona, se saltea un postinstall o un prepare que genera código fuera de node_modules,
  // como un `prisma generate` (hallazgo de /code-review en la #114).
  test("no reusa si algún package.json corre scripts al instalar, ni con otro setup", async () => {
    const conPrepare = instalado('{"name":"x","scripts":{"prepare":"tsc -p packages/a"}}\n');
    expect(
      await reusarDependencias(
        conPrepare.feature,
        conPrepare.destino,
        config("npm ci"),
        process.env,
      ),
    ).toEqual({ reusado: false });
    const { feature, destino } = instalado();
    expect(await reusarDependencias(feature, destino, config("make setup"), process.env)).toEqual({
      reusado: false,
    });
  });

  // Si regresiona, un clon que falla deja node_modules a medias, o vuelve al setup sin que nadie se
  // entere de que la mejora no corre (hallazgo de /code-review en la #114).
  test("si el clon falla, no deja nada a medias y lo avisa", async () => {
    const { feature, destino } = instalado();
    // Un archivo donde va la carpeta: cp no puede escribir ahí.
    mkdirSync(join(destino, "packages", "a"), { recursive: true });
    writeFileSync(join(destino, "packages", "a", "node_modules"), "no soy una carpeta\n");
    const r = await reusarDependencias(feature, destino, config("npm ci"), process.env);
    expect(r.reusado).toBe(false);
    expect(!r.reusado && r.aviso).toMatch(/^no se pudo clonar node_modules de la feature/);
    expect(existsSync(join(destino, "node_modules"))).toBe(false);
  });
});
