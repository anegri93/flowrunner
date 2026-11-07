// `flowrunner doctor`: qué le falta a esta máquina para correr runs, cada cosa con su arreglo.
import { existsSync } from "node:fs";
import { readKeychainToken } from "../agent/auth.ts";
import { ghAuthOk } from "../github/gh.ts";
import { runProc } from "../proc/proc.ts";
import { plistPath } from "./launchd.ts";

export interface Check {
  readonly nombre: string;
  readonly ok: boolean;
  readonly arreglo: string;
}

async function runs(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await runProc(command, args, { cwd: process.cwd(), env, timeoutMs: 30_000 })).code === 0;
}

export async function doctor(env: NodeJS.ProcessEnv) {
  const major = Number(process.versions.node.split(".")[0]);
  const checks: Check[] = [
    {
      nombre: `Node 24 (tenés ${process.versions.node})`,
      ok: major === 24,
      arreglo: "instalá Node 24, por ejemplo con `nvm install 24`",
    },
    { nombre: "git", ok: await runs("git", ["--version"], env), arreglo: "instalá git" },
    { nombre: "gh con sesión", ok: await ghAuthOk(env), arreglo: "corré `gh auth login`" },
    {
      nombre: "graft",
      ok: await runs("graft", ["--version"], env),
      arreglo: "corré `npm i -g @nanonets/graft`",
    },
    {
      nombre: "token de Claude en el Keychain",
      ok: readKeychainToken(env) !== undefined,
      arreglo:
        "corré `claude setup-token` y guardalo con `security add-generic-password -s flowrunner -a claude-oauth-token -w`",
    },
    {
      nombre: "job de launchd",
      ok: existsSync(plistPath(env)),
      arreglo: "corré `flowrunner launchd install`",
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export function describeDoctor(result: Awaited<ReturnType<typeof doctor>>): string {
  return result.checks
    .map((c) => (c.ok ? `✓ ${c.nombre}` : `✗ ${c.nombre}: ${c.arreglo}`))
    .join("\n");
}
