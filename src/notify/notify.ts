// El aviso de macOS. Una sesión de Claude Code no recibe eventos de afuera, así que el aviso le dice
// a la persona qué pedirle a Claude.
import { execFile } from "node:child_process";

/** Una cadena de AppleScript: comillas y barras escapadas. */
export function appleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function notifyMac(title: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
  // Un aviso que no sale no puede detener el run: el estado ya quedó en el log.
  execFile("osascript", ["-e", script], { env }, () => undefined);
}
