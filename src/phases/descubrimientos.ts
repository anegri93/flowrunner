// Lo que el que implementa descubre del repo y le costó un rojo o un reintento (flowrunner 2.0). Sin esto,
// solo se aprendía de las vueltas: un run derecho no dejaba nada aunque hubiera descubierto mucho, e
// implementar no registró ni una decisión en 33 runs. Proponer las convierte en lecciones (T3.2).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { NewEvent } from "../store/events.ts";

export const DESCUBRIMIENTO_TOOL = "mcp__aprender__anotar_descubrimiento";
/** Más que eso por sesión es una narración de lo que hizo, no lo que le costó. */
const MAX_POR_SESION = 3;

/** `ruta:línea` de un archivo del worktree, con la línea dentro del archivo; si no, por qué no. */
function dondeValido(worktree: string, donde: string): string | undefined {
  const m = /^([^:\s]+):(\d+)$/.exec(donde);
  if (m === null) return "tiene que ser ruta:línea, como src/Conectar.tsx:46";
  const [, ruta = "", linea = ""] = m;
  if (ruta.startsWith("/") || ruta.split("/").includes(".."))
    return "la ruta va relativa al worktree, sin ..";
  const abs = join(worktree, ruta);
  if (!existsSync(abs) || !statSync(abs).isFile()) return `${ruta} no existe en el worktree`;
  const lineas = readFileSync(abs, "utf8").split("\n").length;
  const n = Number(linea);
  return n >= 1 && n <= lineas ? undefined : `${ruta} no tiene la línea ${linea}`;
}

export function descubrimientosServer(ctx: {
  readonly worktree: string;
  readonly unidad: string;
  readonly emit: (event: NewEvent) => void;
}): McpServerConfig {
  let anotados = 0;
  const responder = (text: string) => ({ content: [{ type: "text" as const, text }] });
  return createSdkMcpServer({
    name: "aprender",
    tools: [
      tool(
        "anotar_descubrimiento",
        "Anotá algo del repo o de una librería que no sabías y te costó un rojo o un reintento, incluido un rojo de un test o de verify que arreglaste en esta sesión. No es lo que hiciste: es lo que el próximo que toque esto tiene que saber. Hasta 3 por sesión.",
        {
          que: z.string().min(1).describe("lo que descubriste, en una oración"),
          donde: z.string().min(1).describe("ruta:línea del worktree donde se ve"),
          como: z
            .string()
            .min(1)
            .describe("cómo te diste cuenta: el rojo, el error o lo que viste"),
        },
        (args) => {
          if (anotados >= MAX_POR_SESION)
            return Promise.resolve(
              responder(`ya anotaste ${String(MAX_POR_SESION)}: no anoto más en esta sesión`),
            );
          const invalido = dondeValido(ctx.worktree, args.donde);
          if (invalido !== undefined) {
            ctx.emit({
              tipo: "aviso",
              fase: "implementar",
              texto: `se descartó un descubrimiento de ${ctx.unidad} (${args.donde}): ${invalido}`,
            });
            return Promise.resolve(responder(`no lo anoté: ${invalido}`));
          }
          anotados++;
          ctx.emit({
            tipo: "descubrimiento",
            fase: "implementar",
            unidad: ctx.unidad,
            que: args.que,
            donde: args.donde,
            como: args.como,
          });
          return Promise.resolve(responder("anotado"));
        },
      ),
    ],
  });
}
