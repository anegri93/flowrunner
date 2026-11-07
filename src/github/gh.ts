// GitHub, siempre desde código y por `gh`. Ningún agente tiene acceso a esto.
import { runProc, tail } from "../proc/proc.ts";

export class GhError extends Error {
  constructor(args: readonly string[], detail: string) {
    super(`gh ${args.join(" ")} falló: ${detail}`);
    this.name = "GhError";
  }
}

async function gh(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProc("gh", args, { cwd, env, timeoutMs: 120_000 });
  if (result.code !== 0) throw new GhError(args, tail(result, 5));
  return result.stdout.trim();
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
}

export async function findPr(
  cwd: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<PullRequest | undefined> {
  const out = await gh(
    cwd,
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state"],
    env,
  );
  return (JSON.parse(out === "" ? "[]" : out) as PullRequest[])[0];
}

export async function createPr(
  cwd: string,
  pr: { branch: string; base: string; title: string; bodyFile: string },
  env: NodeJS.ProcessEnv,
): Promise<PullRequest> {
  await gh(
    cwd,
    [
      "pr",
      "create",
      "--head",
      pr.branch,
      "--base",
      pr.base,
      "--title",
      pr.title,
      "--body-file",
      pr.bodyFile,
    ],
    env,
  );
  const created = await findPr(cwd, pr.branch, env);
  if (created === undefined)
    throw new GhError(["pr", "create"], "la PR no aparece después de crearla");
  return created;
}
