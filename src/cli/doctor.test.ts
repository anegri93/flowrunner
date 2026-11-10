import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appCheck, nodeSupported } from "./doctor.ts";

describe("nodeSupported", () => {
  // Si regresiona, doctor e init rechazan un Node más nuevo que corre flowrunner sin problemas.
  test("acepta Node 24 y cualquier versión más nueva; rechaza las anteriores", () => {
    expect(nodeSupported("24.0.0")).toBe(true);
    expect(nodeSupported("26.6.0")).toBe(true);
    expect(nodeSupported("22.11.0")).toBe(false);
  });
});

describe("appCheck", () => {
  // Si regresiona, un comando que corre el checkout de desarrollo pasa por bueno y un cambio de rama
  // ahí le cambia los prompts a un run en curso (ML-1).
  test("doctor marca el link que no apunta a la app", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-app-")));
    const home = join(root, "home");
    const localBin = join(home, ".local", "bin");
    const agents = join(root, "agents");
    const appBin = join(root, "flowrunner", "app", "bin", "flowrunner.js");
    const checkoutBin = join(root, "checkout", "bin", "flowrunner.js");
    for (const file of [appBin, checkoutBin]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "// bin\n");
    }
    mkdirSync(localBin, { recursive: true });
    mkdirSync(agents);
    const env = {
      HOME: home,
      PATH: `${localBin}:/usr/bin`,
      FLOWRUNNER_HOME: join(root, "flowrunner"),
      FLOWRUNNER_LAUNCH_AGENTS: agents,
    };
    const link = join(localBin, "flowrunner");
    const plist = join(agents, "com.flowrunner.tick.plist");

    symlinkSync(checkoutBin, link);
    const check = appCheck(env);
    expect(check.ok).toBe(false);
    expect(check.nombre).toBe("flowrunner corre desde ~/.flowrunner/app");
    expect(check.arreglo).toContain("flowrunner self-update");

    // Con el link en la app, pasa; un plist que corre otro bin, o ~/.local/bin fuera del PATH, falla.
    rmSync(link);
    symlinkSync(appBin, link);
    expect(appCheck(env).ok).toBe(true);
    writeFileSync(plist, `<string>${checkoutBin}</string>`);
    expect(appCheck(env).ok).toBe(false);
    writeFileSync(plist, `<string>${appBin}</string>`);
    expect(appCheck(env).ok).toBe(true);
    expect(appCheck({ ...env, PATH: "/usr/bin" }).ok).toBe(false);
  });
});
