// Revisar: una sesión de Opus de solo lectura contrasta el diff con el plan y el cerebro. Los
// bloqueantes devuelven su sub-task a implementar; los avisos van al informe.
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadBrain } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import { decisionSchema } from "../gates/plan.ts";
import { git } from "../git/git.ts";
import { blastRadius, buildIndex, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn } from "../runner/types.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { WRITE_TOOLS } from "../tripwires/rules.ts";
import type { RunEvent } from "../store/events.ts";
import { featureWorktree, graftIndex, prepared, runFeature } from "./inputs.ts";
import { brainVars, readPlan, sessionName } from "./planificar.ts";

export const findingSchema = z.object({
  severidad: z.enum(["bloqueante", "aviso"]),
  archivo: z.string(),
  linea: z.int().nonnegative(),
  afirmacion: z.string().min(1),
  regla: z.string(),
  subtarea: z.string(),
});
export const reviewSchema = z.object({
  hallazgos: z.array(findingSchema),
  decisiones: z.array(decisionSchema),
  // Con default: un review.json de antes de este campo se sigue leyendo.
  como_probar: z.array(z.string().min(1)).default([]),
});
/** Lo que devuelve el revisor; `como_probar` puede faltar en un review.json viejo. */
export type Review = z.input<typeof reviewSchema>;

export const REVISAR_TIMEOUT_MS = 30 * 60_000;
/** Un diff más largo que esto se corta en el prompt; el revisor puede leer los archivos con Read. */
export const MAX_DIFF_CHARS = 60_000;

/**
 * Lo que el bloqueo no dejó escribir a las sub-tasks desde la última aprobación del plan. Una sub-task
 * puede seguir sin eso y no decirlo (VF-6: el script `mac` de package.json, rechazado dos veces,
 * quedó documentado y sin existir, con todo en verde).
 */
export function rejectedWritesText(events: readonly RunEvent[]): string {
  const since = events.findLastIndex((e) => e.tipo === "aprobado");
  const lines = new Set<string>();
  for (const e of events.slice(since + 1)) {
    if (e.tipo !== "rechazo" || e.fase !== "implementar" || !WRITE_TOOLS.has(e.herramienta))
      continue;
    lines.add(`- ${e.unidad ?? "?"}: ${e.motivo}`);
  }
  return lines.size === 0 ? "Ninguna." : [...lines].join("\n");
}

export const revisar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action } = ctx;
  const prep = prepared(ctx.events);
  const worktree = featureWorktree(run);
  const config = loadRepoConfig(worktree);
  const brain = loadBrain(worktree);
  const feature = runFeature(run);
  const plan = readPlan(run);
  // Implementar cambió el código: el índice de graft se reconstruye antes de revisar (ADR 0015).
  await buildIndex(worktree, graftIndex(run), deps.env);
  const fullDiff = await git(worktree, ["diff", `${prep.base_sha}..HEAD`], deps.env);
  const diff =
    fullDiff.length > MAX_DIFF_CHARS
      ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n… (el diff sigue: leé los archivos con Read)`
      : fullDiff;
  const ids = plan.subtareas.map((t) => t.id);
  const result = await runSession(
    {
      fase: "revisar",
      nombre: sessionName(run, "revisar"),
      prompt: render("revisar", {
        subtareas: ids.join(", "),
        instruccion:
          action.instruccion === undefined
            ? ""
            : `# Atención: nuevo intento\n\n${action.instruccion}`,
        feature: featureText(feature),
        plan: plan.plan,
        diff,
        blast: await blastRadius(worktree, graftIndex(run), prep.base_sha, deps.env),
        rechazos: rejectedWritesText(ctx.events),
        ...brainVars(brain),
      }),
      cwd: worktree,
      model: config.models.revisar,
      tools: ["Read", "Grep", "Glob"],
      hook: tripwireHook(
        {
          scope: {
            root: realpathSync(worktree),
            owner: "revisar",
            writable: [],
            writeGlobs: [],
            locked: [],
            harness: [],
            lockfiles: [],
            manifests: [],
            depsDeclared: false,
            testGlobs: config.tests_globs,
            bash: [],
          },
          fase: "revisar",
          write: false,
          bash: false,
          agents: false,
          graft: true,
        },
        emit,
      ),
      schema: reviewSchema,
      mcpServers: { graft: graftMcpServer(worktree, graftIndex(run), deps.env) },
      timeoutMs: REVISAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok") {
    return result.tipo === "limite"
      ? result
      : { tipo: "falla", clase: result.clase, motivo: result.motivo };
  }
  const review = result.output;
  const unknown = review.hallazgos.filter((h) => !ids.includes(h.subtarea));
  if (unknown.length > 0) {
    return {
      tipo: "falla",
      clase: "gate",
      motivo: `la revisión nombra sub-tasks que no existen: ${[...new Set(unknown.map((h) => h.subtarea))].join(", ")}; las válidas son ${ids.join(", ")}`,
    };
  }
  writeFileSync(join(run.dir, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
  for (const d of review.decisiones)
    emit({ tipo: "decision", fase: "revisar", que: d.que, por_que: d.por_que });
  for (const h of review.hallazgos.filter((x) => x.severidad === "aviso")) {
    emit({ tipo: "aviso", fase: "revisar", texto: `${h.archivo}:${h.linea}: ${h.afirmacion}` });
  }
  const blockers = review.hallazgos.filter((h) => h.severidad === "bloqueante");
  if (blockers.length === 0) return { tipo: "ok" };
  return {
    tipo: "vuelve",
    unidades: [...new Set(blockers.map((b) => b.subtarea))],
    motivo: `la revisión encontró bloqueantes:\n${blockers
      .map(
        (b) =>
          `- ${b.subtarea} · ${b.archivo}:${b.linea}: ${b.afirmacion}${b.regla === "" ? "" : ` (regla: ${b.regla})`}`,
      )
      .join("\n")}`,
  };
};
