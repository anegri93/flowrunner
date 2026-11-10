// `flowrunner skill install`: la skill de consola en ~/.claude/skills y, con confirmación, las reglas
// ask para que Claude Code pregunte antes de aprobar, pedir cambios o entregar sin probar.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../agent/env.ts";
import { appBin } from "../setup/app.ts";
import { UserError } from "./output.ts";
import { BIN } from "./runs.ts";

const SKILL_DIR = join(import.meta.dirname, "..", "..", "skills", "flowrunner");
export const ASK_RULES = [
  "Bash(flowrunner approve:*)",
  "Bash(flowrunner changes:*)",
  // Entregar con criterios sin probar es de la persona, como aprobar (ADR 0017).
  "Bash(flowrunner accept-untested:*)",
  // Responder la pregunta de un run detenido también (ADR 0023).
  "Bash(flowrunner fix:*)",
  "Bash(flowrunner accept:*)",
] as const;
/** El hook SessionStart: con la ruta del bin, para no depender del PATH con que arranca Claude Code. */
export const SESSION_HOOK = `${shellQuote(BIN)} hook session-start`;

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

const claudeDir = (env: NodeJS.ProcessEnv) => join(env.HOME ?? homedir(), ".claude");

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new UserError(`${file} no es JSON válido: no lo toco`);
  }
}

function sessionStart(settings: Record<string, unknown>): HookEntry[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  return Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookEntry[]) : [];
}

const hasSessionHook = (settings: Record<string, unknown>) =>
  sessionStart(settings).some((e) => e.hooks?.some((h) => h.command === SESSION_HOOK) === true);

/** Los hooks de flowrunner que se quedan: el de este código y el de la app (ADR 0020). */
function keptHooks(env: NodeJS.ProcessEnv): Set<string> {
  const bins = [appBin(env)];
  try {
    bins.push(realpathSync(appBin(env)));
  } catch {
    // Sin app instalada, se queda solo el de este código.
  }
  return new Set([SESSION_HOOK, ...bins.map((b) => `${shellQuote(b)} hook session-start`)]);
}

/**
 * El hook de otro flowrunner, como el del checkout de desarrollo después de `self-update`: dejarlo
 * duplica el contexto de cada sesión y corre el código de un checkout que cambia de rama.
 */
const isStaleHook = (command: string | undefined, kept: Set<string>) =>
  command !== undefined &&
  !kept.has(command) &&
  /\/bin\/flowrunner\.js'? hook session-start$/.test(command);

const staleHooks = (settings: Record<string, unknown>, kept: Set<string>): string[] =>
  sessionStart(settings).flatMap((e) =>
    (e.hooks ?? []).flatMap((h) => (isStaleHook(h.command, kept) ? [h.command ?? ""] : [])),
  );

/** SessionStart sin los hooks de otro flowrunner; una entrada que se queda sin hooks se va. */
function withoutStaleHooks(settings: Record<string, unknown>, kept: Set<string>): HookEntry[] {
  return sessionStart(settings).flatMap((e) => {
    if (e.hooks === undefined) return [e];
    const hooks = e.hooks.filter((h) => !isStaleHook(h.command, kept));
    return hooks.length === 0 ? [] : [{ ...e, hooks }];
  });
}

/** La skill instalada es la de este flowrunner, y las reglas ask y el hook están en settings.json. */
export function skillUpToDate(env: NodeJS.ProcessEnv): boolean {
  const claude = claudeDir(env);
  const installed = join(claude, "skills", "flowrunner", "SKILL.md");
  if (!existsSync(installed)) return false;
  if (readFileSync(installed, "utf8") !== readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")) {
    return false;
  }
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(join(claude, "settings.json"));
  } catch {
    return false;
  }
  const ask = ((settings.permissions ?? {}) as { ask?: unknown }).ask;
  return (
    Array.isArray(ask) &&
    ASK_RULES.every((r) => ask.includes(r)) &&
    hasSessionHook(settings) &&
    staleHooks(settings, keptHooks(env)).length === 0
  );
}

export function installSkill(env: NodeJS.ProcessEnv, confirmed: boolean) {
  const claude = claudeDir(env);
  const target = join(claude, "skills", "flowrunner");
  mkdirSync(target, { recursive: true });
  cpSync(SKILL_DIR, target, { recursive: true });
  const settingsFile = join(claude, "settings.json");
  const settings = readSettings(settingsFile);
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const ask = Array.isArray(permissions.ask) ? (permissions.ask as string[]) : [];
  const missing: string[] = ASK_RULES.filter((r) => !ask.includes(r));
  const hookMissing = !hasSessionHook(settings);
  const kept = keptHooks(env);
  const stale = staleHooks(settings, kept);
  if (confirmed && (missing.length > 0 || hookMissing || stale.length > 0)) {
    settings.permissions = { ...permissions, ask: [...ask, ...missing] };
    if (hookMissing || stale.length > 0) {
      const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
      settings.hooks = {
        ...hooks,
        SessionStart: [
          ...withoutStaleHooks(settings, kept),
          ...(hookMissing
            ? [{ hooks: [{ type: "command", command: SESSION_HOOK, timeout: 10 }] }]
            : []),
        ],
      };
    }
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  const pending = [
    ...missing,
    ...(hookMissing ? [`hook SessionStart: ${SESSION_HOOK}`] : []),
    ...stale.map((c) => `quitar el hook SessionStart de otro flowrunner: ${c}`),
  ];
  return {
    ok: true as const,
    skill: target,
    reglas: [...ASK_RULES],
    agregadas: confirmed ? pending : [],
    pendientes: confirmed ? [] : pending,
  };
}
