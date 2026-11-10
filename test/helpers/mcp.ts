// Llama a una herramienta de un servidor MCP en proceso (`createSdkMcpServer`) como lo hace el CLI: por
// JSON-RPC, con la validación de la entrada del SDK, sobre un transporte en memoria.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/types.ts";

export interface RespuestaMcp {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

export async function llamarHerramienta(
  server: McpServerConfig | undefined,
  name: string,
  args: unknown,
): Promise<RespuestaMcp> {
  if (server === undefined || !("instance" in server))
    throw new Error("no es un servidor MCP en proceso");
  const sent: { result?: RespuestaMcp }[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    start: () => Promise.resolve(),
    send: (message: { result?: RespuestaMcp }) => {
      sent.push(message);
      return Promise.resolve();
    },
    // El protocolo suelta el transporte en `onclose`: sin esto, el servidor no se vuelve a conectar.
    close: () => {
      transport.onclose?.();
      return Promise.resolve();
    },
  };
  await server.instance.connect(transport as never);
  try {
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    for (let i = 0; i < 500 && sent.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await server.instance.close();
  }
  const result = sent[0]?.result;
  if (result === undefined) throw new Error(`${name} no respondió`);
  return result;
}

/**
 * Antes de devolver el plan, la sesión lo pasa por `validar_plan`, como pide el prompt. El sim no llama
 * a los servidores MCP: esto lo llama de verdad con la salida del guion, justo antes del resultado, y
 * guarda lo que respondió. La herramienta nunca da `isError` por una excepción, la dice en el texto:
 * cualquiera de las dos es una falla del test.
 */
export function validandoAlFinal(query: QueryFn, respuestas: string[]): QueryFn {
  return (args) => {
    const inner = query(args);
    const gate = args.options?.mcpServers?.gate;
    return (async function* () {
      for await (const m of inner) {
        if (m.type === "result" && "structured_output" in m) {
          const r = await llamarHerramienta(gate, "validar_plan", m.structured_output);
          const text = r.content[0]?.text ?? "";
          if (r.isError === true || text.startsWith("no se pudo validar el plan"))
            throw new Error(`validar_plan falló: ${text}`);
          respuestas.push(text);
        }
        yield m;
      }
    })();
  };
}
