import { expect, test } from "vitest";
import { repoConfigSchema } from "../config/schemas.ts";
import { parseFeature } from "../feature/feature.ts";
import {
  protectedMentions,
  scriptsDe,
  scriptsInexistentes,
  soloChequeosDelRepo,
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

// Si regresiona, `pnpm tsc --noEmit pasa` avisa «el criterio no se puede cumplir»: pnpm y yarn corren
// el binario de node_modules/.bin cuando no hay un script con ese nombre. npm run, no.
test("un pnpm o yarn de un binario de node_modules/.bin no es un script que falta", () => {
  const f = feature(
    [
      "- AC-1: `pnpm tsc --noEmit` pasa.",
      "- AC-2: `yarn vitest run` pasa.",
      "- AC-3: `npm run tsc` pasa.",
      "- AC-4: `pnpm build` compila.",
    ].join("\n"),
  );
  expect(scriptsInexistentes(f, { test: "vitest" }, new Set(["tsc", "vitest"]))).toEqual([
    sinScript("AC-3", "npm run tsc", "tsc"),
    sinScript("AC-4", "pnpm build", "build"),
  ]);
});

// Si regresiona, «corre npm run test.» avisa que falta el script "test." aunque `test` exista.
test("el punto que cierra la oración no es parte del nombre del script", () => {
  expect(scriptsInexistentes(feature("- AC-1: corre npm run test."), { test: "vitest" })).toEqual(
    [],
  );
});

// Si regresiona, un criterio sobre .claude/ o .flowrunner/ da dos avisos: el de documentación y el de
// protectedMentions, que ya dice lo que importa.
test("un archivo de documentación bajo .claude/ o .flowrunner/ no da el aviso de documentación", () => {
  const f = feature(
    "- AC-1: .claude/commands/deploy.md documenta el deploy.\n- AC-2: .flowrunner/notas.md lista los pasos.",
  );
  expect(soloDocumentacion(f)).toEqual([]);
  expect(protectedMentions(f)).toHaveLength(2);
});

const config = repoConfigSchema.parse({ setup: "true", tests_globs: ["tests/**"] });
const soloChequeos = (id: string) =>
  `${id} solo pide que el repo pase sus chequeos: eso ya lo corre verificar en cada vuelta, y probar no puede correr comandos, así que el criterio sobra y frena el run. Sacalo; si a .flowrunner/verify.sh le falta un chequeo, sumáselo ahí`;

// Regresión de PIZ-3: «AC-9: `npm run check` pasa» era el verify del repo. verificar ya lo corría,
// probar no puede correr comandos, y el criterio quedó sin probar y frenó el run.
test("avisa un criterio que solo pide que pasen los chequeos del repo o su verify", () => {
  const f = feature(
    [
      "- AC-1: `npm run check` pasa (formato, lint, typecheck, tests y build).",
      "- AC-2: `./.flowrunner/verify.sh` en verde.",
      "- AC-3: el build pasa.",
      "- AC-4: los tests que ya existen siguen pasando.",
      "- AC-5: `pnpm verify` queda en verde.",
      "- AC-6: formato, lint y typecheck sin errores.",
    ].join("\n"),
  );
  expect(soloChequeosDelRepo(f, config)).toEqual(
    ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"].map(soloChequeos),
  );
});

// Si regresiona, la feature avisa de más: estos criterios piden un comportamiento, o corren un test
// puntual que el gate pone en rojo y verificar corre por su cuenta.
test("no avisa un criterio que corre un test puntual o pide un comportamiento", () => {
  const f = feature(
    [
      "- AC-1: `npx vitest run servidor/api.test.ts` pasa.",
      "- AC-2: `pnpm test -- tests/pedidos.test.ts` pasa.",
      '- AC-3: `npx vitest run -t "importar un documento"` pasa.',
      "- AC-4: GET /pedidos devuelve 200 y los tests pasan.",
      "- AC-5: el test de importar pasa.",
      "- AC-6: el build genera dist/app.js.",
      "- AC-7: `npm run dev` levanta la app.",
    ].join("\n"),
  );
  expect(soloChequeosDelRepo(f, config)).toEqual([]);
});
