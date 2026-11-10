import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Subtask } from "../gates/plan.ts";
import { fijarVersiones, type Consulta, type Publicada, type Registro } from "./versiones.ts";

/** Un repo con estos archivos en la raíz. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-versiones-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const conEngines = (node: string) =>
  repo({ "package.json": JSON.stringify({ engines: { node } }) });

const v = (version: string, node?: string, deprecada = false): Publicada => ({
  version,
  ...(node === undefined ? {} : { node }),
  deprecada,
});

/** Un registro falso y determinista, que anota qué le preguntaron. */
function registro(paquetes: Record<string, Consulta>) {
  const preguntas: string[] = [];
  const fn: Registro = (paquete) => {
    preguntas.push(paquete);
    const consulta = paquetes[paquete];
    return consulta === undefined
      ? Promise.reject(new Error(`el test no esperaba ${paquete}`))
      : Promise.resolve(consulta);
  };
  return { fn, preguntas };
}

const st = (dependencias: string[], extra: Partial<Subtask> = {}): Subtask => ({
  id: "ST-1",
  titulo: "t",
  descripcion: "d",
  alcance: ["src/"],
  dependencias,
  depende_de: [],
  ...extra,
});

// Como unpdf en PIZ-3: la 2.x pide Node 24, la 1.9 anda con 22, y la 1.6 con 20.
const UNPDF: Consulta = {
  tipo: "ok",
  versiones: [v("1.6.2", ">=20"), v("1.9.1", ">=22"), v("2.0.1", ">=24"), v("2.1.0", ">=24")],
  latest: "2.1.0",
};

describe("fijarVersiones", () => {
  // Si regresiona, se instala la última aunque no ande con el Node del repo, y la revisión la frena
  // una y otra vez sin que la sub-task pueda cambiarla (PIZ-3).
  test("elige la estable más nueva que anda con el Node del repo, saltando las más nuevas que no", async () => {
    const r = registro({ unpdf: UNPDF });
    const out = await fijarVersiones([st(["unpdf"])], conEngines(">=20.6"), r.fn);
    expect(out.subtareas[0]?.dependencias).toEqual(["unpdf@1.6.2"]);
    expect(out.versiones).toEqual({
      node: { version: "20.6.0", de: "engines.node de package.json" },
      fijadas: [{ paquete: "unpdf", version: "1.6.2" }],
      sin_version: [],
    });
  });

  // Si regresiona, un plan puede fijar una beta o una versión que el autor ya deprecó.
  test("saltea prereleases, deprecadas y las más nuevas que latest", async () => {
    const r = registro({
      fflate: {
        tipo: "ok",
        versiones: [
          v("0.8.1"),
          v("0.8.2"),
          v("0.8.3-beta.1"),
          v("0.9.0", undefined, true),
          v("1.0.0-rc.1"),
          v("1.0.0-beta.2"),
          // Publicada con el tag `next`, sin sufijo de prerelease.
          v("1.0.0"),
        ],
        latest: "0.9.0",
      },
    });
    const out = await fijarVersiones(
      [st([], { dependencias_dev: ["fflate"] })],
      conEngines(">=20"),
      r.fn,
    );
    expect(out.subtareas[0]?.dependencias_dev).toEqual(["fflate@0.8.2"]);
  });

  // Si regresiona, flowrunner pisa la versión que pidió la persona o el planificador.
  test("respeta una versión o un rango que ya trae el plan, sin preguntarle al registro", async () => {
    const r = registro({ unpdf: UNPDF });
    const out = await fijarVersiones(
      [st(["unpdf@2.1.0", "@scope/qr@^1", "unpdf"])],
      conEngines(">=20.6"),
      r.fn,
    );
    expect(out.subtareas[0]?.dependencias).toEqual(["unpdf@2.1.0", "@scope/qr@^1", "unpdf@1.6.2"]);
    expect(r.preguntas).toEqual(["unpdf"]);
  });

  // Si regresiona, el plan llega a la persona con una dependencia que no anda y nadie lo dice, o
  // con una versión instalada a ciegas.
  test("si ninguna estable anda, la deja sin versión y dice qué hacer", async () => {
    const r = registro({ unpdf: UNPDF });
    const out = await fijarVersiones([st(["unpdf"])], conEngines(">=18"), r.fn);
    expect(out.subtareas[0]?.dependencias).toEqual(["unpdf"]);
    expect(out.versiones.fijadas).toEqual([]);
    expect(out.versiones.sin_version).toEqual([
      {
        paquete: "unpdf",
        motivo:
          "Ninguna versión estable de unpdf anda con Node 18.0.0 (engines.node de package.json); la más nueva, 2.1.0, pide >=24: subí `engines.node` a `>=24` o elegí otra librería",
      },
    ]);
  });

  test("un paquete que no está en el registro también queda sin versión, con el motivo", async () => {
    const r = registro({ "no-existe": { tipo: "no_existe" } });
    const out = await fijarVersiones([st(["no-existe"])], conEngines(">=20"), r.fn);
    expect(out.versiones.sin_version).toEqual([
      {
        paquete: "no-existe",
        motivo: "no-existe no está en el registro de npm: revisá el nombre o elegí otra librería",
      },
    ]);
  });

  // Si regresiona, un repo sin engines no puede sumar ninguna dependencia que declare uno.
  test("sin engines en el repo usa .nvmrc, y sin nada no filtra por engines", async () => {
    const r = registro({ unpdf: UNPDF });
    const nvmrc = await fijarVersiones(
      [st(["unpdf"])],
      repo({ "package.json": "{}", ".nvmrc": "v22\n" }),
      r.fn,
    );
    expect(nvmrc.subtareas[0]?.dependencias).toEqual(["unpdf@1.9.1"]);
    expect(nvmrc.versiones.node).toEqual({ version: "22.0.0", de: ".nvmrc" });
    const nada = await fijarVersiones([st(["unpdf"])], repo({ "package.json": "{}" }), r.fn);
    expect(nada.subtareas[0]?.dependencias).toEqual(["unpdf@2.1.0"]);
    expect(nada.versiones.node).toBeNull();
  });

  // Si regresiona, un registro caído cuelga el run o deja el plan con versiones a medio elegir.
  test("si el registro no responde, rechaza con su motivo", async () => {
    const caido: Registro = () =>
      Promise.reject(new Error("el registro de npm no respondió en 30 s (ETIMEDOUT)"));
    await expect(fijarVersiones([st(["unpdf"])], conEngines(">=20"), caido)).rejects.toThrow(
      /ETIMEDOUT/,
    );
  });

  // Si regresiona, un replan reinstala o cambia la versión del código que ya se conservó.
  test("una sub-task conservada no se toca", async () => {
    const r = registro({});
    const kept = st(["unpdf"], { conserva: true });
    const out = await fijarVersiones([kept], conEngines(">=20"), r.fn);
    expect(out.subtareas).toEqual([kept]);
    expect(r.preguntas).toEqual([]);
  });
});
