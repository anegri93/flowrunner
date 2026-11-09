// El hook PreToolUse de cada sesión: aplica las reglas en el momento en que el agente intenta usar
// una herramienta, devuelve el motivo del rechazo al agente y lo deja en el log.
import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { scrubCommand } from "../agent/env.ts";
import type { NewEvent, Phase } from "../store/events.ts";
import {
  checkBash,
  checkContent,
  checkReadPath,
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
  /** Las herramientas del servidor MCP de graft. */
  readonly graft: boolean;
  /** Otras herramientas MCP permitidas, por nombre completo: `mcp__<servidor>__<herramienta>`. */
  readonly mcp?: readonly string[];
}

const READ_ONLY = new Set(["Read", "Grep", "Glob", "TodoWrite", "StructuredOutput"]);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function checkWrite(policy: HookPolicy, path: string | undefined, added: string[]): Verdict {
  if (!policy.write) return { ok: false, motivo: `${policy.fase} no escribe archivos` };
  if (path === undefined) return { ok: false, motivo: "falta la ruta del archivo" };
  const verdict = checkWritePath(policy.scope, path);
  if (!verdict.ok) return verdict;
  return checkContent(policy.scope, insideRoot(policy.scope, path) ?? path, added);
}

/** La decisión sobre una herramienta, sin efectos: la usan el hook y los tests. */
export function decide(
  policy: HookPolicy,
  tool: string,
  input: Record<string, unknown>,
): { verdict: Verdict; updatedInput?: Record<string, unknown> } {
  const lines = (text: unknown) => (asString(text) ?? "").split("\n");
  switch (tool) {
    case "Read":
      return { verdict: checkReadPath(policy.scope, asString(input.file_path)) };
    case "Grep":
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
      const verdict = checkBash(policy.scope, command);
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
