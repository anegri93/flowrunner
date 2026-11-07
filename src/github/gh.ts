// GitHub, siempre desde código y por `gh`. Ningún agente tiene acceso a esto.
import { z } from "zod";
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

const login = z.object({ login: z.string() });
/** La salida de `gh pr view`, validada: es un borde del sistema. */
export const prDetailSchema = z.object({
  number: z.int(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  commits: z
    .array(
      z.object({
        oid: z.string(),
        messageHeadline: z.string().default(""),
        messageBody: z.string().default(""),
        authors: z.array(login).default([]),
      }),
    )
    .default([]),
  comments: z
    .array(z.object({ author: login, body: z.string(), url: z.string().default("") }))
    .default([]),
  reviews: z.array(z.object({ author: login, body: z.string().default("") })).default([]),
});
export type PrDetail = z.infer<typeof prDetailSchema>;

export async function prDetail(
  cwd: string,
  number: number,
  env: NodeJS.ProcessEnv,
): Promise<PrDetail> {
  const out = await gh(
    cwd,
    ["pr", "view", String(number), "--json", "number,url,state,commits,comments,reviews"],
    env,
  );
  const parsed = prDetailSchema.safeParse(JSON.parse(out));
  if (!parsed.success)
    throw new GhError(
      ["pr", "view", String(number)],
      `respuesta inesperada: ${parsed.error.message}`,
    );
  return parsed.data;
}

export async function enableAutoMerge(
  cwd: string,
  number: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await gh(cwd, ["pr", "merge", String(number), "--auto", "--merge"], env);
}

export async function ghAuthOk(env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runProc("gh", ["auth", "status"], {
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  return result.code === 0;
}
