// Explorar antes de planificar (PR 13): con `explorar_antes`, una sesión barata que solo lee recorre el
// repo antes del primer plan del run y le deja al planificador un informe corto. Es una ayuda, no un
// paso obligatorio: si falla, se planifica sin informe.
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadBrain } from "../brain/brain.ts";
import type { RepoConfig } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import { graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import { readOnlyHook } from "./aprender.ts";
import { graftIndex } from "./inputs.ts";
import { brainVars, sessionName } from "./planificar.ts";

export const exploracionSchema = z.object({
  archivos: z.array(
    z.object({
      ruta: z.string().min(1),
      lineas: z.string().describe("rango como 40-58, o vacío si es el archivo entero").default(""),
      que: z.string().min(1).describe("qué hace o qué fija, en una frase"),
    }),
  ),
  funciones: z.array(
    z.object({
      simbolo: z.string().min(1),
      donde: z.string().min(1).describe("archivo:línea"),
      que: z.string().min(1),
      llamadores: z.array(z.string()).describe("archivo:línea de cada llamada que importa"),
    }),
  ),
  tests_existentes: z.array(
    z.object({
      ruta: z.string().min(1),
      que_fija: z.string().min(1),
    }),
  ),
  riesgos: z
    .array(z.string().min(1))
    .describe("lo que el plan no puede romper o tiene que cambiar"),
  dudas: z.array(z.string().min(1)).describe("lo que no se pudo resolver leyendo"),
});
export type Exploracion = z.infer<typeof exploracionSchema>;

/** Una sección por campo, una viñeta por ítem; la vacía dice `(ninguno)`. */
function seccion(titulo: string, items: readonly string[]): string {
  return [`## ${titulo}`, "", ...(items.length === 0 ? ["(ninguno)"] : items)].join("\n");
}

/** El informe en Markdown, para el prompt del planificador y para runs/<id>/exploracion.md. */
export function exploracionMd(e: Exploracion): string {
  return `${[
    seccion(
      "Archivos",
      e.archivos.map((a) => `- ${a.ruta}${a.lineas === "" ? "" : `:${a.lineas}`} — ${a.que}`),
    ),
    seccion(
      "Funciones",
      e.funciones.map(
        (f) =>
          `- \`${f.simbolo}\` (${f.donde}) — ${f.que}. Llamadores: ${f.llamadores.length === 0 ? "(ninguno)" : f.llamadores.join(", ")}`,
      ),
    ),
    seccion(
      "Tests que ya existen",
      e.tests_existentes.map((t) => `- ${t.ruta} — ${t.que_fija}`),
    ),
    seccion(
      "Riesgos",
      e.riesgos.map((r) => `- ${r}`),
    ),
    seccion(
      "Dudas",
      e.dudas.map((d) => `- ${d}`),
    ),
  ].join("\n\n")}\n`;
}

export const EXPLORAR_TIMEOUT_MS = 15 * 60_000;

/**
 * Corre la sesión de exploración y escribe runs/<id>/exploracion.md. Devuelve el Markdown, o
 * `sin_informe` si la sesión falló (deja un aviso), o el outcome `limite` para que planificar lo
 * devuelva.
 */
export async function explorar(
  ctx: PhaseContext,
  opts: { worktree: string; config: RepoConfig; feature: Feature; codigo: string },
): Promise<
  { tipo: "ok"; md: string } | { tipo: "sin_informe" } | { tipo: "limite"; hasta: number }
> {
  const { run, deps, emit } = ctx;
  const { worktree, config, feature, codigo } = opts;
  const result = await runSession(
    {
      fase: "planificar",
      nombre: sessionName(run, "explorar"),
      cwd: worktree,
      prompt: render("explorar", {
        feature: featureText(feature),
        codigo_ubicado: codigo,
        ...brainVars(loadBrain(worktree)),
      }),
      model: config.models.explorar,
      tools: ["Read", "Grep", "Glob"],
      // Sin `gate`: el servidor en proceso de `validar_plan` se conecta a una sola sesión, la del
      // planificador, y el explorador no planifica.
      mcpServers: { graft: graftMcpServer(worktree, graftIndex(run), deps.env) },
      hook: readOnlyHook(ctx, realpathSync(worktree), "planificar", true),
      schema: exploracionSchema,
      timeoutMs: EXPLORAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo === "limite") return result;
  if (result.tipo === "falla") {
    emit({
      tipo: "aviso",
      fase: "planificar",
      texto: `la exploración previa falló (${result.clase}): ${result.motivo}; se planifica sin informe`,
    });
    return { tipo: "sin_informe" };
  }
  const md = exploracionMd(result.output);
  writeFileSync(join(run.dir, "exploracion.md"), md);
  return { tipo: "ok", md };
}
