// `validar_plan`: el gate de planificar como herramienta del planificador. Corre sobre el plan los
// chequeos que no ejecutan nada, los mismos del gate de afuera, para que un plan que se ve mal se
// corrija en la misma sesión y no con un intento más. El gate de afuera sigue siendo la red: el único
// que corre los fixers y los criterios en rojo.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { checkConserva, conservadas, type ConservaInput } from "./conserva.ts";
import { chequeosEstaticos, type EstaticosInput } from "./estaticos.ts";
import { delRun, planSchema, type Plan } from "./plan.ts";

export const VALIDAR_PLAN_TOOL = "mcp__gate__validar_plan";

/** El texto que ve el planificador, con la `nota` de lo que no se chequeó al final. Exportado para el test. */
export function respuestaValidar(problemas: readonly string[], nota?: string): string {
  const texto =
    problemas.length === 0
      ? "ok: el plan pasa los chequeos que no corren nada. Al devolverlo, el gate además corre el comando de cada criterio, y tiene que fallar."
      : `El plan tiene ${String(problemas.length)} ${problemas.length === 1 ? "problema" : "problemas"}:\n- ${problemas.join("\n- ")}\nCorregilos y volvé a validar antes de devolver el plan.`;
  return nota === undefined ? texto : `${texto}\n${nota}`;
}

/**
 * Las candidatas de un replan que el gate saca de la rama antes de chequear llamadores y tests, o
 * undefined si chequea la misma rama que ve la sesión: sin candidatas, o con todas conservadas. Con un
 * `conserva` inválido el gate no rearma, pero el plan corregido puede hacerlo: tampoco es la misma rama.
 */
export function sacadasDeLaRama(
  candidatas: readonly string[],
  conserva: ConservaInput | undefined,
): string[] | undefined {
  if (candidatas.length === 0) return undefined;
  const kept = conserva === undefined ? [] : conservadas(conserva);
  const invalido = conserva !== undefined && checkConserva(conserva).length > 0;
  if (!invalido && candidatas.every((id) => kept.includes(id))) return undefined;
  return candidatas.filter((id) => !kept.includes(id));
}

/** La línea que dice qué no se chequeó y por qué. */
export function notaSinRama(sacadas: readonly string[]): string {
  return sacadas.length === 0
    ? "Los llamadores y los tests no se chequearon acá: el gate de afuera los chequea sobre la rama que quede cuando conserva sea válido."
    : `Los llamadores y los tests no se chequearon acá: el gate de afuera los chequea después de sacar de la rama ${sacadas.join(", ")}, que el plan no conserva.`;
}

export interface ValidarCtx extends Omit<EstaticosInput, "plan" | "conserva" | "rama"> {
  /** En un replan, los ids de las candidatas que están en la rama al abrir la sesión. */
  readonly candidatas?: readonly string[];
  /** En un replan, el `conserva` del plan, armado igual que en el gate (`conservaDelPlan`). */
  readonly conservaDe?: (plan: Plan) => Promise<ConservaInput | undefined>;
}

/**
 * El servidor en proceso con `validar_plan`. `ctx` es el de la sesión: `desde` es el HEAD al abrirla,
 * así lo que ya estaba (el código conservado de un replan) no cuenta como escrito por el planificador.
 * Si el gate va a chequear otra rama, solo responde lo que no depende de ella: un falso «ok» cuesta un
 * rechazo, y un falso problema puede deformar el plan.
 */
export function validarPlanServer(ctx: ValidarCtx): McpServerConfig {
  const { candidatas = [], conservaDe, ...estaticos } = ctx;
  return createSdkMcpServer({
    name: "gate",
    tools: [
      tool(
        "validar_plan",
        "Corre sobre el plan los chequeos del gate que no ejecutan nada: forma, alcances que se pisan, rutas protegidas, llamadores fuera del alcance, tests existentes sin declarar y tests declarados sin escribir. Pasale el mismo JSON que vas a devolver.",
        planSchema.shape,
        async (plan) => {
          let text: string;
          try {
            // Como el gate de afuera: un criterio de verify es del run, lo haya asignado a quien sea.
            const normalizado = delRun(plan, ctx.esVerify);
            const conserva = await conservaDe?.(normalizado);
            const sacadas = sacadasDeLaRama(candidatas, conserva);
            const problemas = await chequeosEstaticos({
              ...estaticos,
              plan: normalizado,
              ...(conserva === undefined ? {} : { conserva }),
              rama: sacadas === undefined,
            });
            text = respuestaValidar(
              problemas,
              sacadas === undefined ? undefined : notaSinRama(sacadas),
            );
          } catch (error) {
            // Nunca una falla de la herramienta: el planificador no tiene nada que corregir, y el gate de
            // afuera corre los mismos chequeos al devolver el plan.
            const motivo = (error instanceof Error ? error.message : String(error)).split("\n")[0];
            text = `no se pudo validar el plan (${motivo ?? ""}): el gate de afuera lo chequea igual al devolverlo.`;
          }
          return { content: [{ type: "text", text }], isError: false };
        },
      ),
    ],
  });
}
