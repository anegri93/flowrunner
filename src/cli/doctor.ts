// `flowrunner doctor`: qué le falta a esta máquina para correr runs, cada cosa con su arreglo.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readKeychainToken } from "../agent/auth.ts";
import { loadGlobalConfig } from "../config/load.ts";
import { ConfigError } from "../config/schemas.ts";
import { ghAuthOk } from "../github/gh.ts";
import { runProc } from "../proc/proc.ts";
import { appBin, resolvesToApp } from "../setup/app.ts";
import { commandDir } from "../setup/init.ts";
import { plistPath } from "./launchd.ts";

export interface Check {
  readonly nombre: string;
  readonly ok: boolean;
  readonly arreglo: string;
}

async function runs(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await runProc(command, args, { cwd: process.cwd(), env, timeoutMs: 30_000 })).code === 0;
}

const claudeStatus = z.object({ loggedIn: z.boolean() });

/** `claude auth status` sale 0 y dice `loggedIn: true` solo con una sesión abierta. */
export async function claudeLoggedIn(env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runProc("claude", ["auth", "status"], {
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) return false;
  try {
    return claudeStatus.parse(JSON.parse(result.stdout)).loggedIn;
  } catch {
    return false;
  }
}

/** Sin config global todavía, doctor revisa el modo por defecto. */
function authMode(env: NodeJS.ProcessEnv): "token" | "login" {
  try {
    return loadGlobalConfig(env).auth;
  } catch (error) {
    if (error instanceof ConfigError) return "token";
    throw error;
  }
}

async function credentialCheck(env: NodeJS.ProcessEnv): Promise<Check> {
  if (authMode(env) === "login") {
    return {
      nombre: "sesión de Claude Code",
      ok: await claudeLoggedIn(env),
      arreglo: "abrí `claude` y corré `/login`",
    };
  }
  return {
    nombre: "token de Claude en el Keychain",
    ok: readKeychainToken(env) !== undefined,
    arreglo:
      "corré `claude setup-token` y guardalo con `security add-generic-password -s flowrunner -a claude-oauth-token -w`, o poné `auth: login` en ~/.flowrunner/config.yaml",
  };
}

/** flowrunner corre el TypeScript directo, lo que pide Node 24 o más nuevo. */
export function nodeSupported(version: string): boolean {
  return Number(version.split(".")[0]) >= 24;
}

/** Si el plist del tick corre el bin de la app: lo escribe con la ruta real, sin links. */
function plistRunsApp(plist: string, env: NodeJS.ProcessEnv): boolean {
  const text = readFileSync(plist, "utf8");
  const bin = appBin(env);
  if (text.includes(bin)) return true;
  try {
    return text.includes(realpathSync(bin));
  } catch {
    return false;
  }
}

/**
 * El comando y el tick corren la app, no un checkout donde se cambia de rama (ADR 0020). El plugin
 * de Orca no se revisa: su CLI no dice desde dónde lo cargó.
 */
export function appCheck(env: NodeJS.ProcessEnv): Check {
  const dir = commandDir(env);
  const plist = plistPath(env);
  return {
    nombre: "flowrunner corre desde ~/.flowrunner/app",
    ok:
      dir !== undefined &&
      resolvesToApp(join(dir, "flowrunner"), env) &&
      (!existsSync(plist) || plistRunsApp(plist, env)),
    arreglo: "corré `flowrunner self-update`",
  };
}

export async function doctor(env: NodeJS.ProcessEnv) {
  const checks: Check[] = [
    {
      nombre: `Node 24 o más nuevo (tenés ${process.versions.node})`,
      ok: nodeSupported(process.versions.node),
      arreglo: "instalá Node 24 o más nuevo, por ejemplo con `nvm install 24`",
    },
    { nombre: "git", ok: await runs("git", ["--version"], env), arreglo: "instalá git" },
    { nombre: "gh con sesión", ok: await ghAuthOk(env), arreglo: "corré `gh auth login`" },
    {
      nombre: "graft",
      ok: await runs("graft", ["--version"], env),
      arreglo: "corré `npm i -g @nanonets/graft`",
    },
    await credentialCheck(env),
    {
      nombre: "job de launchd",
      ok: existsSync(plistPath(env)),
      arreglo: "corré `flowrunner launchd install`",
    },
    appCheck(env),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export function describeDoctor(result: Awaited<ReturnType<typeof doctor>>): string {
  return result.checks
    .map((c) => (c.ok ? `✓ ${c.nombre}` : `✗ ${c.nombre}: ${c.arreglo}`))
    .join("\n");
}
