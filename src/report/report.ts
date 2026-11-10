// El informe del run, armado solo con los eventos del log. Lo que escribió un modelo se muestra como
// texto: ningún `<` o `>` se interpreta.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { initialState, reduce, stateOf, type RunState } from "../engine/engine.ts";
import { AVISO_TEST_EXISTENTE } from "../gates/existente.ts";
import type { CambioExistente } from "../gates/plan.ts";
import { lastTestDir, readTests } from "../phases/probar.ts";
import { reviewSchema } from "../phases/revisar.ts";
import type { RunPaths } from "../runner/types.ts";
import { PHASES, type Origen, type Phase, type RunEvent } from "../store/events.ts";

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
  /** Los modelos de las sesiones de la fase, en el orden en que se usaron. */
  readonly modelos: string[];
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
        modelos: [],
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
        modelos: s.modelos.includes(e.modelo) ? s.modelos : [...s.modelos, e.modelo],
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

const two = (n: number) => String(n).padStart(2, "0");
/** La hora de un evento, en la hora local, como la ve la persona. */
function hour(at: string): string {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Cuánto tardó la persona en contestar: segundos, minutos o horas. */
function waited(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
  }
  const rest = minutes % 60;
  const hours = String(Math.floor(minutes / 60));
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest)} min`;
}

const MAX_CITA = 80;
/** Lo que escribió la persona, en una línea y corto: el texto entero está en el log. */
function quote(text: string): string {
  const one = text.replaceAll(/\s+/g, " ").trim();
  return `«${plain(one.length > MAX_CITA ? `${one.slice(0, MAX_CITA - 1)}…` : one)}»`;
}

/** Una decisión de la persona: qué decidió, de dónde vino, desde qué espera se mide y lo que va al final. */
interface Decided {
  readonly que: string;
  readonly origen: Origen | undefined;
  /** Aprobar y pedir cambios se miden desde que el plan esperó; lo demás, desde que el run se detuvo. */
  readonly alPlan: boolean;
  readonly cola: string;
}

function decided(e: RunEvent): Decided | undefined {
  switch (e.tipo) {
    case "aprobado": {
      const n = e.cambios_aceptados ?? 0;
      return {
        que: "aprobaste el plan",
        origen: e.origen,
        alPlan: true,
        cola: n === 0 ? "" : ` (${String(n)} ${n === 1 ? "cambio aceptado" : "cambios aceptados"})`,
      };
    }
    case "cambios_pedidos":
      return {
        que: "pediste cambios",
        origen: e.origen,
        alPlan: true,
        cola: `: ${quote(e.motivo)}`,
      };
    case "arreglo_pedido":
      return {
        que: `pediste que ${e.unidades.join(", ")} lo ${e.unidades.length === 1 ? "corrija" : "corrijan"}`,
        origen: e.origen,
        alPlan: false,
        cola: `: ${quote(e.instruccion)}`,
      };
    case "arreglo_manual_iniciado":
      return { que: "elegiste arreglarlo a mano", origen: e.origen, alPlan: false, cola: "" };
    case "aceptado":
      return {
        que: `aceptaste seguir con ${e.fase} en rojo`,
        origen: e.origen,
        alPlan: false,
        cola: `: ${quote(e.motivo)}`,
      };
    default:
      return undefined;
  }
}

/**
 * Cada decisión que el run tomó, con su hora, de dónde vino y cuánto tardó desde que el run te esperó:
 * aprobar o pedir cambios, desde el último `aprobar` que terminó en espera; responder una pregunta,
 * desde la última acción que dejó el run detenido. Solo las que el engine aplicó (ADR 0023). Es para
 * la persona: no va a la PR.
 */
function personDecisions(events: readonly RunEvent[]): string[] {
  const lines: string[] = [];
  let planWaiting: string | undefined;
  let stopped: string | undefined;
  replay(events, (e, before, after) => {
    if (e.tipo === "accion_terminada") {
      if (e.fase === "aprobar" && e.resultado.tipo === "espera") planWaiting = e.at;
      if (after.status === "detenido") stopped = e.at;
      return;
    }
    const decision = decided(e);
    if (decision === undefined || after === before) return;
    const since = decision.alPlan ? planWaiting : stopped;
    const origen =
      decision.origen === undefined ? "desde un origen desconocido" : `desde ${decision.origen}`;
    const demora =
      since === undefined
        ? ""
        : `, ${waited(Date.parse(e.at) - Date.parse(since))} después de que te esperó`;
    lines.push(`- ${hour(e.at)} · ${decision.que} ${origen}${demora}${decision.cola}`);
  });
  return lines.length === 0 ? [] : ["", "## Tus decisiones", "", ...lines];
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
    ...personDecisions(events),
    ...(existing.length === 0 ? [] : ["", ...existing]),
    ...accepted(events),
    ...tested(events, run, true),
    ...howToTest(run),
    ...decisions(events),
    "",
    "## Por fase",
    "",
  ];
  for (const s of summaries) {
    const models =
      s.modelos.length === 0
        ? ""
        : `, ${s.modelos.length === 1 ? "modelo" : "modelos"} ${s.modelos.join(", ")}`;
    lines.push(
      `- **${s.fase}:** ${s.minutos.toFixed(1)} min, ${usd(s.costoUsd)}, ${s.tokensEntrada + s.tokensSalida} tokens, ${s.ejecuciones} ${s.ejecuciones === 1 ? "ejecución" : "ejecuciones"}${models}`,
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

const RESULT = { ok: "✅", falla: "❌", no_probado: "⚪ sin probar" } as const;

/**
 * Lo que probó la fase probar en el entorno, prueba por prueba. Con `paths`, dónde quedó la evidencia:
 * el log de la API y los videos, que son locales y no van a la PR.
 */
export function testResults(dir: string, paths: boolean): string[] {
  const { pruebas, videos } = readTests(dir);
  if (pruebas === undefined) return ["La sesión no llegó a devolver las pruebas."];
  const lines = pruebas.pruebas.flatMap((p) => [
    `- ${RESULT[p.resultado]} **${p.criterio === "" ? "—" : plain(p.criterio)}** ${plain(p.que)}`,
    ...p.pasos.map((s, i) => `    ${String(i + 1)}. ${plain(s)}`),
    `    - Evidencia: ${plain(p.evidencia)}`,
  ]);
  if (!paths) return lines;
  const log = join(dir, "http.md");
  return [
    ...lines,
    "",
    `Evidencia en \`${dir}\`:`,
    ...(existsSync(log) ? [`- [Log de la API](${pathToFileURL(log).href})`] : []),
    ...videos.map((v) => `- [Video ${basename(v)}](${pathToFileURL(v).href})`),
  ];
}

function tested(events: readonly RunEvent[], run: RunPaths, paths: boolean): string[] {
  const dir = lastTestDir(run);
  if (dir === undefined) return [];
  // La última decisión manda: si el run se detuvo dos veces, vale el motivo de la que lo dejó seguir.
  // `accept` en probar dice lo mismo que `accept-untested` (ADR 0023).
  const taken = new Set(applied(events));
  const aceptado = events
    .flatMap((e) =>
      e.tipo === "sin_probar_aceptado" ||
      (e.tipo === "aceptado" && e.fase === "probar" && taken.has(e))
        ? [{ motivo: e.motivo }]
        : [],
    )
    .at(-1);
  return [
    "",
    "## Pruebas en el entorno",
    "",
    ...(aceptado === undefined
      ? []
      : [
          `> ⚠️ Se entregó con criterios sin probar, por decisión de la persona: ${plain(aceptado.motivo)}`,
          "",
        ]),
    ...testResults(dir, paths),
  ];
}

/**
 * Recorre el log como el engine: cada evento con el estado de antes y el de después. Un evento que el
 * engine ignoró deja el mismo estado, el mismo objeto.
 */
function replay(
  events: readonly RunEvent[],
  visit: (e: RunEvent, before: RunState, after: RunState) => void,
): void {
  let state = initialState();
  for (const e of events) {
    const next = reduce(state, e);
    visit(e, state, next);
    state = next;
  }
}

/**
 * Las respuestas de la persona que el run tomó: una que llegó cuando otra ya lo había hecho seguir
 * queda en el log, pero el engine la ignoró, y no va a la PR.
 */
function applied(events: readonly RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  replay(events, (e, before, after) => {
    if ((e.tipo === "aceptado" || e.tipo === "arreglo_manual") && after !== before) out.push(e);
  });
  return out;
}

/**
 * Lo que la persona dejó pasar o arregló a mano al responder una pregunta del run (ADR 0023): va a la
 * PR para que quien la revisa no lo apruebe sin verlo.
 */
function accepted(events: readonly RunEvent[]): string[] {
  const lines = applied(events).flatMap((e) =>
    e.tipo === "aceptado"
      ? [`- en ${e.fase}: ${plain(e.motivo)}`]
      : e.tipo === "arreglo_manual" && e.sha !== null
        ? [`- arreglo a mano: ${e.sha.slice(0, 7)}`]
        : [],
  );
  return lines.length === 0 ? [] : ["", "## Lo que aceptaste al seguir", "", ...lines];
}

/** El paso a paso para probar la feature a mano, que escribe la última revisión. */
function howToTest(run: RunPaths): string[] {
  const file = join(run.dir, "review.json");
  if (!existsSync(file)) return [];
  const review = reviewSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!review.success || review.data.como_probar.length === 0) return [];
  return [
    "",
    "## Cómo probarlo",
    "",
    ...review.data.como_probar.map((paso, i) => `${i + 1}. ${plain(paso)}`),
  ];
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
  const acceptedLines = accepted(events);
  return [
    ...existingChanges(events, run),
    // `accepted` empieza con una línea en blanco, y la PR no empieza con una.
    ...(acceptedLines.length === 0 ? [] : [...acceptedLines.slice(1), ""]),
    "## Criterios",
    "",
    criteria,
    ...tested(events, run, false),
    ...howToTest(run),
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
