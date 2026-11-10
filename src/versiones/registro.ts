// El registro de verdad: `npm view`, que lee el registro y el `.npmrc` del repo. Sirve igual para un
// repo de pnpm o de yarn, que instalan del mismo registro.
import { z } from "zod";
import { runProc } from "../proc/proc.ts";
import type { Publicada, Registro } from "./versiones.ts";

/** Lo que espera flowrunner al registro por paquete: un registro colgado no cuelga el run. */
export const REGISTRO_TIMEOUT_MS = 30_000;

// `engines` y `deprecated` se leen sin exigir forma: paquetes viejos publicaron `engines` como lista.
const entrada = z.object({
  version: z.string(),
  engines: z.unknown().optional(),
  deprecated: z.unknown().optional(),
  "dist-tags": z.record(z.string(), z.string()).optional(),
});

/** El `engines.node` de una entrada, si es un texto. */
function nodeDe(engines: unknown): string | undefined {
  if (typeof engines !== "object" || engines === null || Array.isArray(engines)) return undefined;
  const node = (engines as { node?: unknown }).node;
  return typeof node === "string" ? node : undefined;
}
const salida = z.union([entrada, z.array(entrada)]);
const error = z.object({
  error: z.object({ code: z.string().optional(), summary: z.string().optional() }),
});

/**
 * `npm view <paquete>@>=0.0.0`: una entrada por versión estable con su `engines`, si está deprecada y
 * los dist-tags (con una sola versión, npm devuelve un objeto en vez de una lista). El rango deja
 * afuera las prereleases; sin ninguna estable, npm responde E404 «No match found». Sin reintentos de
 * npm: el engine reintenta la fase, y espera más que npm ante un corte de red.
 */
export function npmRegistro(env: NodeJS.ProcessEnv, timeoutMs = REGISTRO_TIMEOUT_MS): Registro {
  return async (paquete, cwd) => {
    const result = await runProc(
      "npm",
      [
        "view",
        `${paquete}@>=0.0.0`,
        "version",
        "engines",
        "deprecated",
        "dist-tags",
        "--json",
        "--fetch-retries=0",
      ],
      { cwd, env, timeoutMs },
    );
    if (result.timedOut)
      throw new Error(
        `el registro de npm no respondió en ${String(timeoutMs / 1000)} s al buscar las versiones de ${paquete} (ETIMEDOUT)`,
      );
    let json: unknown;
    try {
      json = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
    } catch {
      json = undefined;
    }
    if (result.code !== 0) {
      const e = error.safeParse(json);
      const code = e.success ? e.data.error.code : undefined;
      const summary = e.success ? e.data.error.summary : undefined;
      if (code === "E404")
        return summary?.includes("No match found") === true
          ? { tipo: "ok", versiones: [] }
          : { tipo: "no_existe" };
      const detalle =
        code === undefined
          ? (result.stderr.trim().split("\n")[0] ?? `exit ${String(result.code)}`)
          : `${code}${summary === undefined ? "" : `: ${summary}`}`;
      throw new Error(
        `no se pudieron buscar las versiones de ${paquete} en el registro de npm (${detalle})`,
      );
    }
    const parsed = salida.safeParse(json);
    if (!parsed.success)
      throw new Error(`el registro de npm devolvió algo que no se entiende para ${paquete}`);
    const entradas = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    const versiones: Publicada[] = entradas.map((e) => {
      const node = nodeDe(e.engines);
      return {
        version: e.version,
        ...(node === undefined ? {} : { node }),
        deprecada: typeof e.deprecated === "string" && e.deprecated !== "",
      };
    });
    const latest = entradas[0]?.["dist-tags"]?.latest;
    return { tipo: "ok", versiones, ...(latest === undefined ? {} : { latest }) };
  };
}
