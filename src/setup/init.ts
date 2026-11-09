// `flowrunner init <repo>`: revisa qué hay, infiere lo que se puede y dice lo que falta. Con
// `aplicar`, deja la máquina y el repo listos: config global, proyecto, skill, launchd, el comando en
// el PATH y una PR con el cerebro del repo. Cada paso es idempotente.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { readKeychainToken } from "../agent/auth.ts";
import { initBrain, loadBrain } from "../brain/brain.ts";
import { claudeLoggedIn, doctor } from "../cli/doctor.ts";
import { installLaunchd, plistPath } from "../cli/launchd.ts";
import { gitRootOf, projectNameFor, updateGlobalConfig } from "../cli/project.ts";
import { BIN } from "../cli/runs.ts";
import { installSkill, skillUpToDate } from "../cli/skill.ts";
import { flowrunnerHome, loadRepoConfig } from "../config/load.ts";
import { ConfigError } from "../config/schemas.ts";
import { fetchOrigin, git, GitError, pushBranch, removeWorktree } from "../git/git.ts";
import { createPr, findPr, type PullRequest } from "../github/gh.ts";
import { runVerify } from "../phases/verify.ts";
import { runProc, runShell, tail } from "../proc/proc.ts";
import type { Deps, RunPaths } from "../runner/types.ts";
import { draftBrain, DRAFT_HEADING, type Progress } from "./draft.ts";
import { inferRepo } from "./infer.ts";

export const INIT_BRANCH = "chore/flowrunner-init";
export const DRAFT_BRANCH = "chore/flowrunner-borrador";
const BRAIN_DOCS = "`contexto.md`, `convenciones.md` y `que-es-bien.md`";
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

/** La carpeta del PATH donde init deja el comando: ~/.local/bin, solo si ya está en el PATH. */
function commandDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = join(env.HOME ?? homedir(), ".local", "bin");
  return (env.PATH ?? "").split(":").includes(dir) ? dir : undefined;
}

async function onPath(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await runShell("command -v flowrunner", { cwd: process.cwd(), env })).code === 0;
}

/**
 * Dónde deja init el stream de la sesión del borrador, porque no tiene un run propio. Borra el de
 * una corrida anterior; va fuera de `init/`, donde viven los worktrees por nombre de proyecto.
 */
function draftSession(env: NodeJS.ProcessEnv, name: string): RunPaths {
  const home = flowrunnerHome(env);
  const dir = join(home, "init-sesiones", name);
  rmSync(join(dir, "sesiones"), { recursive: true, force: true });
  return { id: `init-${name}`, home, dir, worktrees: join(home, "init") };
}

/** Commitea `.flowrunner/` del worktree en `branch`, la empuja y abre su PR contra la base. */
async function openBrainPr(
  worktree: string,
  pr: { branch: string; base: string; title: string; body: readonly string[] },
  env: NodeJS.ProcessEnv,
): Promise<PullRequest> {
  await git(worktree, ["switch", "--quiet", "-C", pr.branch], env);
  await git(worktree, ["add", ".flowrunner"], env);
  await git(worktree, ["commit", "--quiet", "--no-verify", "-m", pr.title], env);
  await pushBranch(worktree, pr.branch, env);
  const bodyFile = join(worktree, "..", `${pr.branch.replace("/", "-")}.md`);
  writeFileSync(bodyFile, [...pr.body, ""].join("\n"));
  return createPr(worktree, { branch: pr.branch, base: pr.base, title: pr.title, bodyFile }, env);
}

/** Si la base ya tiene el cerebro de flowrunner. */
async function hasBrain(repo: string, base: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return git(repo, ["cat-file", "-e", `origin/${base}:.flowrunner/config.yaml`], env)
    .then(() => true)
    .catch(() => false);
}

/** El cerebro del repo, inferido sobre un worktree limpio de la base, con la base comprobada. */
async function brainSteps(
  repo: string,
  worktree: string,
  base: string,
  aplicar: boolean,
  deps: Deps,
  progress: Progress,
): Promise<Paso[]> {
  const { env } = deps;
  if (await hasBrain(repo, base, env)) {
    return [
      {
        que: "cerebro del repo",
        estado: "ya estaba",
        detalle: `en origin/${base}; para sumarle un borrador leído del código: flowrunner brain draft ${repo}`,
      },
    ];
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

    progress(`comprobando que origin/${base} esté en verde: setup y verify`);
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
      pasos.push({
        que: "PR del cerebro",
        estado: "pendiente",
        detalle: `no se abre hasta que origin/${base} esté en verde`,
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
    const draft = await draftBrain({
      worktree,
      files,
      hallazgos: inferred.hallazgos,
      config,
      session: draftSession(env, projectNameFor(repo)),
      deps,
      progress,
    });
    pasos.push(
      draft.tipo === "ok"
        ? {
            que: "borrador del cerebro",
            estado: "inferido",
            detalle: `convenciones.md, contexto.md y que-es-bien.md, leyendo el código (USD ${draft.costoUsd.toFixed(2)})`,
          }
        : {
            que: "borrador del cerebro",
            estado: "pendiente",
            detalle: `no se redactó: ${draft.motivo}. Quedan las plantillas para completar a mano`,
          },
    );
    progress(`abriendo la PR en ${INIT_BRANCH}`);
    const pr = await openBrainPr(
      worktree,
      {
        branch: INIT_BRANCH,
        base,
        title: "chore: cerebro de flowrunner",
        body: [
          "El cerebro de flowrunner para este repo, armado por `flowrunner init`.",
          "",
          ...inferred.hallazgos.map((h) => `- **${h.que}:** ${h.detalle}`),
          "",
          ...(draft.tipo === "ok"
            ? [
                `${BRAIN_DOCS} traen un borrador que init dedujo`,
                `del código, en la sección «${DRAFT_HEADING.replace(/^## /, "")}». Revisalo antes de mergear:`,
                "planificar, implementar y revisar lo leen en cada run.",
              ]
            : [
                `Antes de mergear, completá ${BRAIN_DOCS}:`,
                "son plantillas y planificar, implementar y revisar los leen en cada run.",
              ]),
        ],
      },
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

export interface DraftOutcome {
  readonly ok: boolean;
  readonly repo: string;
  readonly paso: Paso;
}

/**
 * `flowrunner brain draft <repo>`: para un repo que ya tiene el cerebro en la base, redacta el
 * borrador leyendo el código y lo propone en su propia PR. Lo que ya escribió la persona queda arriba.
 */
export async function draftExistingBrain(
  path: string,
  deps: Deps,
  progress: Progress,
): Promise<DraftOutcome> {
  const { env } = deps;
  const repo = await gitRootOf(path, env);
  const name = projectNameFor(repo);
  const outcome = (estado: Paso["estado"], detalle: string): DraftOutcome => ({
    ok: estado !== "falta",
    repo,
    paso: { que: "borrador del cerebro", estado, detalle },
  });
  progress("trayendo origin");
  await fetchOrigin(repo, env);
  const base = await defaultBranch(repo, env);
  if (!(await hasBrain(repo, base, env))) {
    return outcome(
      "falta",
      `origin/${base} no tiene cerebro: corré flowrunner init ${repo} --aplicar`,
    );
  }
  const open = await findPr(repo, DRAFT_BRANCH, env);
  if (open?.state === "OPEN") return outcome("ya estaba", `${open.url}: revisala y mergeala`);

  const worktree = join(flowrunnerHome(env), "init", `${name}-borrador`);
  progress(`preparando un worktree limpio de origin/${base}`);
  await removeWorktree(repo, worktree, env);
  await git(repo, ["worktree", "add", "--quiet", "--detach", worktree, `origin/${base}`], env);
  try {
    const brain = loadBrain(worktree);
    if (
      [brain.convenciones, brain.contexto, brain.queEsBien].some((t) => t.includes(DRAFT_HEADING))
    ) {
      return outcome(
        "ya estaba",
        `el cerebro de origin/${base} ya tiene un borrador de init: borrá esa sección para pedir otro`,
      );
    }
    const config = loadRepoConfig(worktree);
    const draft = await draftBrain({
      worktree,
      files: (await git(worktree, ["ls-files"], env)).split("\n").filter(Boolean),
      hallazgos: [
        { que: "setup", detalle: config.setup },
        { que: "tests_globs", detalle: config.tests_globs.join(", ") },
        { que: "harness_files", detalle: config.harness_files.join(", ") || "(ninguno)" },
      ],
      config,
      session: draftSession(env, name),
      deps,
      progress,
    });
    if (draft.tipo === "falla") return outcome("falta", `no se redactó: ${draft.motivo}`);
    progress(`abriendo la PR en ${DRAFT_BRANCH}`);
    const pr = await openBrainPr(
      worktree,
      {
        branch: DRAFT_BRANCH,
        base,
        title: "chore: borrador del cerebro de flowrunner",
        body: [
          `Un borrador de ${BRAIN_DOCS} que \`flowrunner brain draft\` dedujo del código.`,
          "",
          `Va en la sección «${DRAFT_HEADING.replace(/^## /, "")}» de cada archivo, debajo de lo que ya`,
          "estaba. Corregí o borrá lo que no sea así antes de mergear: planificar, implementar y revisar",
          "lo leen en cada run.",
        ],
      },
      env,
    );
    return outcome("hecho", `${pr.url} (USD ${draft.costoUsd.toFixed(2)}): revisala y mergeala`);
  } finally {
    await removeWorktree(repo, worktree, env);
  }
}

export async function init(path: string, deps: Deps, aplicar: boolean, progress: Progress) {
  const { env } = deps;
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
        ...(await brainSteps(
          repo,
          join(flowrunnerHome(env), "init", name),
          base,
          aplicar,
          // La config global todavía puede no existir: la sesión usa el auth que init acaba de inferir.
          auth === "login" ? { ...deps, env: { ...env, FLOWRUNNER_AUTH: "login" } } : deps,
          progress,
        )),
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
      skillUpToDate(env),
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
  if (!result.ok)
    lines.push(
      "",
      `Arreglá lo marcado con ✗ y volvé a correr: flowrunner init <repo>${aplicar ? " --aplicar" : ""}`,
    );
  else if (!aplicar && pending) lines.push("", "Para aplicarlo: flowrunner init <repo> --aplicar");
  return lines.join("\n");
}
