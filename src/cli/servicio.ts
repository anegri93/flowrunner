// `flowrunner servicio <run> levantar|parar`: el entorno de la feature arriba para que la persona la
// pruebe a mano mientras la PR está abierta (ADR 0042). Lo levanta un proceso aparte, `_servicio`,
// con el `probar.levantar` del repo, y tiene el turno del entorno del proyecto mientras está arriba:
// verificar y probar de otro run esperan, como con un probar largo. Lo baja `parar`, o él solo cuando
// el run deja de tener la PR abierta: se mergeó, se abortó o volvió a trabajar.
import { spawn } from "node:child_process";
import { existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadRepoConfig } from "../config/load.ts";
import { notifyMac } from "../notify/notify.ts";
import { featureWorktree } from "../phases/inputs.ts";
import { levantarEntorno } from "../probar/entorno.ts";
import type { RunState } from "../engine/engine.ts";
import { isAlive, tryLock } from "../store/lock.ts";
import { loadState, runPaths } from "../store/runs.ts";
import {
  escribirServicio,
  leerServicio,
  servicioActivo,
  servicioLog,
  type Servicio,
} from "../store/servicio.ts";
import { intentarTurno, leerTurno, soltarTurno, turnoFile } from "../store/turno.ts";
import { UserError } from "./output.ts";
import { BIN } from "./runs.ts";

/** Cada cuánto el proceso mira si lo pararon o si el run dejó de tener la PR abierta. */
const PAUSA_MS = 2_000;

const conPrAbierta = (s: RunState) => s.status === "entregado" && !s.prCerrada;

function estadoDe(home: string, id: string): RunState {
  try {
    return loadState(home, id);
  } catch {
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  }
}

/** La config de probar del worktree de la feature, que es el código que se levanta. */
function probarDe(home: string, id: string) {
  const worktree = featureWorktree(runPaths(home, id));
  if (!existsSync(worktree))
    throw new UserError(`el run ${id} ya no tiene su worktree`, `flowrunner status ${id}`);
  const probar = loadRepoConfig(worktree).probar;
  if (probar === undefined)
    throw new UserError(
      "el repo no dice cómo levantar el entorno: falta `probar` en .flowrunner/config.yaml",
    );
  return { worktree, probar };
}

const listaDeUrls = (urls: Record<string, string>) =>
  Object.entries(urls)
    .map(([nombre, url]) => `${nombre} ${url}`)
    .join(", ");

export function levantarServicio(home: string, id: string, env: NodeJS.ProcessEnv, now: Date) {
  const state = estadoDe(home, id);
  if (!conPrAbierta(state))
    throw new UserError(
      `el run ${id} está ${state.status}: el servicio es para probar la feature con la PR abierta`,
      `flowrunner status ${id}`,
    );
  const { probar } = probarDe(home, id);
  const run = runPaths(home, id);
  // Con candado: dos pedidos casi juntos lanzaban dos procesos, y el segundo pisaba el estado del primero.
  const candado = join(run.dir, "servicio.lanzando");
  if (!tryLock(candado)) return { ok: true as const, id, accion: "ya se está levantando" };
  try {
    const actual = leerServicio(run, now);
    if (servicioActivo(actual))
      return { ok: true as const, id, accion: `el servicio ya está ${actual?.estado ?? ""}` };
    const dueño = leerTurno(turnoFile(home, state.proyecto, "entorno"));
    if (dueño !== undefined && isAlive(dueño.pid))
      throw new UserError(
        `el entorno de ${state.proyecto} lo tiene ${dueño.run_id}: levantalo cuando lo suelte`,
        `flowrunner status ${dueño.run_id}`,
      );
    escribirServicio(run, {
      estado: "levantando",
      pid: null,
      inicio: now.toISOString(),
      urls: probar.urls,
      mensaje: "levantando el servicio",
    });
    const log = openSync(servicioLog(run), "a");
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", BIN, "_servicio", id],
      { detached: true, stdio: ["ignore", log, log], env },
    );
    child.unref();
    return { ok: true as const, id, accion: "levantando el servicio: te aviso cuando responda" };
  } finally {
    rmSync(candado, { force: true });
  }
}

export function pararServicio(home: string, id: string, now: Date) {
  estadoDe(home, id);
  const actual = leerServicio(runPaths(home, id), now);
  if (actual?.estado === "parando")
    return { ok: true as const, id, accion: "el servicio ya se está bajando" };
  if (!servicioActivo(actual))
    throw new UserError(
      `el servicio de ${id} no está arriba`,
      `flowrunner servicio ${id} levantar`,
    );
  if (actual?.pid == null)
    throw new UserError("el servicio está arrancando: probá de nuevo en unos segundos");
  try {
    process.kill(actual.pid, "SIGTERM");
  } catch {
    // Terminó entre la lectura y la señal: ya está abajo.
  }
  return { ok: true as const, id, accion: "bajando el servicio" };
}

/**
 * El proceso de `_servicio`: toma el turno del entorno, levanta, avisa y espera a que lo paren o a que
 * el run deje de tener la PR abierta; entonces baja y suelta el turno.
 */
export async function correrServicio(
  home: string,
  id: string,
  env: NodeJS.ProcessEnv,
  pausaMs = PAUSA_MS,
): Promise<Servicio["estado"]> {
  const run = runPaths(home, id);
  const state = estadoDe(home, id);
  const inicio = new Date().toISOString();
  let urls: Record<string, string> = {};
  const escribir = (estado: Servicio["estado"], mensaje: string) => {
    escribirServicio(run, { estado, pid: process.pid, inicio, urls, mensaje });
    if (estado !== "parando" && estado !== "levantando")
      notifyMac("flowrunner", `${state.clave}: ${mensaje}`, env);
    return estado;
  };
  // Un objeto y no un `let`: la señal lo cambia desde afuera del flujo que ve TypeScript.
  const señal = { parar: false };
  const alParar = () => (señal.parar = true);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, alParar);
  try {
    const { worktree, probar } = probarDe(home, id);
    urls = probar.urls;
    escribir("levantando", "levantando el servicio");
    const file = turnoFile(home, state.proyecto, "entorno");
    const turno = intentarTurno(file, id);
    if (turno.tipo === "ocupado")
      return escribir("falla", `el entorno de ${state.proyecto} lo tiene ${turno.dueño.run_id}`);
    try {
      const up = await levantarEntorno({
        worktree,
        repo: state.repo,
        probar,
        log: servicioLog(run),
        env,
      });
      if (up.tipo === "falla") return escribir("falla", `el servicio no levantó: ${up.motivo}`);
      if (!señal.parar) escribir("arriba", `el servicio responde en ${listaDeUrls(urls)}`);
      let por = "lo paraste";
      while (!señal.parar) {
        await sleep(pausaMs);
        const ahora = estadoDe(home, id);
        if (!conPrAbierta(ahora)) {
          por =
            ahora.status === "en_curso"
              ? "el run volvió a trabajar"
              : ahora.status === "entregado"
                ? "se mergeó la PR"
                : `el run quedó ${ahora.status}`;
          break;
        }
      }
      escribir("parando", `bajando el servicio: ${por}`);
      const vivas = await up.entorno.bajar();
      return escribir(
        "parado",
        vivas.length === 0
          ? `el servicio se bajó: ${por}`
          : `el servicio se bajó (${por}), pero siguen respondiendo ${vivas.join(", ")}`,
      );
    } finally {
      soltarTurno(file, turno.dueño);
    }
  } catch (error) {
    return escribir("falla", error instanceof Error ? error.message : String(error));
  } finally {
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(s, alParar);
  }
}
