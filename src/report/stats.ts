// `flowrunner stats`: qué pieza de la fábrica mejorar, juntando los logs de todos los runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateOf } from "../engine/engine.ts";
import { readLog } from "../store/run-log.ts";
import { listRunIds, runPaths } from "../store/runs.ts";
import type { Phase } from "../store/events.ts";
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
