// El job de launchd que corre `flowrunner tick` cada `tick_minutes`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { flowrunnerHome, loadGlobalConfig } from "../config/load.ts";
import { runProc } from "../proc/proc.ts";
import { BIN } from "./runs.ts";

export const LABEL = "com.flowrunner.tick";

/** `FLOWRUNNER_LAUNCH_AGENTS` existe para los tests: nunca escriben en el LaunchAgents de la persona. */
export function plistPath(env: NodeJS.ProcessEnv): string {
  const dir =
    env.FLOWRUNNER_LAUNCH_AGENTS ?? join(env.HOME ?? homedir(), "Library", "LaunchAgents");
  return join(dir, `${LABEL}.plist`);
}

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plistFor(env: NodeJS.ProcessEnv, tickMinutes: number): string {
  const home = flowrunnerHome(env);
  const vars: Record<string, string> = {
    PATH: env.PATH ?? "/usr/bin:/bin",
    HOME: env.HOME ?? homedir(),
  };
  if (env.FLOWRUNNER_HOME !== undefined) vars.FLOWRUNNER_HOME = env.FLOWRUNNER_HOME;
  const args = [process.execPath, "--disable-warning=ExperimentalWarning", BIN, "tick"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key><integer>${String(tickMinutes * 60)}</integer>
  <key>StandardOutPath</key><string>${xml(join(home, "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "tick.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
</dict>
</plist>
`;
}

const domain = () => `gui/${String(userInfo().uid)}`;

export async function installLaunchd(env: NodeJS.ProcessEnv) {
  const minutes = loadGlobalConfig(env).tick_minutes;
  const file = plistPath(env);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, plistFor(env, minutes));
  await runProc("launchctl", ["bootout", domain(), file], { cwd: process.cwd(), env });
  const load = await runProc("launchctl", ["bootstrap", domain(), file], {
    cwd: process.cwd(),
    env,
  });
  if (load.code !== 0) throw new Error(`launchctl no pudo cargar ${file}: ${load.stderr.trim()}`);
  return { ok: true as const, plist: file, cada_minutos: minutes };
}

export async function uninstallLaunchd(env: NodeJS.ProcessEnv) {
  const file = plistPath(env);
  if (existsSync(file)) {
    await runProc("launchctl", ["bootout", domain(), file], { cwd: process.cwd(), env });
    rmSync(file);
  }
  return { ok: true as const, plist: file };
}
