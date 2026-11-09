// El entorno de cada sesión del SDK y la limpieza de los comandos que lanza su Bash.
//
// ADR 0013: el SDK reemplaza el entorno entero con `env`, y los procesos que lanza Bash heredan ese
// entorno. Un token en el entorno de la sesión sería visible para el código y los tests que escribe
// el agente. Por eso cada comando de Bash permitido se reescribe para correr sin esas variables.
import { userInfo } from "node:os";

/** Variables que nunca llegan a un proceso que lanza el agente. */
export const SECRET_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Lo que el CLI de Claude necesita del entorno de la persona para arrancar. */
const INHERITED_VARS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL"] as const;

export type SessionAuth =
  /** Producción: el token de `claude setup-token` y una config de Claude propia de flowrunner. */
  | { kind: "token"; token: string; configDir: string }
  /** Smoke tests: la sesión de Claude Code que ya tiene la persona. */
  | { kind: "login" };

export function buildSessionEnv(
  auth: SessionAuth,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARS) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  // Claude Code busca su sesión del Keychain con la cuenta de USER. Un lanzador que no lo pasa, como
  // el host de plugins de Orca, dejaba cada sesión en modo login sin sesión.
  env.USER = base.USER ?? base.LOGNAME ?? userInfo().username;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "flowrunner/0";
  if (auth.kind === "token") {
    env.CLAUDE_CODE_OAUTH_TOKEN = auth.token;
    env.CLAUDE_CONFIG_DIR = auth.configDir;
  }
  return env;
}

/** Comillas simples de shell: todo literal, y una comilla simple se cierra, escapa y reabre. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Reescribe un comando para que corra sin las variables secretas en su entorno. */
export function scrubCommand(command: string, vars: readonly string[] = SECRET_ENV_VARS): string {
  const unset = vars.map((name) => `-u ${name}`).join(" ");
  return `env ${unset} sh -c ${shellQuote(command)}`;
}
