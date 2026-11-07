import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { homeWith } from "../../test/helpers/cli.ts";
import { AuthError, resolveAuth } from "./auth.ts";

const resolve = (yaml: string, extra: NodeJS.ProcessEnv = {}) => {
  const env = { ...homeWith(yaml), ...extra };
  return resolveAuth(env, join(env.HOME ?? "", ".flowrunner"));
};

describe("resolveAuth", () => {
  // Si regresiona, quien eligió su login de Claude Code no puede lanzar ningún run sin token.
  test("con auth: login usa la sesión de Claude Code aunque no haya token", () => {
    expect(resolve("github_user: yo\nauth: login\n")).toEqual({ kind: "login" });
  });

  test("por defecto pide el token del Keychain y sin token falla con AuthError", () => {
    expect(() => resolve("github_user: yo\n")).toThrow(AuthError);
    expect(resolve("github_user: yo\n", { FAKE_KEYCHAIN_TOKEN: "t" })).toMatchObject({
      kind: "token",
      token: "t",
    });
  });
});
