// `validar_plan`: el gate de planificar como herramienta del planificador. Corre sobre el plan los
// chequeos que no ejecutan nada, los mismos del gate de afuera, para que un plan que se ve mal se
// corrija en la misma sesión y no con un intento más. El gate de afuera sigue siendo la red: el único
// que corre los fixers y los criterios en rojo.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { chequeosEstaticos, type EstaticosInput } from "./estaticos.ts";
import { delRun, planSchema } from "./plan.ts";

export const VALIDAR_PLAN_TOOL = "mcp__gate__validar_plan";

/** El texto que ve el planificador. Exportado para el test. */
export function respuestaValidar(problemas: readonly string[]): string {
  return problemas.length === 0
    ? "ok: el plan pasa los chequeos que no corren nada. Al devolverlo, el gate además corre el comando de cada criterio, y tiene que fallar."
    : `El plan tiene ${String(problemas.length)} ${problemas.length === 1 ? "problema" : "problemas"}:\n- ${problemas.join("\n- ")}\nCorregilos y volvé a validar antes de devolver el plan.`;
}

/**
 * El servidor en proceso con `validar_plan`. `ctx` es el de la sesión: `desde` es el HEAD al abrirla,
 * así lo que ya estaba (el código conservado de un replan) no cuenta como escrito por el planificador.
 */
export function validarPlanServer(ctx: Omit<EstaticosInput, "plan" | "conserva">): McpServerConfig {
  return createSdkMcpServer({
    name: "gate",
    tools: [
      tool(
        "validar_plan",
        "Corre sobre el plan los chequeos del gate que no ejecutan nada: forma, alcances que se pisan, rutas protegidas, llamadores fuera del alcance, tests existentes sin declarar y tests declarados sin escribir. Pasale el mismo JSON que vas a devolver.",
        planSchema.shape,
        async (plan) => {
          // Como el gate de afuera: un criterio de verify es del run, lo haya asignado a quien sea.
          const problemas = await chequeosEstaticos({ ...ctx, plan: delRun(plan, ctx.esVerify) });
          return { content: [{ type: "text", text: respuestaValidar(problemas) }], isError: false };
        },
      ),
    ],
  });
}
