import { describe, expect, test } from "vitest";
import { ConfigError } from "../config/schemas.ts";
import { parseFeature } from "./feature.ts";

const VALID = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Un administrador descarga los pedidos de un rango de fechas como CSV.

## Criterios
- AC-1: GET /pedidos.csv devuelve text/csv con una fila por pedido
  del rango.
- AC-2: Un usuario sin el permiso exportar recibe 403.

## Aclaraciones
- P: ¿Entran los pedidos cancelados?
  R: No. Solo confirmados y entregados.

## Fuera de alcance
- Exportar a Excel.
`;

function problemsOf(text: string): string {
  try {
    parseFeature("f.md", text);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.map((p) => p.message).join("\n");
    throw error;
  }
  throw new Error("se esperaba un ConfigError");
}

describe("parseFeature", () => {
  // Si regresiona, un criterio partido en dos líneas llega cortado a planificar.
  test("una feature válida trae criterios con sus continuaciones y las aclaraciones", () => {
    const feature = parseFeature("f.md", VALID);
    expect(feature.clave).toBe("SHOP-214");
    expect(feature.criterios).toEqual([
      { id: "AC-1", text: "GET /pedidos.csv devuelve text/csv con una fila por pedido del rango." },
      { id: "AC-2", text: "Un usuario sin el permiso exportar recibe 403." },
    ]);
    expect(feature.aclaraciones).toEqual([
      { question: "¿Entran los pedidos cancelados?", answer: "No. Solo confirmados y entregados." },
    ]);
    expect(feature.fueraDeAlcance).toEqual(["Exportar a Excel."]);
  });

  // Si regresiona, se lanza un run que nunca va a tener nada que verificar.
  test("sin criterios es un error", () => {
    expect(
      problemsOf(VALID.replace(/## Criterios[\s\S]*?## Aclaraciones/, "## Aclaraciones")),
    ).toMatch(/no tiene criterios/);
  });

  test("un criterio sin AC-n o una clave repetida es un error", () => {
    const text = VALID.replace("- AC-2:", "- AC-1:").replace(
      "## Aclaraciones",
      "- exporta rápido\n\n## Aclaraciones",
    );
    const problems = problemsOf(text);
    expect(problems).toMatch(/AC-1 está repetido/);
    expect(problems).toMatch(/no empieza con AC-n/);
  });

  test("una clave mal formada y una sección desconocida llegan juntas", () => {
    const problems = problemsOf(
      VALID.replace("clave: SHOP-214", "clave: shop214").concat("\n## Notas\n"),
    );
    expect(problems).toMatch(/ABC-123/);
    expect(problems).toMatch(/sección desconocida/);
  });

  test("sin frontmatter es un error", () => {
    expect(problemsOf("## Descripción\nalgo\n")).toMatch(/frontmatter/);
  });
});
