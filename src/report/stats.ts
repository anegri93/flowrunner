// `flowrunner stats`: qué pieza de la fábrica mejorar, juntando los logs de todos los runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateOf, type RunStatus } from "../engine/engine.ts";
import { readLog } from "../store/run-log.ts";
import { listRunIds, runPaths } from "../store/runs.ts";
import type { Phase, RunEvent } from "../store/events.ts";
import { phaseSummaries } from "./report.ts";

/** El motivo sin lo que cambia entre runs: rutas, ids de sub-tasks y números. */
export function motiveKey(motivo: string): string {
  return (motivo.split("\n")[0] ?? "")
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, "<ruta>")
    .replace(/\b(?:ST|AC)-\d+\b/g, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

export interface PhaseStats {
  readonly fase: Phase;
  readonly reintentos: number;
  readonly costoUsd: number;
  readonly minutos: number;
}

export function stats(home: string, project?: string) {
  const byPhase = new Map<Phase, PhaseStats>();
  const motives = new Map<string, number>();
  const rejections = new Map<string, number>();
  let runs = 0;
  let lessons = 0;
  for (const id of listRunIds(home)) {
    const dir = runPaths(home, id).dir;
    if (!existsSync(join(dir, "events.jsonl"))) continue;
    const { events } = readLog(dir);
    if (events.length === 0) continue;
    if (project !== undefined && stateOf(events).proyecto !== project) continue;
    runs++;
    for (const s of phaseSummaries(events)) {
      const prev = byPhase.get(s.fase) ?? { fase: s.fase, reintentos: 0, costoUsd: 0, minutos: 0 };
      byPhase.set(s.fase, {
        fase: s.fase,
        reintentos: prev.reintentos + s.fallas.length + s.vueltas.length,
        costoUsd: prev.costoUsd + s.costoUsd,
        minutos: prev.minutos + s.minutos,
      });
      for (const m of [
        ...s.fallas.map((f) => `${s.fase} · ${f.clase}: ${motiveKey(f.motivo)}`),
        ...s.vueltas.map((v) => `${s.fase} · vuelta: ${motiveKey(v)}`),
      ]) {
        motives.set(m, (motives.get(m) ?? 0) + 1);
      }
    }
    for (const e of events) {
      if (e.tipo === "rechazo")
        rejections.set(motiveKey(e.motivo), (rejections.get(motiveKey(e.motivo)) ?? 0) + 1);
      if (e.tipo === "lecciones") lessons += e.cantidad;
    }
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([motivo, veces]) => ({ motivo, veces }));
  return {
    ok: true as const,
    runs,
    fases: [...byPhase.values()].sort((a, b) => b.reintentos - a.reintentos),
    motivos: top(motives),
    rechazos: top(rejections),
    lecciones: lessons,
  };
}

export function describeStats(s: ReturnType<typeof stats>): string {
  const lines = [
    `${String(s.runs)} runs · ${String(s.lecciones)} lecciones`,
    "",
    "Por fase, la que más reintenta primero:",
  ];
  for (const f of s.fases) {
    lines.push(
      `  ${f.fase}: ${String(f.reintentos)} reintentos y vueltas, USD ${f.costoUsd.toFixed(2)}, ${f.minutos.toFixed(1)} min`,
    );
  }
  if (s.motivos.length > 0)
    lines.push(
      "",
      "Motivos más frecuentes:",
      ...s.motivos.map((m) => `  ${String(m.veces)}× ${m.motivo}`),
    );
  if (s.rechazos.length > 0)
    lines.push(
      "",
      "Rechazos de tripwires:",
      ...s.rechazos.map((m) => `  ${String(m.veces)}× ${m.motivo}`),
    );
  return lines.join("\n");
}

// `flowrunner stats --runs`: la línea de base del plan de raíz, un renglón por run.

export interface RunStats {
  readonly id: string;
  readonly proyecto: string;
  readonly status: RunStatus;
  readonly activoMin: number;
  readonly costoUsd: number;
  readonly costoPorFase: Partial<Record<Phase, number>>;
  readonly planes: number;
  readonly rechazosBash: number;
  readonly rechazosEscritura: number;
  readonly vueltas: number;
  readonly fallas: number;
  readonly derecho: boolean;
  readonly graftPlanificar: {
    readonly llamadas: number;
    readonly reads: number;
    readonly turnos: number;
  };
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Los números de un run, de su log y de las sesiones de planificar. */
export function runStats(dir: string, events: readonly RunEvent[]): RunStats {
  const state = stateOf(events);
  let activeMs = 0;
  let openedAt: number | undefined;
  let costoUsd = 0;
  const costoPorFase: Partial<Record<Phase, number>> = {};
  let planes = 0;
  let rechazosBash = 0;
  let rechazosEscritura = 0;
  let vueltas = 0;
  let fallas = 0;
  for (const e of events) {
    if (e.tipo === "accion_iniciada") {
      openedAt = Date.parse(e.at);
      if (e.fase === "planificar") planes++;
    } else if (e.tipo === "accion_terminada") {
      if (openedAt !== undefined) activeMs += Date.parse(e.at) - openedAt;
      openedAt = undefined;
      if (e.resultado.tipo === "vuelve") vueltas++;
      if (e.resultado.tipo === "falla") fallas++;
    } else if (e.tipo === "uso") {
      costoUsd += e.costo_usd;
      costoPorFase[e.fase] = (costoPorFase[e.fase] ?? 0) + e.costo_usd;
    } else if (e.tipo === "rechazo") {
      if (e.herramienta === "Bash") rechazosBash++;
      else if (WRITE_TOOLS.has(e.herramienta)) rechazosEscritura++;
    }
  }
  // Un proceso cortado deja la acción sin terminar: cuenta hasta lo último que se sabe del run.
  const last = events.at(-1);
  if (openedAt !== undefined && last !== undefined) activeMs += Date.parse(last.at) - openedAt;
  return {
    id: state.runId,
    proyecto: state.proyecto,
    status: state.status,
    activoMin: activeMs / 60_000,
    costoUsd,
    costoPorFase,
    planes,
    rechazosBash,
    rechazosEscritura,
    vueltas,
    fallas,
    derecho: vueltas === 0 && fallas === 0,
    graftPlanificar: planningSessions(join(dir, "sesiones")),
  };
}

/** Una línea del stream de una sesión: solo lo que se cuenta. Lo que no se reconoce suma 0. */
const assistantLineSchema = z.object({
  type: z.literal("assistant"),
  message: z
    .object({ content: z.array(z.unknown()).catch([]) })
    .optional()
    .catch(undefined),
});
const toolUseSchema = z.object({ type: z.literal("tool_use"), name: z.string() });

/** Turnos, `Read` y llamadas a graft de las sesiones de planificar (`sesiones/planificar-*.jsonl`). */
function planningSessions(dir: string): RunStats["graftPlanificar"] {
  let llamadas = 0;
  let reads = 0;
  let turnos = 0;
  if (!existsSync(dir)) return { llamadas, reads, turnos };
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("planificar-") || !file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // una sesión cortada deja su última línea a medias
      }
      const turn = assistantLineSchema.safeParse(parsed);
      if (!turn.success) continue;
      turnos++;
      for (const block of turn.data.message?.content ?? []) {
        const tool = toolUseSchema.safeParse(block);
        if (!tool.success) continue;
        if (tool.data.name === "Read") reads++;
        else if (tool.data.name.startsWith("mcp__graft__")) llamadas++;
      }
    }
  }
  return { llamadas, reads, turnos };
}

/** El promedio de los dos del medio si son pares; 0 sin valores. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function statsPorRun(home: string, project?: string) {
  const loaded: { createdAt: number; stats: RunStats }[] = [];
  for (const id of listRunIds(home)) {
    const dir = runPaths(home, id).dir;
    const { events } = readLog(dir);
    const first = events[0];
    if (first === undefined) continue;
    const s = runStats(dir, events);
    if (project !== undefined && s.proyecto !== project) continue;
    loaded.push({ createdAt: Date.parse(first.at), stats: s });
  }
  // En el orden en que se crearon: el nombre ordena por clave, no por fecha.
  const runs = loaded.sort((a, b) => a.createdAt - b.createdAt).map((r) => r.stats);
  const sum = (f: (r: RunStats) => number) => runs.reduce((acc, r) => acc + f(r), 0);
  const perRun = (total: number) => (runs.length === 0 ? 0 : total / runs.length);
  const costo = sum((r) => r.costoUsd);
  return {
    ok: true as const,
    runs,
    resumen: {
      runs: runs.length,
      medianaActivoMin: median(runs.map((r) => r.activoMin)),
      medianaCostoUsd: median(runs.map((r) => r.costoUsd)),
      planificarPct: costo === 0 ? 0 : (100 * sum((r) => r.costoPorFase.planificar ?? 0)) / costo,
      planesPorRun: perRun(sum((r) => r.planes)),
      rechazosBashPorRun: perRun(sum((r) => r.rechazosBash)),
      derechos: runs.filter((r) => r.derecho).length,
    },
  };
}

export function describeStatsPorRun(s: ReturnType<typeof statsPorRun>): string {
  const header = ["id", "activo", "US$", "planes", "rechazos", "vueltas", "derecho"];
  const rows = s.runs.map((r) => [
    r.id,
    `${r.activoMin.toFixed(0)} min`,
    r.costoUsd.toFixed(2),
    String(r.planes),
    `${String(r.rechazosBash)}/${String(r.rechazosEscritura)}`,
    String(r.vueltas),
    r.derecho ? "sí" : "no",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  const r = s.resumen;
  return [
    line(header),
    ...rows.map(line),
    "",
    `mediana activo: ${r.medianaActivoMin.toFixed(1)} min`,
    `mediana US$: ${r.medianaCostoUsd.toFixed(2)}`,
    `planificar: ${r.planificarPct.toFixed(0)}% del costo`,
    `planes por run: ${r.planesPorRun.toFixed(1)}`,
    `rechazos de Bash por run: ${r.rechazosBashPorRun.toFixed(1)} (la columna rechazos es Bash/escritura)`,
    `derechos: ${String(r.derechos)} de ${String(r.runs)} runs`,
  ].join("\n");
}
