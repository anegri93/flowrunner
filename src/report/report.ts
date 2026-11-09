// El informe del run, armado solo con los eventos del log. Lo que escribió un modelo se muestra como
// texto: ningún `<` o `>` se interpreta.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateOf } from "../engine/engine.ts";
import { AVISO_TEST_EXISTENTE } from "../gates/existente.ts";
import type { CambioExistente } from "../gates/plan.ts";
import type { RunPaths } from "../runner/types.ts";
import { PHASES, type Phase, type RunEvent } from "../store/events.ts";

/** Texto de un modelo o de un comando, seguro para Markdown: sin HTML. */
export const plain = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface PhaseSummary {
  readonly fase: Phase;
  readonly minutos: number;
  readonly costoUsd: number;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly ejecuciones: number;
  readonly fallas: { readonly clase: string; readonly motivo: string }[];
  readonly vueltas: string[];
}

export function phaseSummaries(events: readonly RunEvent[]): PhaseSummary[] {
  const out = new Map<Phase, PhaseSummary>();
  const get = (fase: Phase) => {
    let s = out.get(fase);
    if (s === undefined) {
      s = {
        fase,
        minutos: 0,
        costoUsd: 0,
        tokensEntrada: 0,
        tokensSalida: 0,
        ejecuciones: 0,
        fallas: [],
        vueltas: [],
      };
      out.set(fase, s);
    }
    return s;
  };
  const opened = new Map<Phase, number>();
  for (const e of events) {
    if (e.tipo === "accion_iniciada") opened.set(e.fase, Date.parse(e.at));
    else if (e.tipo === "accion_terminada") {
      const s = get(e.fase);
      const start = opened.get(e.fase);
      const mins = start === undefined ? 0 : (Date.parse(e.at) - start) / 60_000;
      out.set(e.fase, {
        ...s,
        minutos: s.minutos + mins,
        ejecuciones: s.ejecuciones + 1,
        fallas:
          e.resultado.tipo === "falla"
            ? [...s.fallas, { clase: e.resultado.clase, motivo: e.resultado.motivo }]
            : s.fallas,
        vueltas: e.resultado.tipo === "vuelve" ? [...s.vueltas, e.resultado.motivo] : s.vueltas,
      });
    } else if (e.tipo === "uso") {
      const s = get(e.fase);
      out.set(e.fase, {
        ...s,
        costoUsd: s.costoUsd + e.costo_usd,
        tokensEntrada: s.tokensEntrada + e.tokens_entrada,
        tokensSalida: s.tokensSalida + e.tokens_salida,
      });
    }
  }
  return PHASES.flatMap((f) => {
    const s = out.get(f);
    return s === undefined ? [] : [s];
  });
}

const usd = (n: number) => `USD ${n.toFixed(2)}`;

function header(events: readonly RunEvent[], run: RunPaths): string[] {
  const state = stateOf(events);
  const pr = events.findLast((e) => e.tipo === "pr");
  let title = state.clave;
  const featureFile = join(run.dir, "feature.md");
  if (existsSync(featureFile)) {
    const match = /^titulo:\s*(.+)$/m.exec(readFileSync(featureFile, "utf8"));
    if (match?.[1] !== undefined) title = `${state.clave} · ${match[1].trim()}`;
  }
  const lines = [`# ${plain(title)}`, "", `- **Estado:** ${state.status}, en ${state.fase}`];
  if (pr?.tipo === "pr") lines.push(`- **PR:** ${pr.url}`);
  lines.push(`- **Costo estimado:** ${usd(state.costoUsd)}`);
  if (state.status === "detenido" && state.halt !== undefined) {
    lines.push(
      "",
      "## Se detuvo",
      "",
      plain(state.halt.motivo),
      "",
      `Para seguir: \`${state.halt.siguiente}\``,
    );
  }
  return lines;
}

function decisions(events: readonly RunEvent[]): string[] {
  const byPhase = new Map<string, string[]>();
  for (const e of events) {
    if (e.tipo !== "decision") continue;
    const key = e.unidad === undefined ? e.fase : `${e.fase} · ${e.unidad}`;
    byPhase.set(key, [...(byPhase.get(key) ?? []), `- ${plain(e.que)}: ${plain(e.por_que)}`]);
  }
  if (byPhase.size === 0) return [];
  return [
    "",
    "## Decisiones",
    ...[...byPhase.entries()].flatMap(([k, v]) => ["", `### ${k}`, "", ...v]),
  ];
}

export function buildReport(events: readonly RunEvent[], run: RunPaths): string {
  const summaries = phaseSummaries(events);
  const existing = existingChanges(events, run);
  const lines = [
    ...header(events, run),
    ...(existing.length === 0 ? [] : ["", ...existing]),
    ...decisions(events),
    "",
    "## Por fase",
    "",
  ];
  for (const s of summaries) {
    lines.push(
      `- **${s.fase}:** ${s.minutos.toFixed(1)} min, ${usd(s.costoUsd)}, ${s.tokensEntrada + s.tokensSalida} tokens, ${s.ejecuciones} ${s.ejecuciones === 1 ? "ejecución" : "ejecuciones"}`,
    );
  }
  const gate = summaries.flatMap((s) =>
    s.fallas.filter((f) => f.clase === "gate").map((f) => `- ${s.fase}: ${plain(f.motivo)}`),
  );
  const infra = summaries.flatMap((s) =>
    s.fallas.filter((f) => f.clase === "infra").map((f) => `- ${s.fase}: ${plain(f.motivo)}`),
  );
  const rounds = summaries.flatMap((s) =>
    s.vueltas.map((v) => `- ${s.fase} devolvió trabajo: ${plain(v)}`),
  );
  if (rounds.length > 0) lines.push("", "## Vueltas", "", ...rounds);
  if (gate.length > 0) lines.push("", "## Reintentos por gate", "", ...gate);
  if (infra.length > 0) lines.push("", "## Fallas de infraestructura", "", ...infra);
  const rejections = events.flatMap((e) =>
    e.tipo === "rechazo" ? [`- ${e.unidad ?? e.fase} · ${e.herramienta}: ${plain(e.motivo)}`] : [],
  );
  if (rejections.length > 0) lines.push("", "## Rechazos de tripwires", "", ...rejections);
  const warnings = events.flatMap((e) => (e.tipo === "aviso" ? [`- ${plain(e.texto)}`] : []));
  if (warnings.length > 0) lines.push("", "## Avisos de la revisión", "", ...warnings);
  return `${lines.join("\n")}\n`;
}

export function writeReport(run: RunPaths, events: readonly RunEvent[]): string {
  const text = buildReport(events, run);
  writeFileSync(join(run.dir, "informe.md"), text);
  return text;
}

/** Lo que el run propone sumar al cerebro, o por qué no propone nada. */
function proposed(run: RunPaths): string[] {
  const file = join(run.dir, "lecciones-propuestas.md");
  if (!existsSync(file)) return [];
  return ["", "## Lo que aprendió este run", "", plain(readFileSync(file, "utf8").trim())];
}

/**
 * Lo que flowrunner cambió en los tests bloqueados, para que la persona lo revise: el lint y el
 * formato que les pasó, y las reparaciones. Son los avisos que escribe flowrunner mismo.
 */
function testChanges(events: readonly RunEvent[]): string[] {
  const changes = events.flatMap((e) =>
    e.tipo === "aviso" && e.texto.startsWith("flowrunner ") ? [`- ${plain(e.texto)}`] : [],
  );
  return changes.length === 0
    ? []
    : ["", "## Cambios de flowrunner en los tests de criterios", "", ...changes];
}

/**
 * Lo que la PR cambia de lo que ya existía: lo que el plan declaró y la persona aceptó al aprobar, y
 * los tests existentes que una sub-task tocó sin que el plan lo dijera. Va primero en la PR porque es
 * lo que más fácil se aprueba sin ver.
 */
function existingChanges(events: readonly RunEvent[], run: RunPaths): string[] {
  const file = join(run.dir, "cambios-existentes.json");
  const declared = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as CambioExistente[])
    : [];
  const undeclaredTests = [
    ...new Set(
      events.flatMap((e) =>
        e.tipo === "aviso" && e.texto.startsWith(AVISO_TEST_EXISTENTE)
          ? [e.texto.slice(AVISO_TEST_EXISTENTE.length)]
          : [],
      ),
    ),
  ];
  if (declared.length === 0 && undeclaredTests.length === 0) return [];
  return [
    "## ⚠ Cambia lo que ya existe",
    "",
    ...declared.map(
      (c) =>
        `- ${plain(c.que)} (\`${plain(c.donde)}\`) ← ${plain(c.criterio)}. Aceptado al aprobar.`,
    ),
    ...undeclaredTests.map((t) => `- **Sin declarar en el plan:** ${plain(t)}.`),
    "",
  ];
}

/** El cuerpo de la PR: el plan, los criterios y las decisiones, sin el detalle de costos. */
export function prBody(events: readonly RunEvent[], run: RunPaths): string {
  const planFile = join(run.dir, "plan.md");
  const plan = existsSync(planFile) ? readFileSync(planFile, "utf8").trim() : "";
  const featureFile = join(run.dir, "feature.md");
  const criteria = existsSync(featureFile)
    ? (
        /## Criterios\n([\s\S]*?)(\n## |$)/.exec(readFileSync(featureFile, "utf8"))?.[1] ?? ""
      ).trim()
    : "";
  return [
    ...existingChanges(events, run),
    "## Criterios",
    "",
    criteria,
    "",
    "## Plan",
    "",
    plain(plan),
    ...decisions(events),
    ...testChanges(events),
    ...proposed(run),
    "",
    "---",
    "Abierta por flowrunner. El informe completo del run está en `flowrunner report " +
      run.id +
      "`.",
    "",
  ].join("\n");
}
