// Las citas de código de una feature contra el repo, y las rutas que nombra cuando no trae citas.
// Funciones puras: el repo llega como funciones, para testear sin disco ni graft (PR 12).
import type { Cita, Feature } from "./feature.ts";

/** Las líneas de un texto, como las cuenta un editor: un salto final no abre otra. */
function lineasDe(texto: string): number {
  if (texto === "") return 0;
  return texto.split("\n").length - (texto.endsWith("\n") ? 1 : 0);
}

/** Problemas de las citas contra el repo: archivo inexistente o línea fuera del archivo. */
export function checkCitas(
  citas: readonly Cita[],
  leer: (ruta: string) => string | undefined, // undefined si no existe o es carpeta
): string[] {
  const problemas: string[] = [];
  for (const { ruta, desde, hasta } of citas) {
    const texto = leer(ruta);
    if (texto === undefined) {
      problemas.push(
        `Contexto cita ${ruta}, que no existe en el repo: las citas son del código de hoy`,
      );
      continue;
    }
    const n = lineasDe(texto);
    const ultima = hasta ?? desde;
    if (desde !== undefined && ultima !== undefined && ultima > n)
      problemas.push(`Contexto cita ${ruta}:${desde}-${ultima}, pero el archivo tiene ${n} líneas`);
  }
  return problemas;
}

/**
 * Una ruta con al menos una barra: un archivo con extensión o una carpeta que termina en `/`. Antes,
 * el principio o un separador; después, el final, un separador o la puntuación que cierra la frase.
 */
const RUTA =
  /(?:^|[\s`'"(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6}|(?:[\w@.-]+\/)+)(?=$|[\s`'"),.:;])/gm;

/**
 * Las rutas que nombra el texto de la feature (descripción, criterios, aclaraciones), en orden de
 * aparición, sin repetir. Solo las que `existe` acepta. Hasta `max` (20).
 */
export function archivosNombrados(
  feature: Pick<Feature, "descripcion" | "criterios" | "aclaraciones">,
  existe: (ruta: string) => boolean,
  max = 20,
): string[] {
  const textos = [
    feature.descripcion,
    ...feature.criterios.map((c) => c.text),
    ...feature.aclaraciones.flatMap((a) => [a.question, a.answer]),
  ];
  const out: string[] = [];
  for (const texto of textos) {
    for (const m of texto.matchAll(RUTA)) {
      const ruta = (m[1] ?? "").replace(/^\.\//, "");
      // Como en las citas: nada fuera del repo, aunque `existe` lo encuentre.
      if (ruta === "" || ruta.split("/").includes("..") || out.includes(ruta)) continue;
      if (!existe(ruta)) continue;
      out.push(ruta);
      if (out.length >= max) return out;
    }
  }
  return out;
}
