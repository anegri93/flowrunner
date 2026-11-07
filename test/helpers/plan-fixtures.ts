// Una feature, un plan válido y el test que escribe, para los tests con el SDK simulado.
import type { Plan } from "../../src/gates/plan.ts";

export const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Exportar pedidos.

## Criterios
- AC-1: existe src/export/csv.js.
`;

export const PLAN: Plan = {
  plan: "# Plan\nUn serializador en src/export/.",
  subtareas: [
    {
      id: "ST-1",
      titulo: "Serializador CSV",
      descripcion: "csv",
      alcance: ["src/export/"],
      dependencias: [],
      depende_de: [],
    },
  ],
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [{ que: "node:fs", por_que: "sin dependencias" }],
};

export const WRITE_TEST = {
  tool: "Write",
  input: {
    file_path: "tests/ac1.mjs",
    content:
      'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/export/csv.js") ? 0 : 1);\n',
  },
};
