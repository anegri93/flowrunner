import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWithRemote, tempDir } from "../../test/helpers/git.ts";
import { addWorktree, changesSince, type FileChange } from "../git/git.ts";
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

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

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

  // Si regresiona, un repo git embebido entra como gitlink con lo que tenga adentro, sin chequear.
  test("un arreglo a mano que agrega un repo git adentro del worktree no se commitea", async () => {
    const { work } = repoWithRemote({ "a.txt": "1\n" });
    const wt = join(tempDir(), "w");
    const base = await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    mkdirSync(join(wt, "vendor", "x"), { recursive: true });
    git(join(wt, "vendor", "x"), "init", "-q");
    writeFileSync(join(wt, "vendor", "x", "k.ts"), `const k = "AKIA${"A".repeat(16)}";\n`);
    const changes = await changesSince(wt, base, ENV);
    expect(manualChangeProblems(wt, changes, {}, "R")).toEqual([
      "vendor/x/ es un repositorio git adentro del worktree: no se commitea",
    ]);
  });

  // Regresión: con -z, el trim de la salida de git le sacaba el espacio inicial a la primera ruta, el
  // archivo no se leía y su secreto se commiteaba.
  test("un secreto en un archivo cuyo nombre empieza con espacio tampoco se commitea", async () => {
    const { work } = repoWithRemote({ "a.txt": "1\n" });
    const wt = join(tempDir(), "w");
    const base = await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    writeFileSync(join(wt, " a.ts"), `const k = "AKIA${"A".repeat(16)}";\n`);
    const changes = await changesSince(wt, base, ENV);
    expect(manualChangeProblems(wt, changes, {}, "R")).toEqual([
      " a.ts agrega una access key de AWS; los secretos no se commitean",
    ]);
    // Un archivo agregado que no se puede leer no pasa sin chequear.
    expect(manualChangeProblems(wt, [change("no-esta.ts", [], "agregado")], {}, "R")).toEqual([
      "no-esta.ts no se pudo leer para chequearlo: no se commitea",
    ]);
  });

  // Regresión: un archivo con tildes en el nombre se commiteaba sin mirar si traía un secreto.
  test("un secreto en un archivo con tildes en el nombre tampoco se commitea", async () => {
    const { work } = repoWithRemote({ "a.txt": "1\n" });
    const wt = join(tempDir(), "w");
    const base = await addWorktree(work, wt, "feat/w", "origin/main", ENV);
    writeFileSync(join(wt, "contraseña.ts"), `const k = "AKIA${"A".repeat(16)}";\n`);
    const changes = await changesSince(wt, base, ENV);
    expect(manualChangeProblems(wt, changes, {}, "R")).toEqual([
      "contraseña.ts agrega una access key de AWS; los secretos no se commitean",
    ]);
  });
});
