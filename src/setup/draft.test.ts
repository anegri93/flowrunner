import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { BRAIN_FILES } from "../brain/brain.ts";
import {
  describeToolUse,
  docFiles,
  DRAFT_HEADING,
  inventedSources,
  PROBAR_COMMENT,
  withDraft,
  withProbar,
  withoutDraft,
  type Draft,
} from "./draft.ts";

const FILES = ["package.json", "src/setup/init.ts", "src/setup/infer.ts", "test/init.int.test.ts"];
const part = (fuentes: string[]) => ({ texto: "- regla", fuentes });
const draft = (fuentes: string[]): Draft => ({
  convenciones: part(["package.json"]),
  contexto: part(fuentes),
  que_es_bien: part(["test/init.int.test.ts"]),
  probar: { config: null, motivo: "no hay app", fuentes: ["package.json"] },
});

const CONFIG = "# Lo armó flowrunner init.\nsetup: npm ci\ntests_globs: [test/**]\n";
const probar = (urls: Record<string, string>, bajar: string | null = null): Draft["probar"] => ({
  config: { levantar: "PORT=4399 npm run dev", sigue_corriendo: true, bajar, urls, notas: "" },
  motivo: "`dev` en package.json levanta el servidor",
  fuentes: ["package.json"],
});

describe("describeToolUse", () => {
  // Si regresiona, la terminal muestra rutas absolutas del worktree temporal, o nada.
  test("dice qué mira la sesión con rutas del repo, y calla lo que no es una lectura", () => {
    const root = "/home/x/.flowrunner/init/repo-borrador";
    expect(describeToolUse("Read", { file_path: `${root}/src/a.ts` }, root)).toBe("lee src/a.ts");
    expect(describeToolUse("Read", { file_path: "/etc/hosts" }, root)).toBe("lee /etc/hosts");
    expect(describeToolUse("Grep", { pattern: "throw new", path: `${root}/src` }, root)).toBe(
      "busca «throw new» en src",
    );
    expect(describeToolUse("Glob", { pattern: "**/*.test.ts" }, root)).toBe("lista **/*.test.ts");
    expect(describeToolUse("StructuredOutput", { convenciones: {} }, root)).toBeUndefined();
    expect(describeToolUse("Read", null, root)).toBeUndefined();
  });
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
  test("deja lo de la persona arriba y el borrador en su sección, con fecha y commit", () => {
    const persona = "# Convenciones del repo\n\n- regla mía\n";
    const text = withDraft(
      persona,
      part(["src/setup/init.ts", "package.json"]),
      "2026-11-09",
      "f7e1ac2",
    );
    expect(text.startsWith(persona)).toBe(true);
    const section = text.slice(text.indexOf(DRAFT_HEADING));
    expect(section).toContain("del repo en `f7e1ac2` el 2026-11-09, sin revisión humana");
    expect(section).toContain("- regla");
    expect(text.indexOf("- regla mía")).toBeLessThan(text.indexOf(DRAFT_HEADING));
    // Si regresiona, la lista de fuentes repite las citas de cada regla y se carga en cada prompt.
    expect(section).not.toContain("Fuentes:");
  });

  // Si regresiona, un borrador largo pasa el tope del archivo y el primer run no carga el cerebro.
  test("el borrador más largo que acepta el schema entra en el tope del archivo", () => {
    const fuentes = Array.from({ length: 40 }, (_, i) => `src/modulo-${String(i)}/archivo.ts`);
    const text = withDraft(
      "# Convenciones\n",
      { texto: "x".repeat(6_000), fuentes },
      "2026-11-09",
      "f7e1ac2",
    );
    expect(Array.from(text).length).toBeLessThan(BRAIN_FILES.convenciones.max);
  });
});

describe("withoutDraft", () => {
  // Si regresiona, --reemplazar apila el borrador nuevo sobre el viejo o se come lo de la persona.
  test("saca la sección del borrador y deja intacto lo que está arriba", () => {
    const persona = "# Convenciones\n\n- regla mía\n";
    const text = withDraft(persona, part(["package.json"]), "2026-11-09", "f7e1ac2");
    expect(withoutDraft(text)).toBe(persona);
    expect(withoutDraft(persona)).toBe(persona);
  });
});

describe("docFiles", () => {
  // Si regresiona, el borrador redescubre del código reglas que el repo ya tenía escritas, o se
  // pierde las de una carpeta de reglas de agentes.
  test("lista lo que el repo documenta para personas y agentes, la raíz primero, sin el cerebro", () => {
    expect(
      docFiles([
        "src/a.ts",
        "apps/api/CLAUDE.md",
        "CLAUDE.md",
        ".claude/rules/arquitectura.md",
        ".claude/settings.json",
        ".github/workflows/ci.yml",
        "docs/adr/0001-algo.md",
        "docs/img/logo.png",
        ".flowrunner/contexto.md",
        "node_modules/x/README.md",
        ".nvmrc",
      ]),
    ).toEqual([
      ".nvmrc",
      "CLAUDE.md",
      ".claude/rules/arquitectura.md",
      ".github/workflows/ci.yml",
      "apps/api/CLAUDE.md",
      "docs/adr/0001-algo.md",
    ]);
  });
});

describe("withProbar", () => {
  // Si regresiona, init no deja cómo probar y cada run saltea probar sin que nadie lo sepa (PIZ-2).
  test("agrega la sección al final, comentada, sin tocar lo que ya estaba", () => {
    const next = withProbar(CONFIG, probar({ web: "http://127.0.0.1:4399" }));
    expect("text" in next).toBe(true);
    const text = "text" in next ? next.text : "";
    expect(text.startsWith(CONFIG.trimEnd())).toBe(true);
    for (const line of PROBAR_COMMENT) expect(text).toContain(line);
    expect((parse(text) as { probar: unknown }).probar).toEqual({
      levantar: "PORT=4399 npm run dev",
      sigue_corriendo: true,
      urls: { web: "http://127.0.0.1:4399" },
    });
  });

  // Si regresiona, la fase probar navega o llama a un entorno de afuera, con datos reales.
  test("rechaza URLs que no son de esta máquina, y una propuesta sin config dice qué falta", () => {
    expect(
      withProbar(CONFIG, probar({ web: "http://localhost:3000", api: "https://api.ejemplo.com" })),
    ).toEqual({ motivo: "propuso URLs que no son de esta máquina: https://api.ejemplo.com" });
    expect(withProbar(CONFIG, probar({}))).toEqual({ motivo: "no propuso ninguna URL" });
    expect(
      withProbar(CONFIG, { config: null, motivo: "falta la base de datos", fuentes: ["x"] }),
    ).toEqual({ motivo: "falta la base de datos" });
  });
});
