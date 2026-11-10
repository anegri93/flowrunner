// flowrunner init: infiere la config de un repo real, comprueba la base y, con --aplicar, deja la
// máquina y el repo listos. Con repos en tmpdir, el gh y el claude falsos, y un HOME de prueba.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { beforeAll, describe, expect, test } from "vitest";
import { conApp, type Fuente, fuenteClonada } from "./helpers/app.ts";
import { type CliResult, runCliFrom, TEST_BIN } from "./helpers/cli.ts";
import { git, repoWithRemote, tempDir } from "./helpers/git.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { SIM_HOOKS } from "./helpers/sim-world.ts";

const LOCK = JSON.stringify({
  name: "pizarra",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "pizarra" } },
});

// init --aplicar instala el flowrunner que corre con self-update, que hace fetch y `worktree add` sobre
// el repo del código que corre: el CLI corre desde un clon, nunca desde el checkout real.
let fuente: Fuente;
beforeAll(() => {
  fuente = fuenteClonada();
});
const runCli = (args: readonly string[], env: NodeJS.ProcessEnv): CliResult =>
  runCliFrom(fuente.repo, args, env);

const GRAFT_DIR = dirname(
  execFileSync("sh", ["-c", "command -v graft"], { encoding: "utf8" }).trim(),
);
const SYSTEM_BIN = [GRAFT_DIR, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** El borrador que redacta la sesión simulada: cita archivos del repo de prueba. */
function draftScript(fuente = "servidor/api.ts"): SimScript {
  return {
    match: "Sos el que arma el cerebro",
    calls: [{ tool: "Read", input: { file_path: "servidor/api.ts" } }],
    output: {
      convenciones: {
        texto: "- Los errores de la API salen como `ErrorDeApi`, como en `servidor/api.ts`.",
        fuentes: [fuente],
      },
      contexto: {
        texto: "### Qué reusar antes de escribir\n\n- `servidor/api.ts`: el cliente HTTP.",
        fuentes: ["servidor/api.ts"],
      },
      que_es_bien: {
        texto: "- Cada endpoint nuevo trae su test al lado, como `servidor/api.test.ts`.",
        fuentes: ["servidor/api.test.ts"],
      },
    },
  };
}

function world(
  testScript = "node -e 0",
  draft = draftScript(),
  extra: Readonly<Record<string, string>> = {},
) {
  const { work, remote } = repoWithRemote({
    "package.json": JSON.stringify({ name: "pizarra", scripts: { test: testScript } }),
    "package-lock.json": LOCK,
    "vitest.config.ts": "export default {};\n",
    "servidor/api.ts": "export class ErrorDeApi extends Error {}\n",
    "servidor/api.test.ts": "// test\n",
    ...extra,
  });
  const scripts = join(tempDir("init-guiones-"), "guiones.json");
  writeFileSync(scripts, JSON.stringify([draft]));
  const home = tempDir("init-home-");
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const env: NodeJS.ProcessEnv = conApp({
    HOME: home,
    // Un PATH armado a mano: el real puede tener un flowrunner ya instalado por la persona, y vitest
    // expone el propio en node_modules/.bin; en los dos casos init lo daría por instalado.
    PATH: [TEST_BIN, localBin, dirname(process.execPath), ...SYSTEM_BIN].join(":"),
    USER: process.env.USER ?? "test",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    FAKE_LOG_DIR: tempDir("init-logs-"),
    FLOWRUNNER_LAUNCH_AGENTS: tempDir("init-agents-"),
    // El SDK simulado: la sesión del borrador corre de verdad, con el guion de `draft`.
    FLOWRUNNER_TEST_HOOKS: SIM_HOOKS,
    FAKE_SIM_SCRIPTS: scripts,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  return { work, remote, home, env };
}

interface Paso {
  que: string;
  estado: string;
  detalle: string;
}
const pasos = (stdout: string) => (JSON.parse(stdout) as { pasos: Paso[] }).pasos;
const paso = (stdout: string, que: string) => pasos(stdout).find((p) => p.que === que);
const remoteBranches = (remote: string) => git(remote, "branch", "--format=%(refname:short)");
const brainFile = (remote: string, file: string) =>
  git(remote, "show", `chore/flowrunner-init:.flowrunner/${file}`);
const template = (file: string) =>
  readFileSync(join(import.meta.dirname, "..", "templates", "brain", file), "utf8").trimEnd();
const prBody = (env: NodeJS.ProcessEnv) =>
  (
    JSON.parse(readFileSync(join(env.FAKE_LOG_DIR ?? "", "gh-state.json"), "utf8")) as {
      prs: { body: string }[];
    }
  ).prs[0]?.body ?? "";

describe("init", () => {
  // Si regresiona, mirar el informe de init ya cambia la máquina o el repo de la persona.
  test("sin --aplicar infiere y comprueba la base, pero no escribe nada", () => {
    const w = world();
    const out = runCli(["init", w.work, "--json"], w.env);
    expect(out.stderr).toBe("");
    expect(paso(out.stdout, "setup")).toMatchObject({ estado: "inferido" });
    expect(paso(out.stdout, "setup")?.detalle).toContain("npm ci");
    expect(paso(out.stdout, "base en verde")).toMatchObject({ estado: "ok" });
    expect(paso(out.stdout, "auth")).toMatchObject({ estado: "inferido", detalle: "login" });
    expect(existsSync(join(w.home, ".flowrunner", "config.yaml"))).toBe(false);
    expect(
      existsSync(join(w.env.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist")),
    ).toBe(false);
    expect(existsSync(join(w.home, ".claude"))).toBe(false);
    expect(remoteBranches(w.remote)).toBe("main");
    // Si regresiona, mirar el informe cuesta una sesión del modelo.
    expect(existsSync(join(w.home, "prompts.log"))).toBe(false);
  }, 120_000);

  // Si regresiona, el cerebro llega vacío y los runs no siguen la lógica que el repo ya tiene.
  test("con --aplicar redacta convenciones, contexto y qué es bien con lo que leyó del repo", () => {
    const w = world();
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(paso(out.stdout, "borrador del cerebro")).toMatchObject({ estado: "inferido" });

    const convenciones = brainFile(w.remote, "convenciones.md");
    expect(convenciones.startsWith(template("convenciones.md"))).toBe(true);
    expect(convenciones).toContain("## Borrador de flowrunner init");
    expect(convenciones).toContain("Los errores de la API salen como `ErrorDeApi`");
    expect(convenciones).toMatch(/del repo en `[0-9a-f]{7,}` el \d{4}-\d\d-\d\d/);
    expect(brainFile(w.remote, "contexto.md")).toContain("### Qué reusar antes de escribir");
    expect(brainFile(w.remote, "que-es-bien.md")).toContain("como `servidor/api.test.ts`");
    expect(prBody(w.env)).toContain("traen un borrador que init dedujo");

    // La sesión recibió el repo real: sus archivos y sus commits.
    const prompt = readFileSync(join(w.home, "prompts.log"), "utf8");
    expect(prompt).toContain("Sos el que arma el cerebro");
    expect(prompt).toContain("servidor/api.ts");
    expect(prompt).toContain("inicial");
  }, 120_000);

  // Regresión: en mango-portal-colaborador el borrador ignoró CLAUDE.md y verify.sh salió sin los
  // e2e que corre el CI, y nada en la PR lo decía.
  test("le pasa a la sesión la documentación del repo y avisa lo que el CI corre y verify no", () => {
    const ci =
      "jobs:\n  ci:\n    steps:\n      - run: npm ci\n      - run: npm test\n      - run: npm run e2e\n";
    const w = world("node -e 0", draftScript(), {
      "CLAUDE.md": "# Reglas\n",
      "docs/adr/0001-dinero.md": "# Dinero en enteros\n",
      ".github/workflows/ci.yml": ci,
    });
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(paso(out.stdout, "verify contra CI")?.detalle).toContain("`npm run e2e`");
    expect(paso(out.stdout, "verify contra CI")?.detalle).not.toContain("`npm test`");
    expect(prBody(w.env)).toContain("el CI corre y verify.sh no: `npm run e2e`");

    const prompt = readFileSync(join(w.home, "prompts.log"), "utf8");
    const docs = prompt.slice(prompt.indexOf("# Documentación del repo"));
    expect(docs.slice(0, docs.indexOf("# Lo que ya dice el cerebro"))).toMatch(
      /CLAUDE\.md\n\.github\/workflows\/ci\.yml\ndocs\/adr\/0001-dinero\.md/,
    );
    // Y la sesión supo del hueco, para anotarlo en contexto.
    expect(prompt).toContain("verify contra CI");
  }, 120_000);

  // Si regresiona, la PR del cerebro afirma reglas sobre archivos que no existen en el repo.
  test("si el borrador cita un archivo que no existe, quedan las plantillas y la PR igual se abre", () => {
    const w = world("node -e 0", draftScript("servidor/inventado.ts"));
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(paso(out.stdout, "borrador del cerebro")).toMatchObject({ estado: "pendiente" });
    expect(paso(out.stdout, "borrador del cerebro")?.detalle).toContain("servidor/inventado.ts");
    for (const file of ["convenciones.md", "contexto.md", "que-es-bien.md"]) {
      expect(brainFile(w.remote, file)).toBe(template(file));
    }
    expect(paso(out.stdout, "PR del cerebro")?.detalle).toMatch(/pull\/412/);
    expect(prBody(w.env)).toContain("completá `contexto.md`");
  }, 120_000);

  // Si regresiona, la persona tiene que hacer a mano los nueve pasos de la puesta en marcha.
  test("con --aplicar deja todo listo, y correrlo otra vez no duplica nada", () => {
    const w = world();
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);

    const config = parse(
      git(w.remote, "show", "chore/flowrunner-init:.flowrunner/config.yaml"),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      setup: "npm ci",
      tests_globs: ["servidor/**/*.test.ts"],
      harness_files: ["vitest.config.ts"],
    });
    expect(git(w.remote, "show", "chore/flowrunner-init:.flowrunner/verify.sh")).toContain(
      "npm run test",
    );
    expect(git(w.remote, "ls-tree", "chore/flowrunner-init", ".flowrunner/verify.sh")).toMatch(
      /^100755/,
    );
    const global = parse(readFileSync(join(w.home, ".flowrunner", "config.yaml"), "utf8")) as {
      github_user: string;
      auth: string;
      projects: { name: string; path: string }[];
    };
    expect(global.github_user).toBe("anegri93");
    expect(global.auth).toBe("login");
    expect(global.projects.map((p) => p.path)).toEqual([
      git(w.work, "rev-parse", "--show-toplevel"),
    ]);
    expect(
      existsSync(join(w.env.FLOWRUNNER_LAUNCH_AGENTS ?? "", "com.flowrunner.tick.plist")),
    ).toBe(true);
    expect(existsSync(join(w.home, ".claude", "skills", "flowrunner", "SKILL.md"))).toBe(true);
    expect(paso(out.stdout, "flowrunner instalado en ~/.flowrunner/app"), out.stdout).toMatchObject(
      { estado: "hecho" },
    );
    expect(realpathSync(join(w.home, ".local", "bin", "flowrunner"))).toBe(
      realpathSync(join(w.home, ".flowrunner", "app", "bin", "flowrunner.js")),
    );
    expect(paso(out.stdout, "PR del cerebro")?.detalle).toMatch(/pull\/412/);

    const again = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(again.status).toBe(0);
    const state = JSON.parse(
      readFileSync(join(w.env.FAKE_LOG_DIR ?? "", "gh-state.json"), "utf8"),
    ) as {
      prs: unknown[];
    };
    expect(state.prs).toHaveLength(1);
    const after = parse(readFileSync(join(w.home, ".flowrunner", "config.yaml"), "utf8")) as {
      projects: unknown[];
    };
    expect(after.projects).toHaveLength(1);

    // Una skill vieja, como la que deja un flowrunner anterior, se ve pendiente y --aplicar la renueva.
    appendFileSync(join(w.home, ".claude", "skills", "flowrunner", "SKILL.md"), "\nvieja\n");
    expect(
      paso(runCli(["init", w.work, "--json"], w.env).stdout, "skill de Claude Code"),
    ).toMatchObject({
      estado: "pendiente",
    });
    const renewed = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(paso(renewed.stdout, "skill de Claude Code")).toMatchObject({ estado: "hecho" });
  }, 180_000);

  // Si regresiona, init da por instalado un comando que no quedó en ningún lado del PATH.
  test("sin ~/.local/bin en el PATH, el paso de la app falta y dice qué hacer", () => {
    const w = world();
    const localBin = join(w.home, ".local", "bin");
    w.env.PATH = (w.env.PATH ?? "")
      .split(":")
      .filter((d) => d !== localBin)
      .join(":");
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status).toBe(1);
    expect(paso(out.stdout, "flowrunner instalado en ~/.flowrunner/app")).toMatchObject({
      estado: "falta",
      detalle: "agregá ~/.local/bin a tu PATH",
    });
  }, 120_000);

  // Si regresiona, init abre una PR sobre una base roja y el primer run se detiene en preparar.
  test("con la base en rojo, --aplicar sale 1 y no empuja nada", () => {
    const w = world("node -e 'process.exit(1)'");
    const out = runCli(["init", w.work, "--aplicar", "--json"], w.env);
    expect(out.status).toBe(1);
    expect(paso(out.stdout, "base en verde")).toMatchObject({ estado: "falta" });
    // Si regresiona, la línea de la PR desaparece y nada dice que no se abrió.
    expect(paso(out.stdout, "PR del cerebro")).toMatchObject({
      estado: "pendiente",
      detalle: "no se abre hasta que origin/main esté en verde",
    });
    expect(remoteBranches(w.remote)).toBe("main");
  }, 120_000);

  test("si el cerebro ya está en la base, no lo infiere de nuevo", () => {
    const w = world();
    mkdirSync(join(w.work, ".flowrunner"), { recursive: true });
    execFileSync("sh", ["-c", "echo 'setup: \"true\"' > .flowrunner/config.yaml"], { cwd: w.work });
    git(w.work, "add", "-A");
    git(w.work, "commit", "-qm", "cerebro");
    git(w.work, "push", "-q", "origin", "main");
    const out = runCli(["init", w.work, "--json"], w.env);
    expect(paso(out.stdout, "cerebro del repo")).toMatchObject({ estado: "ya estaba" });
    // Si regresiona, nada le dice a la persona cómo pedir el borrador para un cerebro existente.
    expect(paso(out.stdout, "cerebro del repo")?.detalle).toContain("flowrunner brain draft");
    expect(paso(out.stdout, "setup")).toBeUndefined();
  }, 120_000);

  // Regresión: con el borrador ya mergeado en videoFactory, init seguía sugiriendo correr
  // `brain draft`, y al correrlo la persona recibía «ya tiene un borrador».
  test("si el cerebro de la base ya tiene el borrador, no sugiere pedir otro", () => {
    const w = world();
    mkdirSync(join(w.work, ".flowrunner"), { recursive: true });
    writeFileSync(join(w.work, ".flowrunner", "config.yaml"), 'setup: "true"\n');
    writeFileSync(
      join(w.work, ".flowrunner", "convenciones.md"),
      "# Convenciones\n\n## Borrador de flowrunner init\n\n- algo\n",
    );
    git(w.work, "add", "-A");
    git(w.work, "commit", "-qm", "cerebro con borrador");
    git(w.work, "push", "-q", "origin", "main");
    const out = runCli(["init", w.work, "--json"], w.env);
    expect(paso(out.stdout, "cerebro del repo")).toMatchObject({
      estado: "ya estaba",
      detalle: "en origin/main, con el borrador leído del código",
    });
  }, 120_000);
});

const PERSONA = "- Regla de la persona: los handlers no tocan la base directo.";

/** Un repo que ya usa flowrunner: el cerebro de las plantillas en main, con `convenciones` propio. */
function withBrain(w: ReturnType<typeof world>, convenciones: string) {
  // Ya pasó por init, así que la config global dice cómo autenticar; acá alcanza con la costura de test.
  w.env.FLOWRUNNER_AUTH = "login";
  runCli(["brain", "init", w.work], w.env);
  writeFileSync(join(w.work, ".flowrunner", "convenciones.md"), convenciones);
  git(w.work, "add", "-A");
  git(w.work, "commit", "-qm", "cerebro");
  git(w.work, "push", "-q", "origin", "main");
}

interface Drafted {
  ok: boolean;
  paso: Paso;
}
const drafted = (stdout: string) => JSON.parse(stdout) as Drafted;
const DRAFT_REF = "chore/flowrunner-borrador:.flowrunner";

describe("brain draft", () => {
  // Si regresiona, un repo que ya usaba flowrunner se queda sin borrador, o lo pierde todo al pedirlo.
  test("en un repo que ya usa flowrunner propone el borrador en su PR y conserva lo de la persona", () => {
    const w = world();
    const mine = `${template("convenciones.md")}\n${PERSONA}\n`;
    withBrain(w, mine);
    const out = runCli(["brain", "draft", w.work, "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    // Con --json el avance no se mezcla con lo que lee la skill.
    expect(out.stderr).toBe("");
    expect(drafted(out.stdout).paso).toMatchObject({ estado: "hecho" });
    expect(drafted(out.stdout).paso.detalle).toMatch(/pull\/412/);

    const convenciones = git(w.remote, "show", `${DRAFT_REF}/convenciones.md`);
    expect(convenciones.startsWith(mine.trimEnd())).toBe(true);
    expect(convenciones).toContain("## Borrador de flowrunner init");
    expect(convenciones).toContain("Los errores de la API salen como `ErrorDeApi`");
    expect(git(w.remote, "show", `${DRAFT_REF}/contexto.md`)).toContain("Qué reusar");
    expect(prBody(w.env)).toContain("`flowrunner brain draft` dedujo del repo");
    // La sesión vio lo que ya decía el cerebro, para no repetirlo.
    expect(readFileSync(join(w.home, "prompts.log"), "utf8")).toContain(PERSONA);

    // Con la PR abierta, pedirlo otra vez no abre otra ni gasta otra sesión.
    const again = runCli(["brain", "draft", w.work, "--json"], w.env);
    expect(again.status).toBe(0);
    expect(drafted(again.stdout).paso).toMatchObject({ estado: "ya estaba" });
    const state = JSON.parse(
      readFileSync(join(w.env.FAKE_LOG_DIR ?? "", "gh-state.json"), "utf8"),
    ) as { prs: unknown[] };
    expect(state.prs).toHaveLength(1);
    expect(readFileSync(join(w.home, "prompts.log"), "utf8").split("\n---\n")).toHaveLength(2);
  }, 120_000);

  // Si regresiona, la persona mira una terminal muda durante minutos y no sabe si se colgó.
  test("en la terminal muestra cada etapa y lo que Claude va leyendo", () => {
    const w = world();
    withBrain(w, `${template("convenciones.md")}\n${PERSONA}\n`);
    const out = runCli(["brain", "draft", w.work], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const lines = out.stderr.trimEnd().split("\n");
    expect(
      lines.every((l) => /^\[\d+:\d\d\] /.test(l)),
      out.stderr,
    ).toBe(true);
    const said = lines.map((l) => l.replace(/^\[\d+:\d\d\] /, ""));
    expect(said).toEqual([
      "trayendo origin",
      "preparando un worktree limpio de origin/main",
      expect.stringMatching(/^Claude lee el código y redacta el borrador/),
      "  lee servidor/api.ts",
      "abriendo la PR en chore/flowrunner-borrador",
    ]);
    expect(out.stdout).toMatch(/^borrador del cerebro: .*pull\/412/);
  }, 120_000);

  // Si regresiona, cada pedido apila otro borrador sobre el que la persona ya revisó.
  test("si la base ya tiene un borrador de init, no pide otro", () => {
    const w = world();
    withBrain(w, `${template("convenciones.md")}\n\n## Borrador de flowrunner init\n\n- algo\n`);
    const out = runCli(["brain", "draft", w.work, "--json"], w.env);
    expect(out.status).toBe(0);
    expect(drafted(out.stdout).paso).toMatchObject({ estado: "ya estaba" });
    expect(drafted(out.stdout).paso.detalle).toContain("--reemplazar");
    expect(existsSync(join(w.home, "prompts.log"))).toBe(false);
    expect(remoteBranches(w.remote)).toBe("main");
  }, 120_000);

  // Si regresiona, un borrador de una versión vieja de init no se puede rehacer sin dos PRs: una que
  // borra la sección y otra que pide el nuevo.
  test("con --reemplazar cambia el borrador de la base por uno nuevo y conserva lo de la persona", () => {
    const w = world();
    const mine = `${template("convenciones.md")}\n${PERSONA}\n`;
    withBrain(w, `${mine}\n## Borrador de flowrunner init\n\n- regla vieja del borrador\n`);
    const out = runCli(["brain", "draft", w.work, "--reemplazar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(drafted(out.stdout).paso).toMatchObject({ estado: "hecho" });

    const convenciones = git(w.remote, "show", `${DRAFT_REF}/convenciones.md`);
    expect(convenciones.startsWith(mine.trimEnd())).toBe(true);
    expect(convenciones).not.toContain("regla vieja del borrador");
    expect(convenciones.split("## Borrador de flowrunner init")).toHaveLength(2);
    expect(convenciones).toContain("Los errores de la API salen como `ErrorDeApi`");
    expect(prBody(w.env)).toContain("reemplaza al borrador anterior");
    // La sesión no vio el borrador viejo como si fuera lo que escribió la persona.
    expect(readFileSync(join(w.home, "prompts.log"), "utf8")).not.toContain(
      "regla vieja del borrador",
    );
  }, 120_000);

  // Regresión: en mango-portal-colaborador --reemplazar dejó arriba la plantilla vieja, que dice que
  // toda convención bloquea, encima de un borrador con marcas de severidad.
  test("con --reemplazar, una plantilla vieja que nadie editó pasa a la de hoy", () => {
    const w = world();
    const old =
      "# Convenciones del repo\n\nReglas que planificar, implementar y revisar aplican. Una violación es un bloqueante en la revisión.\nEscribí reglas concretas y verificables, con un ejemplo cuando ayude.\n\n-\n";
    withBrain(w, `${old}\n## Borrador de flowrunner init\n\n- regla vieja del borrador\n`);
    const out = runCli(["brain", "draft", w.work, "--reemplazar", "--json"], w.env);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const convenciones = git(w.remote, "show", `${DRAFT_REF}/convenciones.md`);
    expect(convenciones.startsWith(template("convenciones.md"))).toBe(true);
    expect(convenciones).not.toContain("Una violación es un bloqueante");
  }, 120_000);

  // Si regresiona, el borrador deja un archivo pasado de tope y el próximo run no carga el cerebro.
  test("si con el borrador un archivo pasa su tope, no empuja nada", () => {
    const w = world();
    // A 100 caracteres del tope de 16.000: carga hoy, pero no le entra la sección del borrador.
    const start = `${template("convenciones.md")}\n- `;
    withBrain(w, `${start}${"r".repeat(15_900 - Array.from(start).length)}\n`);
    const out = runCli(["brain", "draft", w.work, "--json"], w.env);
    expect(out.status).toBe(1);
    expect(drafted(out.stdout).paso).toMatchObject({ estado: "falta" });
    expect(drafted(out.stdout).paso.detalle).toContain("convenciones.md pasaría su tope");
    expect(remoteBranches(w.remote)).toBe("main");
  }, 120_000);

  // Si regresiona, el comando arma un cerebro a medias en un repo que nunca pasó por init.
  test("sin cerebro en la base, pide correr init", () => {
    const w = world();
    const out = runCli(["brain", "draft", w.work, "--json"], w.env);
    expect(out.status).toBe(1);
    expect(drafted(out.stdout).paso).toMatchObject({ estado: "falta" });
    expect(drafted(out.stdout).paso.detalle).toContain("--aplicar");
    expect(existsSync(join(w.home, "prompts.log"))).toBe(false);
  }, 120_000);
});
