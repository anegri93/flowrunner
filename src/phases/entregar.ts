// Entregar: push de la rama de la feature y la PR, que se crea solo si no existe. Nunca mergea.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../config/load.ts";
import { GitError, pushBranch } from "../git/git.ts";
import { createPr, editPrBody, findPr, GhError } from "../github/gh.ts";
import { prBody } from "../report/report.ts";
import { readLog } from "../store/run-log.ts";
import type { PhaseFn } from "../runner/types.ts";
import { featureWorktree, prepared, runFeature } from "./inputs.ts";
import { proposeLessons } from "./proponer.ts";

export const entregar: PhaseFn = async (ctx) => {
  const { run, deps, emit } = ctx;
  const prep = prepared(ctx.events);
  const worktree = featureWorktree(run);
  const feature = runFeature(run);
  const config = loadRepoConfig(worktree);
  const base = config.base_branch;
  // Una vez por entrega: si entregar se reintenta, las lecciones ya están en la rama. Después de tu
  // feedback sobre la PR se proponen de nuevo, con el feedback como corrección (ADR 0038).
  const desdeFeedback = ctx.events.findLastIndex((e) => e.tipo === "feedback_pedido");
  if (!ctx.events.slice(desdeFeedback + 1).some((e) => e.tipo === "lecciones_propuestas")) {
    try {
      await proposeLessons(ctx, worktree, config);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      emit({
        tipo: "aviso",
        fase: "entregar",
        texto: `no se pudieron proponer lecciones: ${error.message}`,
      });
    }
  }
  try {
    await pushBranch(worktree, prep.rama, deps.env);
    let pr = await findPr(worktree, prep.rama, deps.env);
    if (pr !== undefined && pr.state !== "OPEN") {
      return {
        tipo: "falla",
        clase: "invariante",
        motivo: `la PR ${pr.url} ya está ${pr.state === "MERGED" ? "mergeada" : "cerrada"}: flowrunner no la vuelve a abrir`,
      };
    }
    const bodyFile = join(run.dir, "pr-body.md");
    if (pr === undefined) {
      writeFileSync(bodyFile, prBody(readLog(run.dir).events, run));
      pr = await createPr(
        worktree,
        { branch: prep.rama, base, title: `${feature.clave} · ${feature.titulo}`, bodyFile },
        deps.env,
      );
    } else if (desdeFeedback !== -1) {
      // Rehecha con tu feedback: la misma PR, con el informe de lo que cambió.
      writeFileSync(bodyFile, prBody(readLog(run.dir).events, run));
      await editPrBody(worktree, pr.number, bodyFile, deps.env);
    }
    emit({ tipo: "pr", url: pr.url, numero: pr.number });
    return { tipo: "ok" };
  } catch (error) {
    if (error instanceof GitError || error instanceof GhError) {
      return { tipo: "falla", clase: "infra", motivo: error.message };
    }
    throw error;
  }
};
