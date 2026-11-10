// T7.4: flowrunner doctor y el job de launchd, con binarios falsos y un LaunchAgents de prueba.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { plistFor } from "../src/cli/launchd.ts";
import { conApp, type Fuente, fuenteClonada } from "./helpers/app.ts";
import { homeWith, runCli, runCliFrom } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...homeWith("github_user: yo\ntick_minutes: 7\nprojects: []\n"),
    FLOWRUNNER_LAUNCH_AGENTS: tempDir("launch-agents-"),
    ...extra,
  };
}

let fuente: Fuente;
beforeAll(() => {
  fuente = fuenteClonada();
});

/** Con todo presente, el flowrunner que corre es el de la app: lo instala `self-update`. */
function installApp(e: NodeJS.ProcessEnv): void {
  const out = runCliFrom(fuente.repo, ["self-update"], e);
  expect(out.status, out.stdout + out.stderr).toBe(0);
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

  // Si regresiona, doctor le exige un token a quien eligió su login, o da por buena una sesión cerrada.
  test(
    "con auth: login, el chequeo es la sesión de Claude Code y no el token",
    { timeout: 120_000 },
    () => {
      const e = conApp({
        ...homeWith("github_user: yo\nauth: login\nprojects: []\n"),
        FLOWRUNNER_LAUNCH_AGENTS: tempDir("launch-agents-"),
      });
      expect(runCli(["launchd", "install"], e).status).toBe(0);
      installApp(e);
      const ok = runCli(["doctor", "--json"], e);
      expect(checks(ok.stdout).filter((c) => !c.ok)).toEqual([]);
      expect(checks(ok.stdout).map((c) => c.nombre)).toContain("sesión de Claude Code");
      const out = runCli(["doctor"], { ...e, FAKE_CLAUDE_LOGGED_OUT: "1" });
      expect(out.status).toBe(1);
      expect(out.stdout).toMatch(/✗ sesión de Claude Code: abrí `claude` y corré `\/login`/);
    },
  );

  test("con todo presente y el job instalado: sale 0", { timeout: 120_000 }, () => {
    const e = conApp(env({ FAKE_KEYCHAIN_TOKEN: "t" }));
    expect(runCli(["launchd", "install"], e).status).toBe(0);
    installApp(e);
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
