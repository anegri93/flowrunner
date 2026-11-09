import { describe, expect, test } from "vitest";
import { repoWith } from "../../test/helpers/git.ts";
import type { FileChange } from "../git/git.ts";
import { testsInScope, testsTouched, undeclared } from "./existente.ts";
import type { Subtask } from "./plan.ts";

const change = (path: string, status: FileChange["status"]): FileChange => ({
  path,
  status,
  added: [],
});
const st = (alcance: string[]): Subtask => ({
  id: "ST-1",
  titulo: "t",
  descripcion: "d",
  alcance,
  dependencias: [],
  depende_de: [],
});

describe("lo existente que cambia", () => {
  // Si regresiona, reescribir el test que fija una regla vigente pasa sin aviso, como en CUENTAS-1.
  test("testsTouched: un test modificado o borrado cuenta; uno nuevo o un archivo que no es test, no", () => {
    expect(
      testsTouched(
        [
          change("tests/viejo.test.ts", "modificado"),
          change("tests/borrado.test.ts", "borrado"),
          change("tests/nuevo.test.ts", "agregado"),
          change("src/a.ts", "modificado"),
        ],
        ["tests/**"],
      ),
    ).toEqual(["tests/viejo.test.ts", "tests/borrado.test.ts"]);
  });

  // Si regresiona, el plan le da permiso a una sub-task de reescribir un test existente sin decirlo.
  test("testsInScope: un test existente nombrado en el alcance cuenta; una carpeta o un test que no existe, no", () => {
    const repo = repoWith({ "tests/viejo.test.ts": "x\n", "src/a.ts": "y\n" });
    expect(
      testsInScope(
        [st(["./tests/viejo.test.ts", "tests/", "tests/nuevo.test.ts", "src/a.ts"])],
        repo,
        ["tests/**"],
      ),
    ).toEqual(["tests/viejo.test.ts"]);
  });

  test("undeclared: una ruta nombrada en el `donde` de algún cambio está declarada", () => {
    const declared = [{ que: "q", donde: "tests/viejo.test.ts:12", criterio: "AC-1" }];
    expect(
      undeclared(["tests/viejo.test.ts", "tests/otro.test.ts", "tests/otro.test.ts"], declared),
    ).toEqual(["tests/otro.test.ts"]);
  });
});
