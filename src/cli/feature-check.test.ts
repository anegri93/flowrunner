import { expect, test } from "vitest";
import { parseFeature } from "../feature/feature.ts";
import { protectedMentions } from "./feature-check.ts";

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
