// T7.4: flowrunner doctor y el job de launchd, con binarios falsos y un LaunchAgents de prueba.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plistFor } from "../src/cli/launchd.ts";
import { homeWith, runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...homeWith("github_user: yo\ntick_minutes: 7\nprojects: []\n"),
    FLOWRUNNER_LAUNCH_AGENTS: tempDir("launch-agents-"),
    ...extra,
  };
}

const checks = (stdout: string) =>
  (JSON.parse(stdout) as { checks: { nombre: string; ok: boolean; arreglo: string }[] }).checks;

describe("doctor", () => {
  // Si regresiona, un run se lanza en una máquina sin gh con sesión y se detiene recién al entregar.
  test("gh sin sesión: sale 1 y dice cómo arreglarlo", () => {
    const result = runCli(
      ["doctor", "--json"],
      env({ FAKE_GH_NOAUTH: "1", FAKE_KEYCHAIN_TOKEN: "t" }),
    );
    expect(result.status).toBe(1);
    expect(checks(result.stdout).find((c) => c.nombre === "gh con sesión")).toMatchObject({
      ok: false,
      arreglo: "corré `gh auth login`",
    });
  });

  test("sin token en el Keychain: sale 1 y sugiere claude setup-token", () => {
    const result = runCli(["doctor"], env());
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/✗ token de Claude en el Keychain: corré `claude setup-token`/);
  });

  test("con todo presente y el job instalado: sale 0", () => {
    const e = env({ FAKE_KEYCHAIN_TOKEN: "t" });
    expect(runCli(["launchd", "install"], e).status).toBe(0);
    const result = runCli(["doctor", "--json"], e);
    expect(checks(result.stdout).filter((c) => !c.ok)).toEqual([]);
    expect(result.status).toBe(0);
  });
});

describe("launchd", () => {
  // Si regresiona, el tick no corre nunca o corre con otra configuración que la de la persona.
  test("install escribe el plist esperado y lo carga con launchctl; uninstall lo quita", () => {
    const e = env({ FAKE_LOG_DIR: tempDir("logs-") });
    expect(runCli(["launchd", "install", "--json"], e).status).toBe(0);
    const plist = readFileSync(
      join(e.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist"),
      "utf8",
    );
    expect(plist).toBe(plistFor(e, 7));
    expect(plist).toContain("<key>StartInterval</key><integer>420</integer>");
    expect(plist).toMatch(/<string>tick<\/string>/);
    expect(plist).toContain(`<string>${join(e.HOME ?? "", ".flowrunner", "tick.log")}</string>`);
    const calls = readFileSync(join(e.FAKE_LOG_DIR ?? "", "launchctl.log"), "utf8");
    expect(calls).toMatch(
      /^bootout gui\/\d+ .*\nbootstrap gui\/\d+ .*com\.flowrunner\.tick\.plist\n$/,
    );
    expect(runCli(["launchd", "uninstall"], e).status).toBe(0);
    expect(() =>
      readFileSync(join(e.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist")),
    ).toThrow();
  });
});
