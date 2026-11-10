import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contextoGraft, GraftError, llamadoresDe } from "../src/graft/contexto.ts";
import { buildIndex } from "../src/graft/graft.ts";
import { repoWith, tempDir } from "./helpers/git.ts";

const FILES = {
  "src/a/uno.ts": "export function uno(): number { return 1 }\n",
  "src/b/dos.ts": 'import { uno } from "../a/uno.ts"; export const dos = () => uno() + 1;\n',
  "src/a/tres.ts": "export class Tres {}\n",
};

async function indexado(): Promise<{ repo: string; idx: string }> {
  const repo = repoWith(FILES);
  const idx = join(tempDir(), "graft");
  await buildIndex(repo, idx);
  return { repo, idx };
}

describe("el contexto de graft, con el graft real", () => {
  // Si regresiona, la forma del JSON de graft cambió y las sub-tasks arrancan sin su contexto.
  test("contextoGraft con el graft real: la API del alcance, quién la usa desde afuera y la carpeta expandida", async () => {
    const { repo, idx } = await indexado();
    const texto = await contextoGraft({
      repo,
      indexDir: idx,
      archivos: ["src/a/"],
      env: process.env,
    });
    expect(texto).toContain("### `src/a/uno.ts`");
    expect(texto).toContain("function uno(): number");
    expect(texto).toContain("- ← `src/b/dos.ts");
    expect(texto).toContain("### `src/a/tres.ts`");
  });

  // Si regresiona, un índice que falta tira la fase abajo, o pasa como «sin definiciones».
  test("sin índice, contextoGraft no tira y lo dice en el texto", async () => {
    const repo = repoWith(FILES);
    const texto = await contextoGraft({
      repo,
      indexDir: join(tempDir(), "no-hay"),
      archivos: ["src/a/uno.ts"],
      env: process.env,
    });
    expect(texto.startsWith("(graft no pudo armar el contexto:")).toBe(true);
  });

  // Si regresiona, el replan de la PR 09 conserva código que rompe a quien lo llama.
  test("llamadoresDe devuelve los archivos que llaman, y nada para un símbolo que no existe", async () => {
    const { repo, idx } = await indexado();
    expect(await llamadoresDe(repo, idx, "uno", process.env)).toEqual(["src/b/dos.ts"]);
    expect(await llamadoresDe(repo, idx, "noExiste", process.env)).toEqual([]);
  });

  // Revisión: si regresiona, el replan de la PR 09 recibe «nadie lo llama» cuando graft no pudo
  // comprobarlo, y conserva código que rompe a quien lo usa.
  test("sin índice, llamadoresDe tira GraftError en vez de decir que nadie llama", async () => {
    const repo = repoWith(FILES);
    await expect(
      llamadoresDe(repo, join(tempDir(), "no-hay"), "uno", process.env),
    ).rejects.toBeInstanceOf(GraftError);
  });

  // graft resuelve un nombre suelto a cualquier archivo con ese nombre. Si regresiona, un archivo
  // nuevo del alcance aparece con la API de otro.
  test("un archivo que todavía no existe no toma la API de otro con el mismo nombre", async () => {
    const { repo, idx } = await indexado();
    const texto = await contextoGraft({
      repo,
      indexDir: idx,
      archivos: ["uno.ts"],
      env: process.env,
    });
    expect(texto).toContain("### `uno.ts`");
    expect(texto).toContain("todavía no existe");
    expect(texto).not.toContain("function uno");
  });
});
