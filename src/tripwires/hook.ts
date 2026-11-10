// El hook PreToolUse de cada sesión: aplica las reglas en el momento en que el agente intenta usar
// una herramienta, devuelve el motivo del rechazo al agente y lo deja en el log.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { scrubCommand } from "../agent/env.ts";
import type { NewEvent, Phase } from "../store/events.ts";
import { checkCommand } from "./comandos.ts";
import {
  checkContent,
  checkReadPath,
  checkSearchPath,
  checkWritePath,
  insideRoot,
  type Scope,
  type Verdict,
} from "./rules.ts";

export interface HookPolicy {
  readonly scope: Scope;
  readonly fase: Phase;
  readonly unidad?: string;
  readonly write: boolean;
  readonly bash: boolean;
  /** Subagentes de solo lectura, como el explorador de planificar. */
  readonly agents: boolean;
  /**
   * Las herramientas del servidor MCP de graft. Con ellas, un archivo de más de
   * `LECTURA_ENTERA_MAX` líneas se lee por rango: hay con qué ubicar la línea antes de leer.
   */
  readonly graft: boolean;
  /** Otras herramientas MCP permitidas, por nombre completo: `mcp__<servidor>__<herramienta>`. */
  readonly mcp?: readonly string[];
}

const READ_ONLY = new Set(["Read", "Grep", "Glob", "TodoWrite", "StructuredOutput"]);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Hasta cuántas líneas se lee entero un archivo en una sesión con graft. Cada archivo leído entero se
 * arrastra en todos los turnos que siguen: en el issue 97, planificar leyó enteros los archivos que
 * la feature ya citaba con su línea.
 */
export const LECTURA_ENTERA_MAX = 200;

/**
 * Un Read sin `limit` de un archivo largo, con graft a mano: se rechaza y se pide el rango. Un archivo
 * que no se puede leer pasa, para que Read diga por qué; uno binario, como una imagen, no tiene líneas.
 */
function checkRange(scope: Scope, path: string, input: Record<string, unknown>): Verdict {
  // ponytail: un `limit` grande pasa igual; el agente que pide un rango ya eligió qué leer.
  if (input.limit !== undefined) return { ok: true };
  let content: Buffer;
  try {
    // ponytail: lee el archivo entero para contarlo; Read lo iba a leer igual.
    content = readFileSync(resolve(scope.root, path));
  } catch {
    return { ok: true };
  }
  if (content.includes(0)) return { ok: true };
  const text = content.toString("utf8");
  const total = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const desde = typeof input.offset === "number" && input.offset > 1 ? input.offset : 1;
  const lineas = total - desde + 1;
  if (lineas <= LECTURA_ENTERA_MAX) return { ok: true };
  const rel = insideRoot(scope, path) ?? path;
  return {
    ok: false,
    motivo: `${rel} tiene ${String(total)} líneas: leé solo el rango que necesitás, con \`offset\` y \`limit\` (hasta ${String(LECTURA_ENTERA_MAX)}). Ubicá las líneas antes: en código, con graft (\`graft_file_api\`, \`graft_find_code\`); en CSS, JSON o texto literal, con Grep y \`-n\`.`,
  };
}

function checkWrite(policy: HookPolicy, path: string | undefined, added: string[]): Verdict {
  if (!policy.write) return { ok: false, motivo: `${policy.fase} no escribe archivos` };
  if (path === undefined) return { ok: false, motivo: "falta la ruta del archivo" };
  const verdict = checkWritePath(policy.scope, path);
  if (!verdict.ok) return verdict;
  return checkContent(policy.scope, insideRoot(policy.scope, path) ?? path, added);
}

/**
 * La decisión sobre una herramienta, sin efectos: la usan el hook y los tests. Solo lee, para medir
 * el archivo que pide un Read.
 */
export function decide(
  policy: HookPolicy,
  tool: string,
  input: Record<string, unknown>,
): { verdict: Verdict; updatedInput?: Record<string, unknown> } {
  const lines = (text: unknown) => (asString(text) ?? "").split("\n");
  switch (tool) {
    case "Read": {
      const path = asString(input.file_path);
      const verdict = checkReadPath(policy.scope, path);
      if (!verdict.ok || !policy.graft || path === undefined) return { verdict };
      return { verdict: checkRange(policy.scope, path, input) };
    }
    case "Grep":
      return { verdict: checkSearchPath(policy.scope, asString(input.path)) };
    case "Glob":
      return { verdict: checkReadPath(policy.scope, asString(input.path)) };
    case "Write":
      return { verdict: checkWrite(policy, asString(input.file_path), lines(input.content)) };
    case "Edit":
      return { verdict: checkWrite(policy, asString(input.file_path), lines(input.new_string)) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      const added = edits.flatMap((e) => lines(e.new_string));
      return { verdict: checkWrite(policy, asString(input.file_path), added) };
    }
    case "NotebookEdit":
      return {
        verdict: checkWrite(policy, asString(input.notebook_path), lines(input.new_source)),
      };
    case "Bash": {
      if (!policy.bash)
        return { verdict: { ok: false, motivo: `${policy.fase} no corre comandos` } };
      const command = asString(input.command) ?? "";
      const verdict = checkCommand(policy.scope, command);
      return verdict.ok
        ? { verdict, updatedInput: { ...input, command: scrubCommand(command.trim()) } }
        : { verdict };
    }
    case "Agent":
    case "Task":
      return {
        verdict: policy.agents
          ? { ok: true }
          : { ok: false, motivo: `${policy.fase} no lanza subagentes` },
      };
    default:
      if (READ_ONLY.has(tool)) return { verdict: { ok: true } };
      if (tool.startsWith("mcp__graft__") && policy.graft) return { verdict: { ok: true } };
      if (policy.mcp?.includes(tool) === true) {
        // Una captura con nombre se escribe donde diga el nombre; sin él, en la carpeta de pruebas.
        if (tool.endsWith("__browser_take_screenshot") && "filename" in input) {
          const { filename: _, ...rest } = input;
          return { verdict: { ok: true }, updatedInput: rest };
        }
        return { verdict: { ok: true } };
      }
      return { verdict: { ok: false, motivo: `${tool} no está permitida en ${policy.fase}` } };
  }
}

export function tripwireHook(policy: HookPolicy, emit: (event: NewEvent) => unknown): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const { verdict, updatedInput } = decide(policy, input.tool_name, toolInput);
    let output: SyncHookJSONOutput;
    if (verdict.ok) {
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          ...(updatedInput === undefined ? {} : { updatedInput }),
        },
      };
    } else {
      emit({
        tipo: "rechazo",
        fase: policy.fase,
        ...(policy.unidad === undefined ? {} : { unidad: policy.unidad }),
        herramienta: input.tool_name,
        motivo: verdict.motivo,
      });
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.motivo,
        },
      };
    }
    return Promise.resolve(output);
  };
}
