// `flowrunner tick`, lo que corre launchd, y `flowrunner learn <run>`, lo mismo para un run a pedido.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyMac } from "../notify/notify.ts";
import { productionRuntime } from "../runner/production.ts";
import { runUntilStop } from "../runner/runner.ts";
import { isAlive } from "../store/lock.ts";
import type { RunEvent } from "../store/events.ts";
import { writeReport } from "../report/report.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { listRunIds, loadState, runPaths } from "../store/runs.ts";
import { UserError } from "./output.ts";
import { avisarCambio, despacharCola, lanzarOEncolar } from "./runs.ts";

/** Un lock de archivo con el pid: si el dueño murió, se toma. */
function tryLock(file: string): boolean {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    const pid = Number(readFileSync(file, "utf8"));
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) return false;
    writeFileSync(file, String(process.pid));
    return true;
  }
}

/**
 * Por qué un run entregado sigue esperando: tu merge, o, con la PR ya mergeada, que otro run del
 * proyecto termine de publicar sus lecciones (una PR de lecciones a la vez).
 */
export function waitingReason(events: readonly RunEvent[]): string {
  return events.some((e) => e.tipo === "pr_cerrada" && e.mergeada)
    ? "PR mergeada: aprende cuando otro run del proyecto termine de publicar sus lecciones"
    : "la PR sigue abierta";
}

/** Aprende de un run entregado, si nadie más lo está haciendo. Devuelve el estado en que quedó. */
export async function learnRun(home: string, id: string, env: NodeJS.ProcessEnv): Promise<string> {
  const run = runPaths(home, id);
  const lock = join(run.dir, "aprender.lock");
  if (!tryLock(lock)) return "otro proceso ya está aprendiendo de este run";
  try {
    const { deps, phases } = await productionRuntime(env, (t, b) => {
      notifyMac(t, b, env);
    });
    const final = await runUntilStop(run, phases, deps, { tick: true });
    // Al cerrarse, el informe final suma lo que pasó después de la entrega: el merge y lo aprendido.
    if (final.status !== "entregado") writeReport(run, readLog(run.dir).events);
    return final.status === "entregado"
      ? waitingReason(readLog(run.dir).events)
      : `quedó ${final.status}`;
  } finally {
    rmSync(lock, { force: true });
  }
}

export async function tick(home: string, env: NodeJS.ProcessEnv, now: Date) {
  const lock = join(home, "tick.lock");
  if (!tryLock(lock)) return { ok: true as const, acciones: ["otro tick está corriendo"] };
  const acciones: string[] = [];
  try {
    const conCola = new Set<string>();
    for (const id of listRunIds(home)) {
      const state = loadState(home, id);
      if (state.status === "pausado_por_limite" && (state.pausaHasta ?? 0) <= now.getTime()) {
        appendEvent(runPaths(home, id).dir, { tipo: "reanudado" });
        const lanzado = lanzarOEncolar(home, id, env);
        avisarCambio(home, id, "pausado_por_limite", env);
        acciones.push(
          lanzado.tipo === "lanzado"
            ? `${id}: retomado después del límite`
            : `${id}: listo después del límite, en cola (${String(lanzado.posicion)}.º)`,
        );
      } else if (state.status === "entregado") {
        acciones.push(`${id}: ${await learnRun(home, id, env)}`);
      } else if (state.status === "en_cola") {
        conCola.add(state.proyecto);
      }
    }
    // El respaldo de la cola: el proceso que soltó un lugar pudo morir sin despacharla.
    for (const proyecto of conCola) {
      for (const id of despacharCola(home, proyecto, env)) acciones.push(`${id}: salió de la cola`);
    }
  } finally {
    rmSync(lock, { force: true });
  }
  return { ok: true as const, acciones };
}

export async function learnOne(home: string, id: string, env: NodeJS.ProcessEnv) {
  let state;
  try {
    state = loadState(home, id);
  } catch {
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  }
  if (state.status !== "entregado") {
    throw new UserError(
      `el run ${id} está ${state.status}: solo se aprende de un run entregado`,
      `flowrunner status ${id}`,
    );
  }
  return { ok: true as const, id, resultado: await learnRun(home, id, env) };
}
