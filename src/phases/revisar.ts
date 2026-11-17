// Revisar: una sesión de Opus de solo lectura contrasta el diff con el plan y el cerebro. Los
// bloqueantes devuelven su sub-task a implementar; los avisos van al informe.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { WRITE_TOOLS } from "../tripwires/rules.ts";
import type { Arreglo, RunEvent } from "../store/events.ts";
import { featureWorktree, graftIndex, prepared, runFeature } from "./inputs.ts";
import { brainVars, readPlan, sessionName } from "./planificar.ts";

export const findingSchema = z.object({
  severidad: z.enum(["bloqueante", "aviso"]),
  archivo: z.string(),
  linea: z.int().nonnegative(),
  afirmacion: z.string().min(1),
  regla: z.string(),
  subtarea: z.string(),
  /**
   * De 1 a 3 arreglos concretos de un bloqueante, cada uno una instrucción para la sub-task, en una
   * línea (ADR 0028). Con default: un review.json de antes de este campo se sigue leyendo.
   */
  arreglos: z.array(z.string()).default([]),
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
/** Los arreglos que se ofrecen por bloqueante: más que eso es una lista, no una opción. */
const MAX_ARREGLOS = 3;

/**
 * Los arreglos de los bloqueantes, como opciones para la persona: en una línea, sin repetir, y hasta
 * `MAX_ARREGLOS` por bloqueante. Undefined si el revisor no propuso ninguno.
 */
function arreglosDe(blockers: readonly z.infer<typeof findingSchema>[]): Arreglo[] | undefined {
  const seen = new Set<string>();
  const out: Arreglo[] = [];
  for (const b of blockers) {
    const lines = b.arreglos.map((a) => a.replaceAll(/\s+/g, " ").trim()).filter((a) => a !== "");
    for (const instruccion of lines.slice(0, MAX_ARREGLOS)) {
      const key = `${b.subtarea}\0${instruccion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ unidad: b.subtarea, instruccion });
    }
  }
  return out.length === 0 ? undefined : out;
}

/** Un diff más largo que esto se corta en el prompt; el revisor puede leer los archivos con Read. */
export const MAX_DIFF_CHARS = 60_000;

/** Lo que se le muestra a revisar del script de verify: alcanza para saber qué comprueba. */
const MAX_VERIFY_CHARS = 2_000;

/**
 * Qué comprobó verify antes de esta revisión: si pasó o si la persona aceptó el rojo, y lo que corre el
 * script. Formato, lint y tipos los decide verify, no la revisión (PIZ-15, ADR 0030).
 */
export function verifyText(events: readonly RunEvent[], path: string, script: string): string {
  const last = events.findLastIndex((e) => e.tipo === "accion_terminada" && e.fase === "verificar");
  const ended = events[last];
  const accepted = events
    .slice(last + 1)
    .findLast((e) => e.tipo === "aceptado" && e.fase === "verificar");
  const how =
    ended?.tipo === "accion_terminada" && ended.resultado.tipo === "ok"
      ? "pasó sobre esta rama"
      : accepted?.tipo === "aceptado"
        ? `quedó en rojo y la persona lo aceptó: «${accepted.motivo}»`
        : "no pasó sobre esta rama";
  const body =
    script.length > MAX_VERIFY_CHARS ? `${script.slice(0, MAX_VERIFY_CHARS)}\n…` : script.trimEnd();
  return `verify (\`${path}\`) ${how}. Corre:\n\n\`\`\`sh\n${body}\n\`\`\``;
}

/**
 * Las vueltas de revisar desde la última aprobación del plan: cada bloqueante y lo que hizo cada
 * sub-task con él. Así la revisión comprueba lo que se arregló y no repite a ciegas lo que una sub-task
 * contestó que no hacía falta (PIZ-15, ADR 0030).
 */
export function revisionesAnteriores(events: readonly RunEvent[]): string {
  // Un rerun descarta las vueltas de antes, como hace el engine con `vueltas`.
  const since = events.findLastIndex((e) => e.tipo === "aprobado" || e.tipo === "rehacer");
  const rounds: { motivo: string; hechos: string[] }[] = [];
  // La vuelta que están trabajando las sub-tasks: una de verificar o probar no es de la revisión.
  let round: { motivo: string; hechos: string[] } | undefined;
  for (const e of events.slice(since + 1)) {
    if (e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve") {
      round = e.fase === "revisar" ? { motivo: e.resultado.motivo, hechos: [] } : undefined;
      if (round !== undefined) rounds.push(round);
    }
    if (round === undefined) continue;
    if (e.tipo === "arreglo_manual")
      round.hechos.push(
        `- La persona lo arregló a mano en el worktree${e.sha === null ? "" : ` (${e.sha.slice(0, 7)})`}.`,
      );
    if (e.tipo === "autofix") round.hechos.push("- Autofix pasó el formateador y el lint.");
    if (e.tipo !== "unidad" || e.fase !== "implementar") continue;
    if (e.estado === "integrada")
      round.hechos.push(
        `- ${e.unidad} cambió su código${e.sha === undefined ? "" : ` (${e.sha.slice(0, 7)})`}.`,
      );
    if (e.estado === "sin_cambios")
      round.hechos.push(
        `- ${e.unidad} no cambió nada.${e.motivo === undefined ? "" : ` Dijo: «${e.motivo.replace(/\s+/g, " ")}»`}`,
      );
  }
  if (rounds.length === 0) return "Es la primera revisión de este plan.";
  return rounds
    .map((r, i) =>
      [
        `## Vuelta ${i + 1}`,
        "",
        r.motivo,
        "",
        ...(r.hechos.length === 0
          ? ["Las sub-tasks todavía no la trabajaron."]
          : ["Lo que hicieron las sub-tasks:", ...r.hechos]),
      ].join("\n"),
    )
    .join("\n\n");
}

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

/**
 * El script de verify, o por qué no se pudo leer: la revisión sigue igual. Un link no se sigue, como en
 * `runVerify`: podría llevar al prompt un archivo de fuera del repo.
 */
function readScript(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return "(es un link: flowrunner no sigue links)";
    return readFileSync(path, "utf8");
  } catch (error) {
    return `(no se pudo leer: ${error instanceof Error ? error.message : String(error)})`;
  }
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
        verify: verifyText(ctx.events, config.verify, readScript(join(worktree, config.verify))),
        anteriores: revisionesAnteriores(ctx.events),
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
            comandos: SIN_COMANDOS,
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
  const arreglos = arreglosDe(blockers);
  return {
    tipo: "vuelve",
    unidades: [...new Set(blockers.map((b) => b.subtarea))],
    ...(arreglos === undefined ? {} : { arreglos }),
    motivo: `la revisión encontró bloqueantes:\n${blockers
      .map(
        (b) =>
          `- ${b.subtarea} · ${b.archivo}:${b.linea}: ${b.afirmacion}${b.regla === "" ? "" : ` (regla: ${b.regla})`}`,
      )
      .join("\n")}`,
  };
};
