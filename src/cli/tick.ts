// `flowrunner tick`, lo que corre launchd, y `flowrunner learn <run>`, lo mismo para un run a pedido.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { notifyMac } from "../notify/notify.ts";
import { productionRuntime } from "../runner/production.ts";
import { runUntilStop } from "../runner/runner.ts";
import { isAlive, tryLock } from "../store/lock.ts";
import type { Origen, RunEvent } from "../store/events.ts";
import { writeReport } from "../report/report.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { listRunIds, loadState, runPaths } from "../store/runs.ts";
import { UserError } from "./output.ts";
import {
  avisarCambio,
  despacharCola,
  lanzamiento,
  lanzarOEncolar,
  spawnRunProcess,
} from "./runs.ts";

/**
 * Por qué un run entregado sigue esperando: tu merge, o, con la PR ya mergeada, que otro run del
 * proyecto mergee su PR de lecciones (una PR de lecciones abierta a la vez).
 */
export function waitingReason(events: readonly RunEvent[]): string {
  return events.some((e) => e.tipo === "pr_cerrada" && e.mergeada)
    ? "PR mergeada: aprende cuando se mergee la PR de lecciones de otro run del proyecto"
    : "la PR sigue abierta";
}

const aprenderLock = (dir: string) => join(dir, "aprender.lock");

/** Aprende de un run entregado, si nadie más lo está haciendo. Devuelve el estado en que quedó. */
export async function learnRun(home: string, id: string, env: NodeJS.ProcessEnv): Promise<string> {
  const run = runPaths(home, id);
  const lock = aprenderLock(run.dir);
  if (!tryLock(lock)) return "otro proceso ya está aprendiendo de este run";
  try {
    // Con el candado tomado, otra vez: un `feedback` que entró antes lo puso a trabajar, y su proceso
    // ya corre aprender. Dos aprender a la vez gastaban el feedback dos veces y detenían el run.
    const ahora = loadState(home, id).status;
    if (ahora !== "entregado") return `ya no espera su merge: está ${ahora}`;
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

/** Solo se aprende de un run que existe y está entregado. */
function checkDelivered(home: string, id: string): void {
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
}

export async function learnOne(home: string, id: string, env: NodeJS.ProcessEnv) {
  checkDelivered(home, id);
  return { ok: true as const, id, resultado: await learnRun(home, id, env) };
}

/**
 * `learn --fondo`: aprende en un proceso aparte y contesta enseguida. Aprender lleva minutos (varias
 * sesiones de agente) y el panel de Orca corta cada comando a los 20 s: esperaba y mostraba «Command
 * failed» aunque el aprendizaje terminaba bien. El resultado llega como aviso.
 */
export function learnInBackground(home: string, id: string, env: NodeJS.ProcessEnv) {
  checkDelivered(home, id);
  const run = runPaths(home, id);
  const lock = aprenderLock(run.dir);
  if (existsSync(lock) && isAlive(Number(readFileSync(lock, "utf8")))) {
    return { ok: true as const, id, resultado: "otro proceso ya está aprendiendo de este run" };
  }
  spawnRunProcess(run, env, "_learn");
  return { ok: true as const, id, resultado: "aprendiendo: te aviso cuando termine" };
}

/** El proceso de `learn --fondo`: aprende y avisa en qué quedó, también si falló. */
export async function learnAndNotify(home: string, id: string, env: NodeJS.ProcessEnv) {
  const clave = loadState(home, id).clave;
  try {
    const resultado = await learnRun(home, id, env);
    notifyMac("flowrunner", `${clave}: ${resultado}`, env);
    return resultado;
  } catch (error) {
    notifyMac("flowrunner", `${clave}: no pude aprender. El detalle está en run.log`, env);
    throw error;
  }
}

/**
 * `feedback`: a la persona no le gustó la PR abierta y no la quiere mergear (ADR 0038). El run vuelve a
 * aprender, que evalúa el feedback y decide desde dónde rehacer. Con el candado de aprender: un tick
 * que está mirando la PR en ese momento terminaría con «la PR sigue abierta» y se tragaría el feedback.
 */
export function feedbackRun(
  home: string,
  id: string,
  texto: string,
  origen: Origen,
  env: NodeJS.ProcessEnv,
) {
  if (texto.trim() === "")
    throw new UserError(
      "falta el feedback: qué no te gustó de la PR",
      `flowrunner feedback ${id} "<qué no te gustó>"`,
    );
  const check = () => {
    let state;
    try {
      state = loadState(home, id);
    } catch {
      throw new UserError(`no existe el run ${id}`, "flowrunner status");
    }
    if (state.status !== "entregado" || state.prCerrada) {
      throw new UserError(
        state.status === "entregado"
          ? `la PR de ${id} ya se mergeó: el feedback va en una feature nueva`
          : `el run ${id} está ${state.status} en ${state.fase}: el feedback es para un run con la PR abierta`,
        `flowrunner status ${id}`,
      );
    }
  };
  check();
  const run = runPaths(home, id);
  const lock = aprenderLock(run.dir);
  if (!tryLock(lock))
    throw new UserError(
      `flowrunner está mirando la PR de ${id} en este momento: probá de nuevo en un minuto`,
      `flowrunner feedback ${id} "<qué no te gustó>"`,
    );
  try {
    // Otra vez con el candado: un tick pudo cerrar el run entre la primera lectura y el candado, y el
    // feedback se ignoraría mientras la respuesta dice «evaluando».
    check();
    appendEvent(run.dir, { tipo: "feedback_pedido", texto: texto.trim(), origen });
  } finally {
    rmSync(lock, { force: true });
  }
  return lanzamiento(
    id,
    "feedback recibido: evaluando desde dónde rehacer",
    "feedback recibido",
    lanzarOEncolar(home, id, env),
  );
}
