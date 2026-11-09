import { describe, expect, test } from "vitest";
import { BRAIN_FILES } from "../brain/brain.ts";
import { DRAFT_HEADING, inventedSources, withDraft, type Draft } from "./draft.ts";

const FILES = ["package.json", "src/setup/init.ts", "src/setup/infer.ts", "test/init.int.test.ts"];
const part = (fuentes: string[]) => ({ texto: "- regla", fuentes });
const draft = (fuentes: string[]): Draft => ({
  convenciones: part(["package.json"]),
  contexto: part(fuentes),
  que_es_bien: part(["test/init.int.test.ts"]),
});

describe("inventedSources", () => {
  // Si regresiona, el borrador cita archivos que el modelo inventó y la persona los da por reales.
  test("acepta archivos versionados y carpetas que los tienen; marca el resto", () => {
    expect(
      inventedSources(draft(["src/setup/init.ts", "src/setup", "./src/setup/"]), FILES),
    ).toEqual([]);
    expect(inventedSources(draft(["src/setup/errores.ts", "src/set", "src/setup"]), FILES)).toEqual(
      ["src/setup/errores.ts", "src/set"],
    );
  });
});

describe("withDraft", () => {
  // Si regresiona, lo inferido se mezcla con lo que escribió la persona y no se sabe qué revisar.
  test("deja lo de la persona arriba y el borrador en su sección, con fecha y fuentes", () => {
    const persona = "# Convenciones del repo\n\n- regla mía\n";
    const text = withDraft(persona, part(["src/setup/init.ts", "package.json"]), "2026-11-09");
    expect(text.startsWith(persona)).toBe(true);
    const section = text.slice(text.indexOf(DRAFT_HEADING));
    expect(section).toContain("flowrunner init` del código el 2026-11-09, sin revisión humana");
    expect(section).toContain("- regla");
    expect(section).toContain("Fuentes: `src/setup/init.ts`, `package.json`");
    expect(text.indexOf("- regla mía")).toBeLessThan(text.indexOf(DRAFT_HEADING));
  });

  // Si regresiona, un borrador largo pasa el tope del archivo y el primer run no carga el cerebro.
  test("el borrador más largo que acepta el schema entra en el tope del archivo", () => {
    const fuentes = Array.from({ length: 40 }, (_, i) => `src/modulo-${String(i)}/archivo.ts`);
    const text = withDraft("# Convenciones\n", { texto: "x".repeat(4_000), fuentes }, "2026-11-09");
    expect(Array.from(text).length).toBeLessThan(BRAIN_FILES.convenciones.max);
  });
});
