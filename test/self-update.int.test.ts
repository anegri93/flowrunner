// flowrunner self-update: el flowrunner que corre runs vive en un worktree fijo, separado del checkout
// de desarrollo (ADR 0020). Con un clon del repo como fuente, un HOME de prueba y launchctl y Orca falsos.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { conApp, fuenteClonada } from "./helpers/app.ts";
import { runCliFrom } from "./helpers/cli.ts";
import { git, tempDir } from "./helpers/git.ts";

function world() {
  const fuente = fuenteClonada();
  const home = realpathSync(tempDir("self-update-home-"));
  const flowrunnerHome = realpathSync(tempDir("self-update-fr-"));
  writeFileSync(join(flowrunnerHome, "config.yaml"), "github_user: yo\ntick_minutes: 7\n");
  const env = conApp({
    HOME: home,
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "test",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    FLOWRUNNER_HOME: flowrunnerHome,
    FLOWRUNNER_LAUNCH_AGENTS: realpathSync(tempDir("self-update-agents-")),
    FAKE_LOG_DIR: tempDir("self-update-logs-"),
  });
  const app = join(flowrunnerHome, "app");
  return {
    ...fuente,
    env,
    home,
    app,
    appBin: join(app, "bin", "flowrunner.js"),
    plist: join(env.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist"),
  };
}

interface Updated {
  ok: boolean;
  app: string;
  sha: string;
  creado: boolean;
  reapuntado: string[];
}

function selfUpdate(w: ReturnType<typeof world>): Updated {
  const out = runCliFrom(w.repo, ["self-update", "--json"], w.env);
  expect(out.status, out.stdout + out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Updated;
}

describe("self-update", () => {
  // Si regresiona, el comando, el tick o la skill siguen corriendo el checkout donde se desarrolla.
  test("self-update crea la app en origin/main y apunta el comando, launchd y la skill ahí", () => {
    const w = world();
    // launchd instalado desde el checkout, como lo dejaba un flowrunner de antes.
    expect(runCliFrom(w.repo, ["launchd", "install"], w.env).status).toBe(0);
    expect(readFileSync(w.plist, "utf8")).toContain(join(w.repo, "bin", "flowrunner.js"));

    const updated = selfUpdate(w);
    expect(updated).toMatchObject({ ok: true, app: w.app, creado: true });
    expect(git(w.app, "rev-parse", "HEAD")).toBe(git(w.repo, "rev-parse", "origin/main"));
    expect(updated.sha).toBe(git(w.repo, "rev-parse", "origin/main"));
    expect(realpathSync(join(w.home, ".local", "bin", "flowrunner"))).toBe(w.appBin);
    const plist = readFileSync(w.plist, "utf8");
    expect(plist).toContain(w.appBin);
    expect(plist).not.toContain(join(w.repo, "bin", "flowrunner.js"));
    // La skill y su hook SessionStart salen de la app.
    expect(readFileSync(join(w.home, ".claude", "skills", "flowrunner", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(w.app, "skills", "flowrunner", "SKILL.md"), "utf8"),
    );
    expect(readFileSync(join(w.home, ".claude", "settings.json"), "utf8")).toContain(w.appBin);
    // Orca carga el plugin de la app.
    expect(readFileSync(join(w.env.FAKE_LOG_DIR ?? "", "orca.log"), "utf8")).toContain(
      join(w.app, "orca"),
    );
  }, 120_000);

  // Regresión de ML-1: alguien cambió de rama en el checkout con un run en curso, y el run leyó la
  // plantilla de revisar de otra rama.
  test("cambiar de rama en el checkout no cambia el prompt que lee la app", () => {
    const w = world();
    selfUpdate(w);
    const before = readFileSync(join(w.app, "prompts", "revisar.md"), "utf8");
    git(w.repo, "switch", "-q", "-c", "otra-rama");
    writeFileSync(join(w.repo, "prompts", "revisar.md"), "una plantilla de otra rama\n");
    git(w.repo, "commit", "-q", "-am", "otra plantilla");
    expect(readFileSync(join(w.repo, "prompts", "revisar.md"), "utf8")).toBe(
      "una plantilla de otra rama\n",
    );
    expect(readFileSync(join(w.app, "prompts", "revisar.md"), "utf8")).toBe(before);
  }, 120_000);

  // Si regresiona, actualizar le cambia el código a un run que está corriendo.
  test("self-update se niega con un run corriendo y lo nombra", () => {
    const w = world();
    const lugares = join(w.env.FLOWRUNNER_HOME ?? "", "locks", "acme", "lugares");
    mkdirSync(lugares, { recursive: true });
    writeFileSync(join(lugares, "R-1.json"), JSON.stringify({ run_id: "R-1", pid: process.pid }));
    const out = runCliFrom(w.repo, ["self-update", "--json"], w.env);
    expect(out.status).toBe(1);
    const error = (JSON.parse(out.stdout) as { error: { message: string } }).error;
    expect(error.message).toContain("R-1");
    expect(git(w.repo, "worktree", "list", "--porcelain")).not.toContain(w.app);
  }, 120_000);

  // Si regresiona, self-update deja la app en la versión de la primera instalación.
  test("self-update mueve una app existente a origin/main nuevo", () => {
    const w = world();
    const first = selfUpdate(w);
    writeFileSync(join(w.repo, "NUEVO.md"), "algo nuevo en main\n");
    git(w.repo, "add", "NUEVO.md");
    git(w.repo, "commit", "-q", "-m", "algo nuevo");
    git(w.repo, "push", "-q", "origin", "HEAD:main");
    const nuevo = git(w.repo, "rev-parse", "HEAD");
    expect(nuevo).not.toBe(first.sha);

    // Desde la app, como lo corre la persona con el comando del PATH.
    const out = runCliFrom(w.app, ["self-update", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, sha: nuevo, creado: false });
    expect(git(w.app, "rev-parse", "HEAD")).toBe(nuevo);
    expect(readFileSync(join(w.app, "NUEVO.md"), "utf8")).toBe("algo nuevo en main\n");
  }, 120_000);

  // Si regresiona, cada sesión de Claude Code corre dos hooks, y uno es el del checkout.
  test("self-update deja un solo hook SessionStart, el de la app", () => {
    const w = world();
    expect(runCliFrom(w.repo, ["skill", "install", "--confirmar"], w.env).status).toBe(0);
    selfUpdate(w);
    const settings = JSON.parse(readFileSync(join(w.home, ".claude", "settings.json"), "utf8")) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(w.appBin);
    // Instalar la skill otra vez desde el checkout no le saca su hook a la app.
    expect(runCliFrom(w.repo, ["skill", "install", "--confirmar"], w.env).status).toBe(0);
    expect(readFileSync(join(w.home, ".claude", "settings.json"), "utf8")).toContain(w.appBin);
  }, 120_000);

  // Si regresiona, borrar la app para empezar de cero deja self-update fallando hasta un prune a mano.
  test("self-update rehace la app si se borró su carpeta", () => {
    const w = world();
    selfUpdate(w);
    rmSync(w.app, { recursive: true, force: true });
    const again = selfUpdate(w);
    expect(again).toMatchObject({ ok: true, creado: true });
    expect(git(w.app, "rev-parse", "HEAD")).toBe(git(w.repo, "rev-parse", "origin/main"));
  }, 120_000);
});
