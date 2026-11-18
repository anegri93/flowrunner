import { describe, expect, test } from "vitest";
import type { Halt } from "../engine/engine.ts";
import {
  checkExplicacion,
  explicacionMarkdown,
  HERRAMIENTAS_EXPLICAR,
  numberedOptions,
  politicaExplicar,
  type Explicacion,
} from "./explain.ts";

const halt: Halt = {
  motivo: "revisar: la revisión encontró bloqueantes:\n- falta pipefail",
  siguiente: "flowrunner fix R1 --unidad ST-1 'Agregá set -o pipefail'",
  unidades: ["ST-1"],
  opciones: [
    {
      comando: "flowrunner fix R1 --unidad ST-1 'Agregá `set -o pipefail`'",
      que: "que ST-1 lo corrija así: Agregá `set -o pipefail`",
      arreglo: { unidad: "ST-1", instruccion: "Agregá `set -o pipefail`" },
    },
    { comando: 'flowrunner accept R1 "<por qué>"', que: "seguir a probar igual" },
    { comando: "flowrunner abort R1", que: "cortar el run; la rama queda" },
  ],
};

const explicacion: Explicacion = {
  resumen: "La revisión frenó porque el script no corta en un error de un pipe.",
  que_paso: "ST-1 escribió `scripts/export.sh` sin `pipefail`.",
  por_que_frena: "Es un bloqueante del repo: no se entrega sin él.",
  opciones: [
    { numero: 1, que_hace: "ST-1 agrega la línea y vuelve a verificar.", riesgos: "" },
    { numero: 2, que_hace: "Entrega con el bloqueante.", riesgos: "El export puede perder filas." },
  ],
  recomendada: 1,
  por_que_recomienda: "Es una línea y la revisión ya dijo cuál.",
};

describe("explicar una detención", () => {
  // Si regresiona, la sesión que explica puede escribir en la copia de la feature o correr comandos:
  // explicar tiene que ser de solo lectura (ADR 0037).
  test("la sesión solo lee: Read, Grep y Glob, sin escribir, sin Bash ni subagentes", () => {
    expect([...HERRAMIENTAS_EXPLICAR]).toEqual(["Read", "Grep", "Glob"]);
    const politica = politicaExplicar("/r", "verificar");
    expect(politica).toMatchObject({ write: false, bash: false, agents: false });
    expect(politica.scope).toMatchObject({ root: "/r", writable: [], writeGlobs: [] });
  });

  // Si regresiona, un motivo con ``` corta su bloque y lo que sigue se lee como Markdown.
  test("un motivo o un comando con backticks no corta su bloque", () => {
    const md = explicacionMarkdown({
      clave: "SHOP-1",
      fase: "revisar",
      halt: { ...halt, motivo: "revisar:\n```js\nconsole.log(1)\n```" },
      explicacion,
      modelo: "m",
      at: new Date("2026-11-17T10:00:00.000Z"),
    });
    expect(md).toContain("````text\nrevisar:\n```js\nconsole.log(1)\n```\n````");
  });

  // Si regresiona, un comando con backticks, como el de un arreglo escrito, le llega al modelo cortado
  // en dos códigos: lee otra respuesta que la que el run ofrece.
  test("las respuestas van numeradas con su comando entero, en un código que no se corta", () => {
    expect(numberedOptions(halt).split("\n")).toEqual([
      "1. ``flowrunner fix R1 --unidad ST-1 'Agregá `set -o pipefail`'``: que ST-1 lo corrija así: Agregá `set -o pipefail`",
      '2. `flowrunner accept R1 "<por qué>"`: seguir a probar igual',
      "3. `flowrunner abort R1`: cortar el run; la rama queda",
    ]);
  });

  // Si regresiona, la explicación le propone a la persona una respuesta que el run no acepta.
  test("rechaza una respuesta o una recomendación que el run no ofrece, y una repetida", () => {
    expect(checkExplicacion(explicacion, halt)).toBeUndefined();
    expect(
      checkExplicacion(
        { ...explicacion, opciones: [{ numero: 4, que_hace: "x", riesgos: "" }] },
        halt,
      ),
    ).toMatch(/nombró la respuesta 4 y el run ofrece 3/);
    expect(checkExplicacion({ ...explicacion, recomendada: 7 }, halt)).toMatch(
      /recomendó la respuesta 7/,
    );
    expect(
      checkExplicacion(
        {
          ...explicacion,
          opciones: [
            { numero: 1, que_hace: "a", riesgos: "" },
            { numero: 1, que_hace: "b", riesgos: "" },
          ],
        },
        halt,
      ),
    ).toMatch(/repitió/);
  });

  // Si regresiona, una respuesta que el modelo no explicó desaparece de lo que lee la persona.
  test("el Markdown trae cada respuesta en orden, con su comando, la recomendada y el motivo tal cual", () => {
    const md = explicacionMarkdown({
      clave: "SHOP-1",
      fase: "revisar",
      halt,
      explicacion,
      modelo: "claude-sonnet-5-5",
      at: new Date("2026-11-17T10:00:00.000Z"),
    });
    expect(md).toContain("# SHOP-1 · Por qué se detuvo en Revisar");
    expect(md).toContain("> La revisión frenó porque el script no corta en un error de un pipe.");
    const one = md.indexOf(
      "### 1. que ST-1 lo corrija así: Agregá `set -o pipefail` · recomendada",
    );
    const two = md.indexOf("### 2. seguir a probar igual\n");
    const three = md.indexOf("### 3. cortar el run; la rama queda\n");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(md).toContain("```sh\nflowrunner fix R1 --unidad ST-1 'Agregá `set -o pipefail`'\n```");
    expect(md).toContain("**Riesgos:** El export puede perder filas.");
    // La 3 no la explicó: queda con lo que dice flowrunner de ella.
    expect(md.slice(three)).toContain(
      "```sh\nflowrunner abort R1\n```\n\ncortar el run; la rama queda",
    );
    expect(md).toContain("**1.** Es una línea y la revisión ya dijo cuál.");
    expect(md).toContain(
      "```text\nrevisar: la revisión encontró bloqueantes:\n- falta pipefail\n```",
    );
  });
});
