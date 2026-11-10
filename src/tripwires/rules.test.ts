import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import {
  checkContent,
  checkReadPath,
  checkWritePath,
  dependencySectionsChanged,
  type Scope,
} from "./rules.ts";

function scope(extra: Partial<Scope> = {}): Scope {
  const root = realpathSync(tempDir("fr-scope-"));
  mkdirSync(join(root, "src", "export"), { recursive: true });
  return {
    root,
    owner: "ST-2",
    writable: ["src/export/", "src/api/pedidos.ts"],
    writeGlobs: [],
    locked: ["tests/acceptance/ac1.test.ts"],
    harness: ["vitest.config.ts"],
    lockfiles: ["pnpm-lock.yaml"],
    manifests: ["package.json"],
    depsDeclared: false,
    testGlobs: ["tests/**"],
    comandos: {
      ampliables: ["pnpm vitest run tests/acceptance/ac1.test.ts"],
      exactos: [],
      fixers: [],
    },
    ...extra,
  };
}

const reason = (v: { ok: boolean; motivo?: string }) => (v.ok ? "ok" : (v.motivo ?? ""));

describe("rutas de escritura", () => {
  test("dentro del alcance, archivo o carpeta: permitido", () => {
    const s = scope();
    expect(checkWritePath(s, "src/export/csv.ts").ok).toBe(true);
    expect(checkWritePath(s, join(s.root, "src/api/pedidos.ts")).ok).toBe(true);
  });

  // Si regresiona, un agente escribe fuera de su worktree, en el repo de la persona o en el sistema.
  test("`..` y rutas absolutas fuera del worktree: rechazo", () => {
    const s = scope();
    expect(reason(checkWritePath(s, "../otro/x.ts"))).toMatch(/fuera del worktree de ST-2/);
    expect(reason(checkWritePath(s, "/etc/hosts"))).toMatch(/fuera del worktree/);
  });

  test("una carpeta que es un link hacia afuera: rechazo", () => {
    const s = scope();
    const outside = tempDir("fr-outside-");
    symlinkSync(outside, join(s.root, "src", "export", "escape"));
    expect(reason(checkWritePath(s, "src/export/escape/x.ts"))).toMatch(/fuera del worktree/);
  });

  test("dentro del worktree pero fuera del alcance: rechazo que nombra la sub-task", () => {
    expect(reason(checkWritePath(scope(), "src/billing/tarifas.ts"))).toBe(
      "src/billing/tarifas.ts está fuera del alcance de ST-2",
    );
  });

  // Si regresiona, el agente reescribe sus propias reglas o los tests que lo juzgan.
  test("CLAUDE.md, .flowrunner/lecciones.md, un test bloqueado y el harness: rechazo", () => {
    const s = scope({ writable: [""] });
    expect(reason(checkWritePath(s, "CLAUDE.md"))).toMatch(/ningún agente lo escribe/);
    expect(reason(checkWritePath(s, ".flowrunner/lecciones.md"))).toMatch(/\.flowrunner/);
    expect(reason(checkWritePath(s, "tests/acceptance/ac1.test.ts"))).toMatch(/bloqueado/);
    expect(reason(checkWritePath(s, "vitest.config.ts"))).toMatch(/harness/);
  });

  test("lockfile y manifiesto: rechazo sin dependencias declaradas, permitido con", () => {
    expect(reason(checkWritePath(scope(), "pnpm-lock.yaml"))).toMatch(/no declaró ninguna/);
    expect(checkWritePath(scope({ depsDeclared: true }), "package.json").ok).toBe(true);
  });

  test("planificar escribe por globs de tests", () => {
    const s = scope({ writable: [], writeGlobs: ["tests/**"], locked: [] });
    expect(checkWritePath(s, "tests/acceptance/ac2.test.ts").ok).toBe(true);
    expect(checkWritePath(s, "src/export/csv.ts").ok).toBe(false);
  });
});

describe("lectura", () => {
  test("dentro del worktree permitido; fuera rechazado", () => {
    const s = scope();
    expect(checkReadPath(s, "src/x.ts").ok).toBe(true);
    expect(checkReadPath(s, undefined).ok).toBe(true);
    expect(reason(checkReadPath(s, `${process.env.HOME ?? "/Users/x"}/.ssh/id_rsa`))).toMatch(
      /fuera del worktree/,
    );
  });
});

describe("contenido", () => {
  // Si regresiona, un agente apaga el test que no logra pasar y el criterio queda verde sin estarlo.
  test("it.only( agregado en un test: rechazo; `only` en un string de código: permitido", () => {
    const s = scope();
    expect(reason(checkContent(s, "tests/a.test.ts", ["  it.only('x', () => {})"]))).toMatch(
      /skip, only o todo/,
    );
    expect(reason(checkContent(s, "src/export/csv.test.ts", ["describe.skip('x')"]))).toMatch(
      /desactivado/,
    );
    expect(
      checkContent(s, "src/export/csv.ts", ['const msg = "only admins can it.only(";']).ok,
    ).toBe(true);
    expect(checkContent(s, "tests/a.test.ts", ['expect(text).toContain("only")']).ok).toBe(true);
  });

  test("una clave privada o un token: rechazo", () => {
    const s = scope();
    expect(reason(checkContent(s, "src/k.ts", ["-----BEGIN OPENSSH PRIVATE KEY-----"]))).toMatch(
      /clave privada/,
    );
    expect(reason(checkContent(s, "src/k.ts", [`const t = "ghp_${"a".repeat(36)}";`]))).toMatch(
      /GitHub/,
    );
    expect(reason(checkContent(s, "src/k.ts", ['apiKey = "abcdefghijklmnop"']))).toMatch(/secreto/);
    expect(checkContent(s, "src/k.ts", ["const token = process.env.TOKEN;"]).ok).toBe(true);
  });
});

describe("package.json sin dependencias declaradas", () => {
  // Regresión de VF-6: ST-5 no pudo agregar el script `mac` y la documentación quedó mintiendo.
  test("en el alcance se puede tocar; fuera, no, y el motivo dice cómo pedirlo", () => {
    expect(checkWritePath(scope({ writable: ["src/", "package.json"] }), "package.json").ok).toBe(
      true,
    );
    expect(reason(checkWritePath(scope(), "package.json"))).toBe(
      "package.json solo se toca si ST-2 declaró dependencias, y no declaró ninguna. Para cambiar otra cosa, como un script, el plan tiene que poner package.json en el alcance de ST-2",
    );
    // El lockfile no: cambiarlo es cambiar dependencias.
    expect(checkWritePath(scope({ writable: ["pnpm-lock.yaml"] }), "pnpm-lock.yaml").ok).toBe(
      false,
    );
  });

  test("dependencySectionsChanged ve las secciones de dependencias, no los scripts", () => {
    const before = JSON.stringify({ scripts: { a: "1" }, dependencies: { zod: "4" } });
    expect(
      dependencySectionsChanged(
        before,
        JSON.stringify({ scripts: { a: "2" }, dependencies: { zod: "4" } }),
      ),
    ).toEqual([]);
    expect(
      dependencySectionsChanged(
        before,
        JSON.stringify({
          scripts: { a: "1" },
          dependencies: { zod: "4" },
          devDependencies: { x: "1" },
        }),
      ),
    ).toEqual(["devDependencies"]);
    expect(dependencySectionsChanged(before, "{roto")).toEqual(["(el JSON no se lee)"]);
  });
});
