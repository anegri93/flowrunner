import { expect, test } from "vitest";
import { parseFeature } from "../feature/feature.ts";
import {
  protectedMentions,
  scriptsDe,
  scriptsInexistentes,
  soloDocumentacion,
} from "./feature-check.ts";

const feature = (criterios: string) =>
  parseFeature(
    "f.md",
    `---
clave: VF-6
proyecto: acme
titulo: t
---
## Descripción
d

## Criterios
${criterios}
`,
  );

// Regresión de VF-6: «CLAUDE.md documenta los comandos» era un criterio que ningún agente podía cumplir.
test("avisa los criterios que nombran archivos que ningún agente escribe, y no los que no", () => {
  expect(
    protectedMentions(
      feature(
        "- AC-1: CLAUDE.md documenta `npm run mac`.\n- AC-2: el config va en .claude/settings.json.\n- AC-3: docs/guia.md explica el flujo.",
      ),
    ),
  ).toEqual([
    "AC-1 nombra CLAUDE.md, que ningún agente del run puede escribir. Si el criterio pide cambiarlo, sacalo de la feature y hacelo a mano",
    "AC-2 nombra .claude/, que ningún agente del run puede escribir. Si el criterio pide cambiarlo, sacalo de la feature y hacelo a mano",
  ]);
  expect(
    protectedMentions(feature("- AC-1: MY_CLAUDE.md no es CLAUDE.md por sí sola.")),
  ).toHaveLength(1);
});

const sinScript = (id: string, comando: string, s: string) =>
  `${id} usa \`${comando}\`, y el package.json del repo no tiene el script "${s}". Si la feature lo crea, el plan tiene que poner package.json en el alcance de una sub-task; si no, el criterio no se puede cumplir`;

// Regresión de VF-6: «`npm run mac` levanta el trabajador» usaba un script que no existía, y la
// sub-task que lo tenía que crear no podía tocar package.json. Se vio recién en verificar.
test("avisa un npm run, pnpm o yarn de un script que no está en package.json", () => {
  const f = feature(
    [
      "- AC-1: `npm run mac` levanta el trabajador.",
      "- AC-2: `pnpm typecheck` pasa.",
      "- AC-3: `pnpm install` deja node_modules.",
      "- AC-4: `npm test` pasa.",
      "- AC-5: `yarn build` compila.",
    ].join("\n"),
  );
  expect(scriptsInexistentes(f, { test: "vitest", typecheck: "tsc" })).toEqual([
    sinScript("AC-1", "npm run mac", "mac"),
    sinScript("AC-5", "yarn build", "build"),
  ]);
});

test("sin package.json no hay aviso de scripts", () => {
  expect(
    scriptsInexistentes(feature("- AC-1: `npm run mac` levanta el trabajador."), undefined),
  ).toEqual([]);
  expect(scriptsDe("{roto")).toBeUndefined();
});

const soloDoc = (id: string, que: string) =>
  `${id} se comprueba en documentación (${que}): un test de eso solo busca texto y no prueba que lo documentado funcione. Si documenta un comando, un script o un endpoint, sumá un criterio que lo ejecute`;

// Regresión de VF-6: el test del criterio de documentación solo buscaba «npm run mac» en el doc, sin
// comprobar que el script existiera.
test("avisa un criterio que se comprueba solo en documentación, salvo los archivos protegidos", () => {
  const f = feature(
    [
      "- AC-1: docs/despliegue.md explica npm run mac.",
      "- AC-2: el README nombra el comando.",
      "- AC-3: CLAUDE.md lista los comandos.",
      "- AC-4: GET /pedidos devuelve 200.",
    ].join("\n"),
  );
  expect(soloDocumentacion(f)).toEqual([
    soloDoc("AC-1", "docs/despliegue.md"),
    soloDoc("AC-2", "README"),
  ]);
  expect(protectedMentions(f)).toEqual([expect.stringMatching(/^AC-3 nombra CLAUDE\.md/)]);
});
