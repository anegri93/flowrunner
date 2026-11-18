// El feedback de la persona sobre una PR abierta que no quiere mergear (ADR 0038). Aprender lo evalúa
// con una sesión de solo lectura que decide desde dónde rehacer: implementar, con las sub-tasks que
// tienen que cambiar; planificar, que vuelve a pasar por la aprobación; o, si el feedback cambia lo
// que pide la feature, ninguna: el run se detiene y le pregunta a la persona. El código solo decide si
// la respuesta sirve; ante la duda, replanifica, que es lo que pasa por la persona.
import { realpathSync } from "node:fs";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadRepoConfig } from "../config/load.ts";
import { feedbackInstruction } from "../engine/engine.ts";
import { fetchOrigin, git, GitError } from "../git/git.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import type { Outcome } from "../store/events.ts";
import { readOnlyHook } from "./aprender.ts";
import { featureWorktree, prepared, runFeature } from "./inputs.ts";
import { readPlan, sessionName } from "./planificar.ts";
import { MAX_DIFF_CHARS } from "./revisar.ts";

export const feedbackDecisionSchema = z.object({
  desde: z.enum(["implementar", "planificar", "feature"]),
  unidades: z.array(z.string()).default([]),
  instruccion: z.string().min(1),
  por_que: z.string().min(1),
});
export type FeedbackDecision = z.infer<typeof feedbackDecisionSchema>;

export const FEEDBACK_TIMEOUT_MS = 15 * 60_000;

/**
 * Lo que la persona empujó a la rama de la PR después de la entrega, como una corrección a mano, entra
 * al worktree antes de rehacer: si no, el push de la próxima entrega lo rechazaría (`--force-with-lease`)
 * o lo pisaría. Solo se adelanta: una rama que se separó la decide la persona.
 */
async function traerLaRama(ctx: PhaseContext, worktree: string): Promise<Outcome | undefined> {
  const { deps, state, events } = ctx;
  const rama = prepared(events).rama;
  try {
    await fetchOrigin(state.repo, deps.env);
    const remota = `origin/${rama}`;
    const head = await git(worktree, ["rev-parse", "HEAD"], deps.env);
    const otra = await git(worktree, ["rev-parse", remota], deps.env).catch(() => undefined);
    if (otra === undefined || otra === head) return undefined;
    const adelante = await git(worktree, ["merge-base", "--is-ancestor", head, remota], deps.env)
      .then(() => true)
      .catch(() => false);
    if (adelante) {
      await git(worktree, ["merge", "--ff-only", "--quiet", remota], deps.env);
      return undefined;
    }
    const atras = await git(worktree, ["merge-base", "--is-ancestor", remota, head], deps.env)
      .then(() => true)
      .catch(() => false);
    if (atras) return undefined;
    return {
      tipo: "falla",
      clase: "entorno",
      motivo: `la rama ${rama} en GitHub se separó de la del run: traé sus commits al worktree ${worktree} y seguí con flowrunner resume ${ctx.run.id}`,
    };
  } catch (error) {
    if (error instanceof GitError) return { tipo: "falla", clase: "infra", motivo: error.message };
    throw error;
  }
}

/** Evalúa el feedback pendiente con la PR abierta y dice desde dónde vuelve a trabajar el run. */
export async function evaluarFeedback(ctx: PhaseContext, feedback: string): Promise<Outcome> {
  const { run, deps, emit, events } = ctx;
  const worktree = featureWorktree(run);
  const sync = await traerLaRama(ctx, worktree);
  if (sync !== undefined) return sync;
  const config = loadRepoConfig(worktree);
  const plan = readPlan(run);
  const ids = plan.subtareas.map((t) => t.id);
  const fullDiff = await git(worktree, ["diff", `${prepared(events).base_sha}..HEAD`], deps.env);
  const diff =
    fullDiff.length > MAX_DIFF_CHARS
      ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n… (el diff sigue: leé los archivos con Read)`
      : fullDiff;
  const result = await runSession(
    {
      fase: "aprender",
      nombre: sessionName(run, "aprender-feedback"),
      prompt: render("feedback", {
        feedback,
        subtareas: ids.join(", "),
        feature: featureText(runFeature(run)),
        plan: plan.plan,
        tareas: plan.subtareas
          .map(
            (t) => `- ${t.id} · ${t.titulo}: ${t.descripcion} (alcance: ${t.alcance.join(", ")})`,
          )
          .join("\n"),
        diff: diff === "" ? "(sin cambios)" : diff,
      }),
      cwd: worktree,
      model: config.models.revisar,
      tools: ["Read", "Grep", "Glob"],
      hook: readOnlyHook(ctx, realpathSync(worktree)),
      schema: feedbackDecisionSchema,
      timeoutMs: FEEDBACK_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo === "limite") return result;
  if (result.tipo === "falla")
    return {
      tipo: "falla",
      clase: result.clase,
      motivo: `no se pudo evaluar tu feedback: ${result.motivo}`,
    };
  return decide(ctx, feedback, result.output, ids);
}

/** La decisión de la sesión, si sirve; si no, replanificar, que pasa por la persona. */
export function decide(
  ctx: Pick<PhaseContext, "emit" | "run">,
  feedback: string,
  d: FeedbackDecision,
  ids: readonly string[],
): Outcome {
  const { emit, run } = ctx;
  const conFeedback = (texto: string) => `${feedbackInstruction(feedback)}\n\n${texto}`;
  if (d.desde === "feature") {
    emit({
      tipo: "decision",
      fase: "aprender",
      que: "tu feedback: preguntarte",
      por_que: d.por_que,
    });
    return {
      tipo: "pregunta",
      motivo: `tu feedback cambia lo que pide la feature: ${d.por_que}\n${d.instruccion}\nPara replanificar con tu feedback: flowrunner rerun ${run.id} --desde planificar. Si la feature tiene que ser otra, abortá el run y escribí una nueva.`,
    };
  }
  const unidades = [...new Set(d.unidades)];
  const validas = unidades.length > 0 && unidades.every((u) => ids.includes(u));
  if (d.desde === "implementar" && validas) {
    emit({
      tipo: "decision",
      fase: "aprender",
      que: `tu feedback: rehacer ${unidades.join(", ")} desde implementar`,
      por_que: d.por_que,
    });
    return {
      tipo: "reentrar",
      desde: "implementar",
      unidades,
      instruccion: conFeedback(d.instruccion),
      por_que: d.por_que,
    };
  }
  if (d.desde === "implementar") {
    emit({
      tipo: "aviso",
      fase: "aprender",
      texto: `la evaluación de tu feedback eligió implementar sin sub-tasks del plan (${unidades.join(", ") || "ninguna"}): se replanifica`,
    });
  }
  emit({
    tipo: "decision",
    fase: "aprender",
    que: "tu feedback: replanificar",
    por_que: d.por_que,
  });
  return {
    tipo: "reentrar",
    desde: "planificar",
    instruccion: conFeedback(d.instruccion),
    por_que: d.por_que,
  };
}
