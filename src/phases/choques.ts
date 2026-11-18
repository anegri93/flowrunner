// Los choques de la rama de la feature con la base, que avanzó mientras tanto (ADR 0041). Entregar los
// mira antes de empujar, y aprender en cada tick con la PR abierta. Se detectan fusionando en memoria,
// sin tocar el worktree. Si chocan, la base se fusiona en la rama, una sesión resuelve los choques en
// los archivos que chocaron y queda un merge commit; el run vuelve a verificar, porque el código cambió.
// Si la sesión no los resuelve, o el choque está en un test bloqueado, el merge se deshace y el run te
// pregunta.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runSession } from "../agent/session.ts";
import { loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { fetchOrigin, git, GitError } from "../git/git.ts";
import { runProc } from "../proc/proc.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import type { Outcome } from "../store/events.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { traerLaRama } from "./feedback.ts";
import { featureWorktree, prepared, runFeature } from "./inputs.ts";
import { readPlan, sessionName } from "./planificar.ts";

export const CHOQUES_TIMEOUT_MS = 15 * 60_000;

/** Los archivos en que `ref` choca con `origin/<base>` al fusionarlos; vacío si no chocan. */
export async function choques(
  worktree: string,
  ref: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const args = [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    ref,
    `origin/${base}`,
  ];
  const result = await runProc("git", args, { cwd: worktree, env });
  if (result.code === 0) return [];
  if (result.code !== 1) throw new GitError(args, result.stderr);
  // La primera línea es el árbol fusionado; después, un archivo por línea.
  return [...new Set(result.stdout.split("\n").slice(1).filter(Boolean))];
}

// `=======` solo no cuenta: un título de Markdown puede subrayarse así, y nunca falta su `<<<<<<<`.
const MARCA = /^(<{7}|>{7})( |$)/m;

/** Lo que el run le dice a quien resolvió o no los choques: el texto del outcome y del aviso. */
const choqueEn = (base: string, archivos: readonly string[]) =>
  `la rama choca con ${base} en ${archivos.join(", ")}`;

/**
 * Fusiona `origin/<base>` en la rama del worktree y resuelve los choques con una sesión. Si quedó el
 * merge commit, el run vuelve a verificar; si no, el worktree queda como estaba y el run pregunta.
 */
export async function resolverChoques(
  ctx: PhaseContext,
  worktree: string,
  config: RepoConfig,
  archivos: readonly string[],
): Promise<Outcome> {
  const { run, deps, emit } = ctx;
  const base = config.base_branch;
  const choque = choqueEn(base, archivos);
  const aMano = `Resolvelo en el worktree ${worktree} (git merge origin/${base}) y seguí con flowrunner resume ${run.id}.`;
  const abortar = () => git(worktree, ["merge", "--abort"], deps.env).catch(() => undefined);
  // Un proceso que murió a la mitad deja el merge abierto: se rehace de cero.
  if (
    (
      await runProc("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd: worktree,
        env: deps.env,
      })
    ).code === 0
  )
    await abortar();

  const locked = Object.keys(readPlan(run).locked);
  const bloqueados = archivos.filter((a) => locked.includes(a));
  if (bloqueados.length > 0)
    return {
      tipo: "pregunta",
      motivo: `${choque}, y ${bloqueados.join(", ")} es un test bloqueado: lo resolvés vos. ${aMano}`,
    };

  // Falla porque choca: los archivos que quedaron sin fusionar son los que ve la sesión.
  await runProc("git", ["merge", "--no-ff", "--no-commit", `origin/${base}`], {
    cwd: worktree,
    env: deps.env,
  });
  const sinFusionar = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"], deps.env))
    .split("\n")
    .filter(Boolean);
  if (sinFusionar.length === 0) {
    await abortar();
    throw new GitError(
      ["merge", `origin/${base}`],
      `git dijo que chocaba en ${archivos.join(", ")}, y el merge no dejó archivos sin fusionar`,
    );
  }

  const result = await runSession(
    {
      fase: ctx.action.fase,
      nombre: sessionName(run, `${ctx.action.fase}-choques`),
      prompt: render("choques", {
        base,
        archivos: sinFusionar.map((a) => `- ${a}`).join("\n"),
        feature: featureText(runFeature(run)),
      }),
      cwd: worktree,
      model: config.models.implementar,
      tools: ["Read", "Edit", "Write", "Grep", "Glob"],
      hook: tripwireHook(
        {
          scope: {
            root: realpathSync(worktree),
            owner: "choques",
            writable: sinFusionar,
            writeGlobs: [],
            locked,
            harness: config.harness_files,
            lockfiles: config.lockfiles,
            manifests: config.manifests,
            depsDeclared: false,
            testGlobs: config.tests_globs,
            comandos: SIN_COMANDOS,
          },
          fase: ctx.action.fase,
          write: true,
          bash: false,
          agents: false,
          graft: false,
        },
        emit,
      ),
      timeoutMs: CHOQUES_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok") {
    await abortar();
    if (result.tipo === "limite") return result;
    return {
      tipo: "falla",
      clase: result.clase,
      motivo: `${choque}, y la sesión que los resuelve no terminó: ${result.motivo}`,
    };
  }
  const conMarcas = sinFusionar.filter((a) => {
    const file = join(worktree, a);
    return existsSync(file) && MARCA.test(readFileSync(file, "utf8"));
  });
  if (conMarcas.length > 0) {
    await abortar();
    return {
      tipo: "pregunta",
      motivo: `${choque}, y la sesión dejó marcas de conflicto en ${conMarcas.join(", ")}. ${aMano}`,
    };
  }
  await git(worktree, ["add", "-A", "--", ...sinFusionar], deps.env);
  await git(
    worktree,
    [
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `merge: ${base} en la rama, con los choques resueltos`,
      "--trailer",
      `Flowrunner-Run: ${run.id}`,
    ],
    deps.env,
  );
  emit({
    tipo: "aviso",
    fase: ctx.action.fase,
    texto: `${choque}: flowrunner fusionó ${base}, resolvió los choques y vuelve a verificar`,
  });
  return {
    tipo: "reentrar",
    desde: "verificar",
    instruccion: choque,
    por_que: `${choque}: se fusionó ${base} y el código cambió`,
  };
}

/**
 * Con la PR abierta: si la rama en GitHub ya no se fusiona con la base, trae al worktree lo que hay en
 * GitHub y resuelve los choques. Si no chocan, espera tu merge.
 */
export async function vigilarChoques(ctx: PhaseContext): Promise<Outcome> {
  const { run, deps, events, state } = ctx;
  const worktree = featureWorktree(run);
  const config = loadRepoConfig(worktree);
  const base = config.base_branch;
  try {
    await fetchOrigin(state.repo, deps.env);
    const enGitHub = await choques(worktree, `origin/${prepared(events).rama}`, base, deps.env);
    if (enGitHub.length === 0) return { tipo: "espera" };
    const sync = await traerLaRama(ctx, worktree);
    if (sync !== undefined) return sync;
    const archivos = await choques(worktree, "HEAD", base, deps.env);
    if (archivos.length > 0) return await resolverChoques(ctx, worktree, config, archivos);
    // El worktree ya los resolvió (lo hiciste vos, después de que el run te preguntara): falta entregarlo.
    const choque = choqueEn(base, enGitHub);
    return {
      tipo: "reentrar",
      desde: "verificar",
      instruccion: choque,
      por_que: `${choque} en GitHub, y el worktree ya los resolvió: se vuelve a entregar`,
    };
  } catch (error) {
    if (error instanceof GitError) return { tipo: "falla", clase: "infra", motivo: error.message };
    throw error;
  }
}
