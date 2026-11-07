import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoWith } from "../../test/helpers/git.ts";
import { ConfigError } from "../config/schemas.ts";
import { initBrain, loadBrain } from "./brain.ts";

function readyRepo(): string {
  const repo = repoWith({ "a.txt": "x\n" });
  initBrain(repo);
  return repo;
}

function problemsOf(repo: string): string {
  try {
    loadBrain(repo);
  } catch (error) {
    if (error instanceof ConfigError)
      return error.problems.map((p) => `${p.where}: ${p.message}`).join("\n");
    throw error;
  }
  throw new Error("se esperaba un ConfigError");
}

describe("loadBrain", () => {
  // Si regresiona, un cerebro que pasa el tope se corta en silencio y el agente pierde reglas.
  test("un archivo en su tope exacto se carga; uno con un carácter más detiene con tamaño y tope", () => {
    const repo = readyRepo();
    writeFileSync(join(repo, ".flowrunner", "convenciones.md"), "ñ".repeat(16_000));
    expect(loadBrain(repo).convenciones).toHaveLength(16_000);
    writeFileSync(join(repo, ".flowrunner", "convenciones.md"), "ñ".repeat(16_001));
    expect(problemsOf(repo)).toMatch(
      /convenciones\.md: tiene 16001 caracteres: el máximo es 16000/,
    );
  });

  // Si regresiona, un link en el cerebro hace leer a flowrunner un archivo fuera del repo.
  test("un archivo del cerebro que es un link es un error", () => {
    const repo = readyRepo();
    const outside = join(repo, "..", `fuera-${Date.now()}.md`);
    writeFileSync(outside, "secreto\n");
    const target = join(repo, ".flowrunner", "contexto.md");
    writeFileSync(target, "");
    symlinkSync(outside, `${target}.link`);
    renameSync(`${target}.link`, target);
    expect(problemsOf(repo)).toMatch(/contexto\.md: es un link/);
  });

  test("un repo sin .flowrunner sugiere brain init", () => {
    expect(problemsOf(repoWith({ "a.txt": "x\n" }))).toMatch(/brain init/);
  });

  test("lista los ejemplos y el sha256 cambia si cambia un byte", () => {
    const repo = readyRepo();
    mkdirSync(join(repo, ".flowrunner", "ejemplos", "prs"), { recursive: true });
    writeFileSync(join(repo, ".flowrunner", "ejemplos", "prs", "412.md"), "buena\n");
    const first = loadBrain(repo);
    expect(first.ejemplos).toEqual([
      ".flowrunner/ejemplos/README.md",
      ".flowrunner/ejemplos/prs/412.md",
    ]);
    writeFileSync(
      join(repo, ".flowrunner", "lecciones.md"),
      `${readFileSync(join(repo, ".flowrunner", "lecciones.md"), "utf8")}x`,
    );
    expect(loadBrain(repo).hashes[".flowrunner/lecciones.md"]).not.toBe(
      first.hashes[".flowrunner/lecciones.md"],
    );
  });
});

describe("initBrain", () => {
  // Si regresiona, correr brain init borra las lecciones que el repo ya juntó.
  test("no pisa archivos existentes y deja verify.sh ejecutable", () => {
    const repo = repoWith({ ".flowrunner/lecciones.md": "### L-1 · propia\n" });
    const created = initBrain(repo);
    expect(created).not.toContain(".flowrunner/lecciones.md");
    expect(created).toContain(".flowrunner/config.yaml");
    expect(readFileSync(join(repo, ".flowrunner", "lecciones.md"), "utf8")).toBe(
      "### L-1 · propia\n",
    );
    expect(statSync(join(repo, ".flowrunner", "verify.sh")).mode & 0o111).not.toBe(0);
    expect(() => loadBrain(repo)).not.toThrow();
  });
});
