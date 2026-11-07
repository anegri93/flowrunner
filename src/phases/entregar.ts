// Entregar: push de la rama de la feature y la PR, que se crea solo si no existe. Nunca mergea.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../config/load.ts";
import { GitError, pushBranch } from "../git/git.ts";
import { createPr, findPr, GhError } from "../github/gh.ts";
import { prBody } from "../report/report.ts";
import { readLog } from "../store/run-log.ts";
import type { PhaseFn } from "../runner/types.ts";
import { featureWorktree, prepared, runFeature } from "./inputs.ts";
import { proposeLessons } from "./proponer.ts";

export const entregar: PhaseFn = async (ctx) => {
  const { run, deps, emit, state } = ctx;
  const prep = prepared(ctx.events);
  const worktree = featureWorktree(run);
  const feature = runFeature(run);
  const config = loadRepoConfig(worktree);
  const base = config.base_branch;
  // Una sola vez por run: si entregar se reintenta, las lecciones ya están en la rama.
  if (!ctx.events.some((e) => e.tipo === "lecciones_propuestas")) {
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
    if (pr === undefined) {
      const bodyFile = join(run.dir, "pr-body.md");
      writeFileSync(bodyFile, prBody(readLog(run.dir).events, run));
      pr = await createPr(
        worktree,
        { branch: prep.rama, base, title: `${feature.clave} · ${feature.titulo}`, bodyFile },
        deps.env,
      );
    }
    emit({ tipo: "pr", url: pr.url, numero: pr.number });
    const rounds = state.vueltas.verificar + state.vueltas.revisar;
    deps.notify(
      "flowrunner",
      `${feature.clave}: PR abierta${rounds === 0 ? "" : `, ${rounds} ${rounds === 1 ? "vuelta" : "vueltas"}`}. Pedile a Claude que te explique el informe.`,
    );
    return { tipo: "ok" };
  } catch (error) {
    if (error instanceof GitError || error instanceof GhError) {
      return { tipo: "falla", clase: "infra", motivo: error.message };
    }
    throw error;
  }
};
