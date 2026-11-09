import { describe, expect, test } from "vitest";
import { repoWith } from "../../test/helpers/git.ts";
import { callersOf, callersOutOfScope } from "./llamadores.ts";
import type { Subtask } from "./plan.ts";

// El caso de CUENTAS-1: el servicio, dos llamadores por inyección y un seed que lo llama a través de
// una variable sin tipo declarado, que graft no ve.
const repo = repoWith({
  "apps/api/src/usuarios/usuarios.service.ts":
    "export class UsuariosService {\n  async asegurarAcceso(correo: string) {\n    return correo;\n  }\n}\n",
  "apps/api/src/colaboradores/colaboradores.controller.ts":
    'import { UsuariosService } from "../usuarios/usuarios.service";\nclass C {\n  constructor(private readonly usuarios: UsuariosService) {}\n  crear() {\n    return this.usuarios.asegurarAcceso(x);\n  }\n}\n',
  "apps/api/src/seeds/seed-accesos.ts":
    "const usuarios = app.get(UsuariosService);\nconst usuario = await usuarios.asegurarAcceso(\n  correo,\n);\n",
  // Un método homónimo de otra clase, y un comentario que solo lo nombra: no son llamadores.
  "apps/api/src/otros/otro.ts": "await this.cuentas.asegurarAcceso(y);\n",
  "apps/api/src/comun/correo.ts": "/** `asegurarAcceso` la usa. */\nexport const x = 1;\n",
});
const env = process.env;

const task = (id: string, alcance: string[]): Subtask => ({
  id,
  titulo: id,
  descripcion: id,
  alcance,
  dependencias: [],
  depende_de: [],
});

const change = {
  que: "asegurarAcceso devuelve null para otro dominio",
  donde: "apps/api/src/usuarios/usuarios.service.ts:2",
  criterio: "AC-1",
  simbolo: "UsuariosService.asegurarAcceso",
};

describe("llamadores de lo que el plan cambia", () => {
  // Si regresiona, el gate no ve la llamada que pasa por una variable sin tipo, como en los seeds.
  test("encuentra cada llamada, también la que pasa por una variable sin tipo, y no los comentarios", async () => {
    expect((await callersOf("UsuariosService.asegurarAcceso", repo, env)).sort()).toEqual([
      "apps/api/src/colaboradores/colaboradores.controller.ts",
      "apps/api/src/seeds/seed-accesos.ts",
      "apps/api/src/usuarios/usuarios.service.ts",
    ]);
    // Sin la clase, un método homónimo también cuenta: el nombre solo no alcanza para distinguirlos.
    expect(await callersOf("asegurarAcceso", repo, env)).toContain("apps/api/src/otros/otro.ts");
  });

  // Regresión: en CUENTAS-1 el plan cambió lo que devuelve asegurarAcceso y dos seeds que lo llamaban
  // no estaban en el alcance de ninguna sub-task. Verificar los iba a encontrar rotos sin dueño.
  test("un llamador fuera de todo alcance frena el plan y el motivo lo nombra", async () => {
    const plan = {
      subtareas: [
        task("ST-1", [
          "apps/api/src/usuarios/",
          "apps/api/src/colaboradores/colaboradores.controller.ts",
        ]),
      ],
      tests: [],
      cambia_lo_existente: [change],
    };
    expect(await callersOutOfScope(plan, repo, env)).toEqual([
      "UsuariosService.asegurarAcceso cambia (apps/api/src/usuarios/usuarios.service.ts:2) y lo llaman archivos que ninguna sub-task tiene en su alcance: apps/api/src/seeds/seed-accesos.ts. Sumalos al alcance de la sub-task que hace el cambio o de una que dependa de ella",
    ]);
    const withSeeds = {
      ...plan,
      subtareas: [...plan.subtareas, task("ST-2", ["apps/api/src/seeds"])],
    };
    expect(await callersOutOfScope(withSeeds, repo, env)).toEqual([]);
  });

  test("un cambio sin símbolo no busca llamadores", async () => {
    const plan = {
      subtareas: [task("ST-1", ["apps/api/src/usuarios/"])],
      tests: [],
      cambia_lo_existente: [{ ...change, simbolo: undefined }],
    };
    expect(await callersOutOfScope(plan, repo, env)).toEqual([]);
  });
});
