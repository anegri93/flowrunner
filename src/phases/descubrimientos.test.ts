import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { llamarHerramienta } from "../../test/helpers/mcp.ts";
import type { NewEvent } from "../store/events.ts";
import { descubrimientosServer } from "./descubrimientos.ts";

function servidor() {
  const worktree = tempDir("fr-descubrimientos-");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "Conectar.tsx"), "a\nb\nc\n");
  const emitted: NewEvent[] = [];
  const server = descubrimientosServer({
    worktree,
    unidad: "ST-1",
    emit: (e) => {
      emitted.push(e);
    },
  });
  const anotar = (donde: string, que = "Excalidraw descarta un pointermove en window") =>
    llamarHerramienta(server, "anotar_descubrimiento", {
      que,
      donde,
      como: "la vista previa no llegaba al cursor",
    });
  return { anotar, emitted };
}

describe("anotar_descubrimiento (flowrunner 2.0)", () => {
  // Si regresiona, lo que el que implementa descubre del repo se pierde en su transcript y el próximo
  // run lo vuelve a descubrir: en 33 runs, implementar no dejó ni una decisión registrada.
  test("cada descubrimiento queda como evento con su sub-task, hasta tres por sesión", async () => {
    const { anotar, emitted } = servidor();
    for (const n of [1, 2, 3]) await anotar("src/Conectar.tsx:2", `descubrimiento ${String(n)}`);
    const cuarto = await anotar("src/Conectar.tsx:3");
    expect(cuarto.content[0]?.text).toMatch(/ya anotaste 3/);
    expect(emitted).toEqual(
      [1, 2, 3].map((n) => ({
        tipo: "descubrimiento",
        fase: "implementar",
        unidad: "ST-1",
        que: `descubrimiento ${String(n)}`,
        donde: "src/Conectar.tsx:2",
        como: "la vista previa no llegaba al cursor",
      })),
    );
  });

  // Si regresiona, una lección del cerebro termina citando un archivo o una línea que no existe.
  test("un donde que no es archivo:línea de un archivo del worktree se descarta con un aviso", async () => {
    const { anotar, emitted } = servidor();
    for (const donde of [
      "src/NoExiste.tsx:1",
      "src/Conectar.tsx",
      "src/Conectar.tsx:9",
      "../x:1",
    ]) {
      const r = await anotar(donde);
      expect(r.content[0]?.text, donde).toMatch(/no lo anoté/);
    }
    expect(emitted.every((e) => e.tipo === "aviso")).toBe(true);
    expect(emitted).toHaveLength(4);
  });
});
