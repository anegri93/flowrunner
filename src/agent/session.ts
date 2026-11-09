// Una sesión del SDK con las reglas de flowrunner: aislada, con salida validada, presupuesto, timeout,
// su stream copiado al run y su costo en el log. Es el único lugar que arma opciones del SDK.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentDefinition,
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ModelChoice } from "../config/schemas.ts";
import type { Deps, RunPaths } from "../runner/types.ts";
import type { NewEvent, Phase } from "../store/events.ts";
import { AuthError, resolveAuth } from "./auth.ts";
import { buildSessionEnv } from "./env.ts";
import { descendants, killAll, type LiveProcess } from "./procesos.ts";

export interface SessionSpec<T> {
  readonly fase: Phase;
  readonly unidad?: string;
  /** Nombre del archivo del stream: `sesiones/<nombre>.jsonl`. */
  readonly nombre: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly cwd: string;
  readonly model: ModelChoice;
  readonly tools: readonly string[];
  readonly hook: HookCallback;
  readonly schema?: z.ZodType<T>;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  /** Sin él, la sesión no se corta por gasto: solo el timeout la acota. */
  readonly maxBudgetUsd?: number;
  readonly timeoutMs: number;
  readonly maxTurns?: number;
}

export type SessionResult<T> =
  | { readonly tipo: "ok"; readonly output: T; readonly texto: string; readonly costoUsd: number }
  | {
      readonly tipo: "falla";
      readonly clase: "gate" | "infra" | "entorno";
      readonly motivo: string;
    }
  | { readonly tipo: "limite"; readonly hasta: number };

export interface SessionRuntime {
  readonly run: RunPaths;
  readonly deps: Deps;
  readonly emit: (event: NewEvent) => unknown;
}

const DENY_REST: CanUseTool = () =>
  Promise.resolve({
    behavior: "deny",
    message: "flowrunner corre sin nadie a quien preguntarle: herramienta no permitida",
  });

export function buildOptions<T>(
  spec: SessionSpec<T>,
  rt: SessionRuntime,
  abort: AbortController,
): Options {
  const auth = resolveAuth(rt.deps.env, rt.run.home);
  return {
    cwd: spec.cwd,
    model: spec.model.model,
    effort: spec.model.effort,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: spec.mcpServers ?? {},
    env: buildSessionEnv(auth, rt.deps.env),
    tools: [...spec.tools],
    hooks: { PreToolUse: [{ hooks: [spec.hook] }] },
    canUseTool: DENY_REST,
    ...(spec.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: spec.maxBudgetUsd }),
    ...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
    ...(spec.agents === undefined ? {} : { agents: spec.agents }),
    ...(spec.systemPrompt === undefined ? {} : { systemPrompt: spec.systemPrompt }),
    ...(spec.schema === undefined
      ? {}
      : {
          outputFormat: {
            type: "json_schema",
            schema: z.toJSONSchema(spec.schema, { target: "draft-7" }),
          },
        }),
    persistSession: false,
    abortController: abort,
  };
}

/** Cierra la query sin esperarla: `close()` del SDK si lo tiene, si no el `return` del iterador. */
function closeQuery(stream: AsyncIterable<SDKMessage>, messages: AsyncIterator<SDKMessage>): void {
  const close = (stream as { close?: unknown }).close;
  if (typeof close === "function") {
    try {
      close.call(stream);
    } catch {
      // ya estaba cerrada
    }
    return;
  }
  void messages.return?.().catch(() => undefined);
}

const TOKEN_REJECTED =
  "Claude rechazó la credencial de la sesión: revisá el token del Keychain con `flowrunner doctor`";
const LOGIN_MISSING =
  "Claude Code no encontró tu sesión: corré `claude auth status` en la terminal y, si no hay sesión, abrí `claude` y corré `/login`";

export async function runSession<T>(
  spec: SessionSpec<T>,
  rt: SessionRuntime,
): Promise<SessionResult<T>> {
  const abort = new AbortController();
  let options: Options;
  try {
    options = buildOptions(spec, rt, abort);
  } catch (error) {
    if (error instanceof AuthError)
      return { tipo: "falla", clase: "entorno", motivo: error.message };
    throw error;
  }
  // En modo token la sesión lleva su token; en modo login, la sesión de Claude Code de la persona.
  const authFailedMotivo =
    options.env?.CLAUDE_CODE_OAUTH_TOKEN === undefined ? LOGIN_MISSING : TOKEN_REJECTED;
  const dir = join(rt.run.dir, "sesiones");
  mkdirSync(dir, { recursive: true });
  const streamFile = join(dir, `${spec.nombre}.jsonl`);
  // El CLI se lanza acá para conocer su PID: al terminar, lo que dejó vivo se mata.
  let cli: number | undefined;
  options = {
    ...options,
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
      // Nadie lee el stderr del CLI por esta vía; sin vaciarlo, el CLI se traba al llenar el pipe.
      child.stderr.on("data", (chunk: Buffer) => options.stderr?.(chunk.toString()));
      cli = child.pid;
      return child;
    },
  };
  /** Lo que el CLI dejó corriendo. Se mira antes de cerrarlo: después, sus hijos ya no son suyos. */
  let leftovers: LiveProcess[] = [];
  const reap = () => {
    if (cli !== undefined) leftovers = descendants(cli);
  };
  const timer = setTimeout(() => {
    reap();
    abort.abort();
  }, spec.timeoutMs);
  let result: Extract<SDKMessage, { type: "result" }> | undefined;
  let limitUntil: number | undefined;
  let authFailed = false;
  const started = Date.now();
  const stream = rt.deps.query({ prompt: spec.prompt, options });
  const messages = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await messages.next();
      if (next.done === true) break;
      const message = next.value;
      appendFileSync(streamFile, `${JSON.stringify(message)}\n`);
      if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
        limitUntil = (message.rate_limit_info.resetsAt ?? Date.now() / 1000 + 3600) * 1000;
      }
      if ((message as { error?: unknown }).error === "authentication_failed") authFailed = true;
      if (message.type === "result") {
        // El resultado es lo último que importa. Esperar a que el stream cierre era esperar a cada
        // proceso que la sesión dejó vivo, como un runner de tests que no sale: hasta el timeout.
        result = message;
        reap();
        closeQuery(stream, messages);
        break;
      }
    }
  } catch (error) {
    if (limitUntil !== undefined) return { tipo: "limite", hasta: limitUntil };
    if (authFailed) return { tipo: "falla", clase: "entorno", motivo: authFailedMotivo };
    const motivo = abort.signal.aborted
      ? `la sesión ${spec.nombre} pasó su timeout de ${Math.round(spec.timeoutMs / 60_000)} min`
      : `la sesión ${spec.nombre} falló: ${error instanceof Error ? error.message : String(error)}`;
    return { tipo: "falla", clase: "infra", motivo };
  } finally {
    clearTimeout(timer);
    killAll([...leftovers.map((p) => p.pid), ...(cli === undefined ? [] : [cli])]);
    const servers = Object.values(spec.mcpServers ?? {}).flatMap((s) =>
      "command" in s && typeof s.command === "string" ? [s.command] : [],
    );
    // Los servidores MCP de la sesión son hijos del CLI y terminan con ella: no son un problema.
    const stuck = leftovers.filter((p) => !servers.some((s) => p.command.includes(s)));
    if (stuck.length > 0) {
      rt.emit({
        tipo: "aviso",
        fase: spec.fase,
        texto: `la sesión ${spec.nombre} dejó ${String(stuck.length)} ${stuck.length === 1 ? "proceso" : "procesos"} sin terminar y flowrunner los cortó: ${stuck.map((p) => `\`${p.command.slice(0, 200)}\``).join(", ")}`,
      });
    }
  }
  if (limitUntil !== undefined) return { tipo: "limite", hasta: limitUntil };
  if (authFailed) return { tipo: "falla", clase: "entorno", motivo: authFailedMotivo };
  if (result === undefined) {
    return {
      tipo: "falla",
      clase: "infra",
      motivo: `la sesión ${spec.nombre} terminó sin resultado`,
    };
  }
  const tokens = Object.values(result.modelUsage).reduce(
    (acc, m) => ({ entrada: acc.entrada + m.inputTokens, salida: acc.salida + m.outputTokens }),
    { entrada: 0, salida: 0 },
  );
  rt.emit({
    tipo: "uso",
    fase: spec.fase,
    ...(spec.unidad === undefined ? {} : { unidad: spec.unidad }),
    sesion: spec.nombre,
    modelo: spec.model.model,
    costo_usd: result.total_cost_usd,
    tokens_entrada: tokens.entrada,
    tokens_salida: tokens.salida,
    duracion_ms: Math.max(0, Math.round(result.duration_ms || Date.now() - started)),
  });
  switch (result.subtype) {
    case "success": {
      if (spec.schema === undefined) {
        return {
          tipo: "ok",
          output: undefined as T,
          texto: result.result,
          costoUsd: result.total_cost_usd,
        };
      }
      const parsed = spec.schema.safeParse(result.structured_output);
      if (!parsed.success) {
        return {
          tipo: "falla",
          clase: "gate",
          motivo: `la salida de ${spec.fase} no cumple su schema: ${parsed.error.issues[0]?.message ?? ""}`,
        };
      }
      return {
        tipo: "ok",
        output: parsed.data,
        texto: result.result,
        costoUsd: result.total_cost_usd,
      };
    }
    case "error_max_structured_output_retries":
      return {
        tipo: "falla",
        clase: "gate",
        motivo: `${spec.fase} no logró una salida que cumpla su schema`,
      };
    case "error_max_turns":
      return {
        tipo: "falla",
        clase: "gate",
        motivo: `${spec.fase} llegó al máximo de turnos sin terminar`,
      };
    case "error_max_budget_usd":
      return {
        tipo: "falla",
        clase: "gate",
        motivo: `${spec.fase} pasó su presupuesto de USD ${String(spec.maxBudgetUsd)}`,
      };
    default:
      return {
        tipo: "falla",
        clase: "infra",
        motivo: `la sesión ${spec.nombre} terminó con ${result.subtype}: ${result.errors.join("; ")}`,
      };
  }
}
