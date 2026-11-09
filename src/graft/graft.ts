// El índice de graft de un worktree, construido fuera del repo, y su servidor MCP para el SDK.
//
// ADR 0015: `graft build` sin `--dir` crea `graft/`, `.gitignore` e `.ignore` dentro del repo, y con
// telemetría escribe `graft/.cache/`. Cualquiera de esos archivos ensucia el diff de la feature. Con
// `--dir` fuera del repo y `DO_NOT_TRACK=1`, el worktree queda intacto.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const GRAFT_ENV = { DO_NOT_TRACK: "1" } as const;

function graftEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...GRAFT_ENV };
}

/** Construye el índice de `repo` en `indexDir`, sin modelo. */
export async function buildIndex(
  repo: string,
  indexDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await run("graft", ["--dir", indexDir, "build", repo], {
    cwd: repo,
    env: graftEnv(base),
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** La entrada `mcpServers.graft` de una sesión del SDK que lee el índice de `indexDir`. */
/** Las herramientas que expone `graft mcp`, con el prefijo del servidor `graft`. */
export const GRAFT_TOOLS = [
  "graft_find_code",
  "graft_trace_calls",
  "graft_find_all",
  "graft_file_api",
  "graft_repo_map",
].map((t) => `mcp__graft__${t}`);

export function graftMcpServer(
  repo: string,
  indexDir: string,
  base: NodeJS.ProcessEnv = process.env,
) {
  const env: Record<string, string> = { ...GRAFT_ENV };
  if (base.PATH !== undefined) env.PATH = base.PATH;
  if (base.HOME !== undefined) env.HOME = base.HOME;
  return {
    type: "stdio" as const,
    command: "graft",
    args: ["--dir", indexDir, "mcp", repo],
    env,
  };
}

/** El radio de impacto del diff de la feature contra `base`, en texto, sin modelo. */
export async function blastRadius(
  repo: string,
  indexDir: string,
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const { stdout } = await run(
      "graft",
      ["--dir", indexDir, "blast", repo, "--base", base, "--no-owners", "--format", "text"],
      { cwd: repo, env: graftEnv(env), maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    // El radio es contexto para revisar, no un gate: sin él, revisar sigue con el diff.
    return `(graft blast no pudo calcular el radio: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
}
