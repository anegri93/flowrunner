// Preparar: worktree de la feature desde origin/<base>, setup, verify sobre la base y el índice de
// graft. Todo lo que falla acá es del entorno: reintentar no lo arregla y no se gastan tokens.
import { loadBrain } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import { ConfigError } from "../config/schemas.ts";
import { addWorktree, fetchOrigin, GitError } from "../git/git.ts";
import { buildIndex } from "../graft/graft.ts";
import { runShell, tail } from "../proc/proc.ts";
import type { Outcome } from "../store/events.ts";
import type { PhaseFn } from "../runner/types.ts";
import { featureBranch, featureWorktree, graftIndex, runFeature } from "./inputs.ts";
import { runVerify } from "./verify.ts";

export const SETUP_TIMEOUT_MS = 20 * 60_000;

const entorno = (motivo: string): Outcome => ({ tipo: "falla", clase: "entorno", motivo });

export const preparar: PhaseFn = async (ctx) => {
  const { run, state, deps, emit } = ctx;
  const feature = runFeature(run);
  let base: string;
  try {
    base = loadRepoConfig(state.repo).base_branch;
  } catch (error) {
    if (error instanceof ConfigError) return entorno(error.message);
    throw error;
  }
  try {
    await fetchOrigin(state.repo, deps.env);
  } catch (error) {
    if (error instanceof GitError) return { tipo: "falla", clase: "infra", motivo: error.message };
    throw error;
  }
  const worktree = featureWorktree(run);
  const branch = featureBranch(feature);
  let baseSha: string;
  try {
    baseSha = await addWorktree(state.repo, worktree, branch, `origin/${base}`, deps.env);
  } catch (error) {
    if (error instanceof GitError) return entorno(error.message);
    throw error;
  }
  let config;
  try {
    config = loadRepoConfig(worktree);
    loadBrain(worktree);
  } catch (error) {
    if (error instanceof ConfigError) return entorno(error.message);
    throw error;
  }
  const setup = await runShell(config.setup, {
    cwd: worktree,
    env: deps.env,
    timeoutMs: SETUP_TIMEOUT_MS,
  });
  if (setup.code !== 0) {
    return entorno(`el setup \`${config.setup}\` salió ${setup.code}:\n${tail(setup)}`);
  }
  const verify = await runVerify(worktree, config, deps.env);
  if (!verify.ok) {
    return entorno(
      verify.unrunnable
        ? `no se pudo ejecutar verify sobre la base: ${verify.detail}`
        : `la base ${base} no está en verde: ${verify.detail}`,
    );
  }
  try {
    await buildIndex(worktree, graftIndex(run), deps.env);
  } catch (error) {
    return entorno(
      `graft no pudo construir el índice: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  emit({ tipo: "preparado", rama: branch, worktree, base_sha: baseSha });
  return { tipo: "ok" };
};
