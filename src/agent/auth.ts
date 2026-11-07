// De dónde sale la credencial de cada sesión (ADR 0005). En producción, el token de
// `claude setup-token` guardado en el Keychain, o la sesión de Claude Code si la persona lo eligió.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalConfig } from "../config/load.ts";
import type { SessionAuth } from "./env.ts";

export const KEYCHAIN_SERVICE = "flowrunner";
export const KEYCHAIN_ACCOUNT = "claude-oauth-token";

export class AuthError extends Error {
  constructor() {
    super(
      `no hay token de Claude en el Keychain (servicio ${KEYCHAIN_SERVICE}). Generalo con ` +
        "`claude setup-token` y guardalo con " +
        `\`security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w\``,
    );
    this.name = "AuthError";
  }
}

export function readKeychainToken(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const token = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

/** El modo de la config global en `home`; sin config todavía, el token. */
function configuredAuth(env: NodeJS.ProcessEnv, home: string): "token" | "login" {
  if (!existsSync(join(home, "config.yaml"))) return "token";
  return loadGlobalConfig({ ...env, FLOWRUNNER_HOME: home }).auth;
}

/** `auth: login` en la config global usa la sesión de Claude Code de la persona;
 * `FLOWRUNNER_AUTH=login` hace lo mismo sin leer la config, para los tests. */
export function resolveAuth(env: NodeJS.ProcessEnv, home: string): SessionAuth {
  if (env.FLOWRUNNER_AUTH === "login" || configuredAuth(env, home) === "login") {
    return { kind: "login" };
  }
  const token = readKeychainToken(env);
  if (token === undefined) throw new AuthError();
  return { kind: "token", token, configDir: join(home, "claude") };
}
