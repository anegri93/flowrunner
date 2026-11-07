// `flowrunner init <repo>`: revisa qué hay, infiere lo que se puede y dice lo que falta. Con
// `aplicar`, deja la máquina y el repo listos: config global, proyecto, skill, launchd, el comando en
// el PATH y una PR con el cerebro del repo. Cada paso es idempotente.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { readKeychainToken } from "../agent/auth.ts";
import { initBrain } from "../brain/brain.ts";
import { claudeLoggedIn, doctor } from "../cli/doctor.ts";
import { installLaunchd, plistPath } from "../cli/launchd.ts";
import { gitRootOf, projectNameFor, updateGlobalConfig } from "../cli/project.ts";
import { BIN } from "../cli/runs.ts";
import { ASK_RULES, installSkill } from "../cli/skill.ts";
import { flowrunnerHome, loadRepoConfig } from "../config/load.ts";
import { ConfigError } from "../config/schemas.ts";
import { fetchOrigin, git, GitError, pushBranch, removeWorktree } from "../git/git.ts";
import { createPr, findPr } from "../github/gh.ts";
import { runVerify } from "../phases/verify.ts";
import { runProc, runShell, tail } from "../proc/proc.ts";
import { inferRepo } from "./infer.ts";

export const INIT_BRANCH = "chore/flowrunner-init";
const SETUP_TIMEOUT_MS = 20 * 60_000;

export interface Paso {
  readonly que: string;
  readonly estado: "ya estaba" | "inferido" | "ok" | "hecho" | "pendiente" | "falta";
  readonly detalle: string;
}

interface Global {
  github_user?: unknown;
  auth?: unknown;
  projects?: { name: string; path: string }[];
}

function readGlobal(env: NodeJS.ProcessEnv): Global {
  const file = join(flowrunnerHome(env), "config.yaml");
  if (!existsSync(file)) return {};
  return (parse(readFileSync(file, "utf8")) as Global | null) ?? {};
}

async function defaultBranch(repo: string, env: NodeJS.ProcessEnv): Promise<string> {
  const out = await git(repo, ["ls-remote", "--symref", "origin", "HEAD"], env).catch(() => "");
  return /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out)?.[1] ?? "main";
}

async function githubUser(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const out = await runProc("gh", ["api", "user", "--jq", ".login"], {
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  const login = out.stdout.trim();
  return out.code === 0 && login !== "" ? login : undefined;
}

function skillInstalled(env: NodeJS.ProcessEnv): boolean {
  const claude = join(env.HOME ?? homedir(), ".claude");
  if (!existsSync(join(claude, "skills", "flowrunner", "SKILL.md"))) return false;
  try {
    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")) as {
      permissions?: { ask?: string[] };
    };
    return ASK_RULES.every((r) => settings.permissions?.ask?.includes(r) === true);
  } catch {
    return false;
  }
}

/** La carpeta del PATH donde init deja el comando: ~/.local/bin, solo si ya está en el PATH. */
function commandDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = join(env.HOME ?? homedir(), ".local", "bin");
  return (env.PATH ?? "").split(":").includes(dir) ? dir : undefined;
}

async function onPath(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await runShell("command -v flowrunner", { cwd: process.cwd(), env })).code === 0;
}

/** El cerebro del repo, inferido sobre un worktree limpio de la base, con la base comprobada. */
async function brainSteps(
  repo: string,
  worktree: string,
  base: string,
  aplicar: boolean,
  env: NodeJS.ProcessEnv,
): Promise<Paso[]> {
  const exists = await git(repo, ["cat-file", "-e", `origin/${base}:.flowrunner/config.yaml`], env)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    return [{ que: "cerebro del repo", estado: "ya estaba", detalle: `en origin/${base}` }];
  }
  const open = aplicar ? await findPr(repo, INIT_BRANCH, env) : undefined;
  if (open !== undefined) {
    return [
      { que: "PR del cerebro", estado: "ya estaba", detalle: `${open.url}: mergeala para usarlo` },
    ];
  }
  await removeWorktree(repo, worktree, env);
  await git(repo, ["worktree", "add", "--quiet", "--detach", worktree, `origin/${base}`], env);
  try {
    const files = (await git(worktree, ["ls-files"], env)).split("\n").filter(Boolean);
    const pkgFile = join(worktree, "package.json");
    let packageJson: unknown;
    try {
      packageJson = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : undefined;
    } catch {
      packageJson = undefined;
    }
    const inferred = inferRepo({ baseBranch: base, files, packageJson });
    const pasos: Paso[] = inferred.hallazgos.map((h) => ({ ...h }));
    if (inferred.config === undefined || inferred.verify === undefined) return pasos;

    const dir = join(worktree, ".flowrunner");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.yaml"),
      `# Lo armó flowrunner init. Se revisa por PR como el código.\n${stringify(inferred.config)}`,
    );
    writeFileSync(join(dir, "verify.sh"), inferred.verify);
    chmodSync(join(dir, "verify.sh"), 0o755);
    initBrain(worktree);
    const config = loadRepoConfig(worktree);

    const setup = await runShell(config.setup, { cwd: worktree, env, timeoutMs: SETUP_TIMEOUT_MS });
    const verify =
      setup.code === 0
        ? await runVerify(worktree, config, env)
        : { ok: false as const, detail: `el setup salió ${String(setup.code)}:\n${tail(setup)}` };
    if (!verify.ok) {
      pasos.push({
        que: "base en verde",
        estado: "falta",
        detalle: `origin/${base} no está en verde: ${verify.detail}`,
      });
      return pasos;
    }
    pasos.push({
      que: "base en verde",
      estado: "ok",
      detalle: `setup y verify pasan en origin/${base}`,
    });
    if (!aplicar) {
      pasos.push({
        que: "PR del cerebro",
        estado: "pendiente",
        detalle: `se abre en ${INIT_BRANCH}`,
      });
      return pasos;
    }
    await git(worktree, ["switch", "--quiet", "-C", INIT_BRANCH], env);
    await git(worktree, ["add", ".flowrunner"], env);
    await git(
      worktree,
      ["commit", "--quiet", "--no-verify", "-m", "chore: cerebro de flowrunner"],
      env,
    );
    await pushBranch(worktree, INIT_BRANCH, env);
    const body = join(worktree, "..", `${INIT_BRANCH.replace("/", "-")}.md`);
    writeFileSync(
      body,
      [
        "El cerebro de flowrunner para este repo, armado por `flowrunner init`.",
        "",
        ...inferred.hallazgos.map((h) => `- **${h.que}:** ${h.detalle}`),
        "",
        "Antes de mergear, completá `contexto.md`, `convenciones.md` y `que-es-bien.md`:",
        "son plantillas y planificar, implementar y revisar los leen en cada run.",
        "",
      ].join("\n"),
    );
    const pr = await createPr(
      worktree,
      { branch: INIT_BRANCH, base, title: "chore: cerebro de flowrunner", bodyFile: body },
      env,
    );
    pasos.push({
      que: "PR del cerebro",
      estado: "hecho",
      detalle: `${pr.url}: mergeala para usarlo`,
    });
    return pasos;
  } finally {
    await removeWorktree(repo, worktree, env);
  }
}

export async function init(path: string, env: NodeJS.ProcessEnv, aplicar: boolean) {
  const repo = await gitRootOf(path, env);
  const name = projectNameFor(repo);
  const pasos: Paso[] = [];
  const machine = await doctor(env);
  for (const check of machine.checks.slice(0, 4)) {
    if (!check.ok) pasos.push({ que: check.nombre, estado: "falta", detalle: check.arreglo });
  }

  const global = readGlobal(env);
  const user = typeof global.github_user === "string" ? global.github_user : await githubUser(env);
  pasos.push(
    user === undefined
      ? { que: "usuario de GitHub", estado: "falta", detalle: "corré `gh auth login`" }
      : {
          que: "usuario de GitHub",
          estado: global.github_user === undefined ? "inferido" : "ya estaba",
          detalle: user,
        },
  );
  const auth =
    typeof global.auth === "string"
      ? global.auth
      : (await claudeLoggedIn(env))
        ? "login"
        : readKeychainToken(env) !== undefined
          ? "token"
          : undefined;
  pasos.push(
    auth === undefined
      ? { que: "auth", estado: "falta", detalle: "abrí `claude` y corré `/login`" }
      : {
          que: "auth",
          estado: global.auth === undefined ? "inferido" : "ya estaba",
          detalle: auth,
        },
  );

  try {
    await fetchOrigin(repo, env);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    pasos.push({ que: "remote origin", estado: "falta", detalle: error.message });
  }
  const base = await defaultBranch(repo, env);
  if (!pasos.some((p) => p.que === "remote origin")) {
    try {
      pasos.push(
        ...(await brainSteps(repo, join(flowrunnerHome(env), "init", name), base, aplicar, env)),
      );
    } catch (error) {
      if (!(error instanceof ConfigError || error instanceof GitError)) throw error;
      pasos.push({ que: "cerebro del repo", estado: "falta", detalle: error.message });
    }
  }

  const registered = global.projects?.some((p) => p.path === repo) === true;
  const machineSteps: [string, boolean, () => Promise<string>][] = [
    [
      "proyecto",
      registered,
      () => {
        updateGlobalConfig(env, (raw) => {
          raw.github_user ??= user;
          raw.auth ??= auth;
          const projects = Array.isArray(raw.projects)
            ? (raw.projects as { name: string; path: string }[])
            : [];
          raw.projects = [...projects.filter((p) => p.name !== name), { name, path: repo }];
        });
        return Promise.resolve(`${name} en ${repo}`);
      },
    ],
    [
      "skill de Claude Code",
      skillInstalled(env),
      () => Promise.resolve(installSkill(env, true).skill),
    ],
    [
      "job de launchd",
      existsSync(plistPath(env)),
      async () => `tick cada ${String((await installLaunchd(env)).cada_minutos)} minutos`,
    ],
    [
      "comando flowrunner",
      await onPath(env),
      () => {
        const dir = commandDir(env);
        if (dir === undefined) throw new Error("agregá ~/.local/bin a tu PATH");
        symlinkSync(BIN, join(dir, "flowrunner"));
        return Promise.resolve(join(dir, "flowrunner"));
      },
    ],
  ];
  const blocked = user === undefined || auth === undefined;
  for (const [que, done, apply] of machineSteps) {
    if (done) pasos.push({ que, estado: "ya estaba", detalle: "" });
    else if (!aplicar || blocked)
      pasos.push({ que, estado: "pendiente", detalle: "con --aplicar" });
    else {
      try {
        pasos.push({ que, estado: "hecho", detalle: await apply() });
      } catch (error) {
        pasos.push({
          que,
          estado: "falta",
          detalle: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { ok: !pasos.some((p) => p.estado === "falta"), repo, proyecto: name, pasos };
}

const MARK: Record<Paso["estado"], string> = {
  "ya estaba": "✓",
  ok: "✓",
  hecho: "✓",
  inferido: "~",
  pendiente: "·",
  falta: "✗",
};

export function describeInit(result: Awaited<ReturnType<typeof init>>, aplicar: boolean): string {
  const lines = result.pasos.map(
    (p) => `${MARK[p.estado]} ${p.que}${p.detalle === "" ? "" : `: ${p.detalle}`}`,
  );
  const pending = result.pasos.some((p) => p.estado === "pendiente");
  if (!aplicar && result.ok && pending)
    lines.push("", "Para aplicarlo: flowrunner init <repo> --aplicar");
  return lines.join("\n");
}
