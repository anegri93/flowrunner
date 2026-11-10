import { describe, expect, test } from "vitest";
import { exploracionMd } from "./explorar.ts";

describe("explorar", () => {
  // Si regresiona, el planificador recibe el informe sin la sección que falta, y no sabe si el
  // explorador no encontró nada o no lo buscó: vuelve a leer para saberlo.
  test("el informe en Markdown tiene una sección por campo y dice ninguno donde no hay", () => {
    const md = exploracionMd({
      archivos: [
        { ruta: "src/export/pedidos.js", lineas: "1-3", que: "arma la consulta por rango" },
      ],
      funciones: [],
      tests_existentes: [],
      riesgos: [],
      dudas: [],
    });
    expect(md).toContain("## Archivos");
    expect(md).toContain("- src/export/pedidos.js:1-3 — arma la consulta por rango");
    expect(md).toMatch(/## Funciones\n+\(ninguno\)/);
    for (const seccion of ["## Tests que ya existen", "## Riesgos", "## Dudas"])
      expect(md).toContain(seccion);
  });
});
