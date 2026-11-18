// Entregar: push de la rama de la feature y la PR, que se crea solo si no existe. Nunca mergea.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../config/load.ts";
import { git, GitError, isAncestor, pushBranch } from "../git/git.ts";
import { createPr, editPrBody, findPr, GhError } from "../github/gh.ts";
import { prBody } from "../report/report.ts";
import { readLog } from "../store/run-log.ts";
import type { PhaseFn } from "../runner/types.ts";
import { featureWorktree, prepared, runFeature } from "./inputs.ts";
import { leaseDe } from "./feedback.ts";
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
  let pr;
  try {
    // Antes de empujar: si la persona mergeó o cerró la PR mientras se rehacía, empujar a esa rama no
    // sirve, y detenerse dejaba el run trabado sin aprender del merge (ADR 0038).
    pr = await findPr(worktree, prep.rama, deps.env);
  } catch (error) {
    if (error instanceof GhError) return { tipo: "falla", clase: "infra", motivo: error.message };
    throw error;
  }
  if (pr !== undefined && pr.state !== "OPEN") {
    const estado = pr.state === "MERGED" ? "mergeó" : "cerró";
    if (desdeFeedback !== -1) {
      emit({
        tipo: "aviso",
        fase: "entregar",
        texto: `la PR ${pr.url} se ${estado} mientras se rehacía con tu feedback: lo rehecho no se entregó`,
      });
      return { tipo: "ok" };
    }
    return {
      tipo: "falla",
      clase: "invariante",
      motivo: `la PR ${pr.url} ya está ${pr.state === "MERGED" ? "mergeada" : "cerrada"}: flowrunner no la vuelve a abrir`,
    };
  }
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
    // Después de un feedback se empuja solo sobre lo que flowrunner ya tiene: lo que vio en GitHub al
    // traer la rama, o algo que el HEAD ya contiene. Un push tuyo posterior frena la entrega en vez de
    // perderse: cualquier fetch del repo pone al día el ref de seguimiento, que era el lease (ADR 0038).
    let lease: string | undefined;
    if (desdeFeedback !== -1) {
      const remota = (
        await git(worktree, ["ls-remote", "origin", `refs/heads/${prep.rama}`], deps.env)
      ).split(/\s/)[0];
      if (remota !== undefined && remota !== "") {
        const propia = remota === leaseDe(run) || (await isAncestor(worktree, remota, deps.env));
        if (!propia)
          return {
            tipo: "falla",
            clase: "entorno",
            motivo: `empujaste a ${prep.rama} mientras se rehacía con tu feedback, y entregar no lo pisa: traé esos commits al worktree ${worktree} y seguí con flowrunner resume ${run.id}`,
          };
        lease = remota;
      }
    }
    await pushBranch(worktree, prep.rama, deps.env, lease);
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
