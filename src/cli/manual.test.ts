import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import type { FileChange } from "../git/git.ts";
import { manualChangeProblems } from "./manual.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const LOCKED_TEST = 'import assert from "node:assert";\nassert.equal(1, 1);\n';

function worktree(files: Record<string, string>): string {
  const root = realpathSync(tempDir());
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const change = (path: string, added: string[], status: FileChange["status"] = "modificado") => ({
  path,
  status,
  added,
});

describe("manualChangeProblems", () => {
  const locked = { "tests/ac1.test.mjs": sha256(LOCKED_TEST) };

  // Si regresiona, un arreglo a mano cambia el criterio que la feature tiene que cumplir.
  test("un arreglo a mano que cambia un test bloqueado no se commitea y dice cómo replanificar", () => {
    const root = worktree({ "tests/ac1.test.mjs": `${LOCKED_TEST}// más\n` });
    const problems = manualChangeProblems(
      root,
      [change("tests/ac1.test.mjs", ["// más"])],
      locked,
      "SHOP-1-x",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("tests/ac1.test.mjs es un test bloqueado del plan");
    expect(problems[0]).toContain("flowrunner rerun SHOP-1-x --desde planificar");
    // Borrarlo también lo cambia.
    const gone = worktree({});
    expect(
      manualChangeProblems(gone, [change("tests/ac1.test.mjs", [], "borrado")], locked, "R"),
    ).toHaveLength(1);
  });

  // Si regresiona, flowrunner commitea y empuja un token que la persona pegó en el worktree.
  test("un arreglo a mano que agrega un secreto no se commitea", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const root = worktree({ "src/config.ts": `export const t = "${token}";\n` });
    const problems = manualChangeProblems(
      root,
      [change("src/config.ts", [`export const t = "${token}";`], "agregado")],
      locked,
      "R",
    );
    expect(problems).toEqual([
      "src/config.ts agrega un token de GitHub; los secretos no se commitean",
    ]);
  });

  // Si regresiona, `fix --yo` no sirve para lo que motivó D2: arreglar a mano lo que ningún agente
  // puede tocar, como el CLAUDE.md de VF-6.
  test("un arreglo a mano en el código, sin tocar tests bloqueados, pasa", () => {
    const root = worktree({
      "src/a.ts": "export const a = 1;\n",
      "CLAUDE.md": "# reglas\n",
      ".claude/settings.json": "{}\n",
      "tests/ac1.test.mjs": LOCKED_TEST,
      "tests/nuevo.test.ts": 'test.skip("después", () => {});\n',
    });
    expect(
      manualChangeProblems(
        root,
        [
          change("src/a.ts", ["export const a = 1;"]),
          change("CLAUDE.md", ["# reglas"]),
          change(".claude/settings.json", ["{}"], "agregado"),
          // Igual a su hash: aparece en el diff por un cambio de modo, por ejemplo.
          change("tests/ac1.test.mjs", []),
          change("tests/nuevo.test.ts", ['test.skip("después", () => {});'], "agregado"),
        ],
        locked,
        "R",
      ),
    ).toEqual([]);
  });

  // Si regresiona, un arreglo a mano puede escribir la config o los hooks de git del worktree.
  test("un arreglo a mano que toca .git no se commitea", () => {
    const root = worktree({});
    expect(
      manualChangeProblems(
        root,
        [change(".git/hooks/pre-commit", ["rm -rf ~"], "agregado")],
        {},
        "R",
      ),
    ).toEqual([".git/hooks/pre-commit es parte de .git: no se commitea"]);
    expect(
      manualChangeProblems(root, [change("vendor/x/.git/config", ["x"], "agregado")], {}, "R"),
    ).toEqual(["vendor/x/.git/config es parte de .git: no se commitea"]);
  });
});
