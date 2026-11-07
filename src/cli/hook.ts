// `flowrunner hook session-start`: el hook SessionStart de Claude Code. En un repo registrado le dice a
// la sesión que las features van por flowrunner; en cualquier otro lado no dice nada. Nunca hace
// fallar el arranque de una sesión.
import { z } from "zod";
import { loadGlobalConfig } from "../config/load.ts";
import { runProc } from "../proc/proc.ts";

const inputSchema = z.object({ cwd: z.string().min(1) });

function contextFor(project: string): string {
  return [
    `Este repo usa flowrunner: es el proyecto \`${project}\`.`,
    "Cuando la persona pida una feature nueva o un cambio de comportamiento, no lo implementes directo",
    "en esta sesión: usá la skill `flowrunner` para escribir la feature conversando y lanzarla como run.",
    "Implementalo directo solo si la persona lo pide explícitamente. Si dudás de si algo es una",
    "feature, preguntale si va por flowrunner.",
  ].join(" ");
}

/** El contexto para la sesión que arranca en `raw.cwd`, o undefined si ese repo no usa flowrunner. */
export async function sessionStartContext(
  raw: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const root = await runProc("git", ["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
    env,
    timeoutMs: 5_000,
  }).catch(() => undefined);
  if (root?.code !== 0) return undefined;
  let projects;
  try {
    projects = loadGlobalConfig(env).projects;
  } catch {
    return undefined;
  }
  const project = projects.find((p) => p.path === root.stdout.trim());
  return project === undefined ? undefined : contextFor(project.name);
}

export function hookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
}
