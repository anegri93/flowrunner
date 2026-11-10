import { describe, expect, test } from "vitest";
import { archivosNombrados, checkCitas } from "./citas.ts";

describe("citas", () => {
  // Si regresiona, una cita al código que la feature va a crear, o a una línea que ya no está, llega al
  // planificador como si fuera el código de hoy.
  test("checkCitas frena un archivo inexistente y una línea fuera del archivo", () => {
    const archivos: Record<string, string> = { "src/a.ts": "uno\ndos\ntres\n" };
    const leer = (ruta: string) => archivos[ruta];
    expect(
      checkCitas(
        [
          { ruta: "src/a.ts", desde: 2, hasta: 3, que: "dentro" },
          { ruta: "src/a.ts", que: "el archivo entero" },
          { ruta: "src/nuevo.ts", que: "todavía no existe" },
          { ruta: "src/a.ts", desde: 3, hasta: 4, que: "se pasa" },
        ],
        leer,
      ),
    ).toEqual([
      "Contexto cita src/nuevo.ts, que no existe en el repo: las citas son del código de hoy",
      "Contexto cita src/a.ts:3-4, pero el archivo tiene 3 líneas",
    ]);
  });

  // Si regresiona, una feature sin Contexto deja al planificador explorando de cero aunque nombre los
  // archivos, o le pasa a graft rutas que no existen.
  test("archivosNombrados toma las rutas de la descripción, los criterios y las aclaraciones que existen", () => {
    const existen = new Set(["src/export/csv.ts", "src/api/", "tests/x.test.ts"]);
    expect(
      archivosNombrados(
        {
          descripcion:
            "Cambia `src/export/csv.ts` y lo que usa src/api/. Ver el README y src/no/existe.ts.",
          criterios: [
            { id: "AC-1", text: "el test tests/x.test.ts:12 pasa" },
            { id: "AC-2", text: "src/export/csv.ts exporta (./src/api/) igual" },
          ],
          aclaraciones: [{ question: "¿Y src/export/csv.ts?", answer: "Sí, src/api/." }],
        },
        (ruta) => existen.has(ruta),
      ),
    ).toEqual(["src/export/csv.ts", "src/api/", "tests/x.test.ts"]);
  });

  // Revisión: si regresiona, una ruta con .. que existe fuera del repo llega a graft y al prompt.
  test("archivosNombrados no toma una ruta que sale del repo, aunque exista", () => {
    expect(
      archivosNombrados(
        { descripcion: "Mirá ../fuera/x.ts y src/../../y.ts", criterios: [], aclaraciones: [] },
        () => true,
      ),
    ).toEqual([]);
  });
});
