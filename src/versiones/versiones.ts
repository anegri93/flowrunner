// Las versiones de las dependencias nuevas de un plan: flowrunner las elige del registro antes de que
// la persona apruebe, y quedan en el plan como `paquete@x.y.z` (ADR 0029). En PIZ-3 el plan sumó
// `unpdf` sin versión, `npm install -E unpdf` instaló la última, que pide Node >=24 en un repo que
// declara >=20.6, y la revisión lo frenó siete veces sin que la sub-task pudiera cambiar la versión.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { z } from "zod";
import type { Subtask } from "../gates/plan.ts";
import { nodeSpec } from "../proc/node.ts";

/** Una versión publicada, con lo que hace falta para elegirla. */
export interface Publicada {
  readonly version: string;
  /** El `engines.node` de esa versión, si declara uno. */
  readonly node?: string;
  readonly deprecada: boolean;
}

export type Consulta =
  | {
      readonly tipo: "ok";
      readonly versiones: readonly Publicada[];
      /** El dist-tag `latest`: una versión más nueva que esa no es la que el paquete da por estable. */
      readonly latest?: string;
    }
  | { readonly tipo: "no_existe" };

/**
 * Lo que sabe el registro de un paquete, consultado desde `cwd` (así vale el `.npmrc` del repo).
 * Rechaza si el registro no responde: es una falla de red, no una respuesta.
 */
export type Registro = (paquete: string, cwd: string) => Promise<Consulta>;

/** El Node más viejo que el repo dice soportar, y de dónde salió. */
export interface NodeDelRepo {
  readonly version: string;
  readonly de: string;
}

export const ENGINES_DE_PACKAGE = "engines.node de package.json";

/**
 * El mínimo que admite el `engines.node` del repo (`>=20.6` → 20.6.0); si no declara uno, el de
 * `.nvmrc` o `.node-version` (`22` → 22.0.0). Undefined si no dice nada, o nada que se pueda leer:
 * entonces no se filtra por engines. Un rango que admite cualquier versión, como `*`, tampoco dice.
 */
export function nodeMinimo(repo: string): NodeDelRepo | undefined {
  const engines = enginesDe(repo);
  if (engines !== undefined && semver.validRange(engines) !== null) {
    const min = semver.minVersion(engines);
    if (min !== null && min.version !== "0.0.0")
      return { version: min.version, de: ENGINES_DE_PACKAGE };
  }
  const spec = nodeSpec(repo);
  const version = spec === undefined ? null : semver.coerce(spec.version);
  return spec === undefined || version === null
    ? undefined
    : { version: version.version, de: spec.file };
}

function enginesDe(repo: string): string | undefined {
  const file = join(repo, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { engines?: { node?: unknown } };
    return typeof pkg.engines?.node === "string" ? pkg.engines.node : undefined;
  } catch {
    return undefined;
  }
}

/** `unpdf` no trae versión; `unpdf@1.4.0`, `unpdf@^1` y `@scope/x@2` sí. */
export const conVersion = (dep: string) => dep.lastIndexOf("@") > 0;

/** Si una versión cumple el Node del repo. Un `engines.node` que no es un rango válido no dice nada. */
function andaCon(publicada: Publicada, node: NodeDelRepo | undefined): boolean {
  if (node === undefined || publicada.node === undefined) return true;
  if (semver.validRange(publicada.node) === null) return true;
  return semver.satisfies(node.version, publicada.node);
}

export type Eleccion =
  | { readonly tipo: "ok"; readonly version: string }
  | { readonly tipo: "ninguna"; readonly motivo: string };

/**
 * La versión estable más nueva que anda con el Node del repo. Estable: sin prerelease, sin deprecar y
 * no más nueva que `latest`. Si ninguna anda, el motivo dice qué hacer, para que lo lea la persona.
 */
export function elegirVersion(
  paquete: string,
  consulta: Consulta,
  node: NodeDelRepo | undefined,
): Eleccion {
  if (consulta.tipo === "no_existe")
    return {
      tipo: "ninguna",
      motivo: `${paquete} no está en el registro de npm: revisá el nombre o elegí otra librería`,
    };
  const tope =
    consulta.latest !== undefined &&
    semver.valid(consulta.latest) !== null &&
    semver.prerelease(consulta.latest) === null
      ? consulta.latest
      : undefined;
  const estables = consulta.versiones
    .filter(
      (p) =>
        semver.valid(p.version) !== null &&
        semver.prerelease(p.version) === null &&
        !p.deprecada &&
        (tope === undefined || semver.lte(p.version, tope)),
    )
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const elegida = estables.find((p) => andaCon(p, node));
  if (elegida !== undefined) return { tipo: "ok", version: elegida.version };
  const nueva = estables[0];
  if (nueva === undefined || node === undefined)
    return {
      tipo: "ninguna",
      motivo: `${paquete} no tiene versiones estables sin deprecar: elegí otra librería o pedí una versión explícita`,
    };
  const pide = nueva.node ?? "";
  const subi =
    node.de === ENGINES_DE_PACKAGE
      ? `subí \`engines.node\` a \`${pide}\``
      : `subí el Node de \`${node.de}\` a uno que cumpla \`${pide}\``;
  return {
    tipo: "ninguna",
    motivo: `Ninguna versión estable de ${paquete} anda con Node ${node.version} (${node.de}); la más nueva, ${nueva.version}, pide ${pide}: ${subi} o elegí otra librería`,
  };
}

export const versionesSchema = z.strictObject({
  /** El Node con que se eligió; null si el repo no dice cuál usa. */
  node: z.strictObject({ version: z.string(), de: z.string() }).nullable(),
  /** Las que eligió flowrunner, ya escritas en las sub-tasks como `paquete@x.y.z`. */
  fijadas: z.array(z.strictObject({ paquete: z.string(), version: z.string() })),
  /** Las que no tienen una versión que sirva: con algo acá, `approve` no sigue. */
  sin_version: z.array(z.strictObject({ paquete: z.string(), motivo: z.string() })),
});
export type Versiones = z.infer<typeof versionesSchema>;

/**
 * Las sub-tasks con cada dependencia sin versión fijada en la que eligió el registro. Una que el plan
 * trae con versión o rango queda como está, y una sub-task conservada de un replan no se toca: su
 * código ya está escrito con lo que instaló. Una sin versión que sirva queda sin versión, en
 * `sin_version`. Rechaza si el registro no responde.
 */
export async function fijarVersiones(
  subtareas: readonly Subtask[],
  repo: string,
  registro: Registro,
): Promise<{ readonly subtareas: Subtask[]; readonly versiones: Versiones }> {
  const node = nodeMinimo(repo);
  const pendientes = subtareas.filter((t) => t.conserva !== true);
  const nombres = [
    ...new Set(pendientes.flatMap((t) => [...t.dependencias, ...(t.dependencias_dev ?? [])])),
  ].filter((d) => !conVersion(d));
  const elecciones = new Map(
    await Promise.all(
      nombres.map(async (p) => [p, elegirVersion(p, await registro(p, repo), node)] as const),
    ),
  );
  const fijar = (dep: string) => {
    const e = elecciones.get(dep);
    return e?.tipo === "ok" ? `${dep}@${e.version}` : dep;
  };
  const versiones: Versiones = {
    node: node ?? null,
    fijadas: [...elecciones].flatMap(([paquete, e]) =>
      e.tipo === "ok" ? [{ paquete, version: e.version }] : [],
    ),
    sin_version: [...elecciones].flatMap(([paquete, e]) =>
      e.tipo === "ninguna" ? [{ paquete, motivo: e.motivo }] : [],
    ),
  };
  return {
    subtareas: subtareas.map((t) =>
      t.conserva === true
        ? t
        : {
            ...t,
            dependencias: t.dependencias.map(fijar),
            ...(t.dependencias_dev === undefined
              ? {}
              : { dependencias_dev: t.dependencias_dev.map(fijar) }),
          },
    ),
    versiones,
  };
}
