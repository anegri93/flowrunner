// `flowrunner skill install`: la skill de consola en ~/.claude/skills y, con confirmación, las reglas
// ask para que Claude Code pregunte antes de aprobar o pedir cambios.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserError } from "./output.ts";

const SKILL_DIR = join(import.meta.dirname, "..", "..", "skills", "flowrunner");
export const ASK_RULES = ["Bash(flowrunner approve:*)", "Bash(flowrunner changes:*)"] as const;

export function installSkill(env: NodeJS.ProcessEnv, confirmed: boolean) {
  const claude = join(env.HOME ?? homedir(), ".claude");
  const target = join(claude, "skills", "flowrunner");
  mkdirSync(target, { recursive: true });
  cpSync(SKILL_DIR, target, { recursive: true });
  const settingsFile = join(claude, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    } catch {
      throw new UserError(`${settingsFile} no es JSON válido: no lo toco`);
    }
  }
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const ask = Array.isArray(permissions.ask) ? (permissions.ask as string[]) : [];
  const missing = ASK_RULES.filter((r) => !ask.includes(r));
  if (confirmed && missing.length > 0) {
    settings.permissions = { ...permissions, ask: [...ask, ...missing] };
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return {
    ok: true as const,
    skill: target,
    reglas: [...ASK_RULES],
    agregadas: confirmed ? missing : [],
    pendientes: confirmed ? [] : missing,
  };
}
