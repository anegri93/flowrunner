// Punto de entrada del CLI. Cada comando acepta --json; la salida JSON es lo que lee la skill.
import { parseArgs } from "node:util";
import { flowrunnerHome } from "../config/load.ts";
import type { z } from "zod";
import type { statusListSchema, statusRunSchema } from "./contracts.ts";
import { checkFeature, describeCheckedFeature } from "./feature-check.ts";
import { processIo, progressLog, reportError, UserError, type Io } from "./output.ts";
import { addProject, initRepoBrain } from "./project.ts";
import { approveRun, describePlan, requestChanges, showPlan } from "./approval.ts";
import { showReport, showSession, showUnit } from "./report.ts";
import { showPhase } from "./etapa.ts";
import { feedbackRun, learnAndNotify, learnInBackground, learnOne, tick } from "./tick.ts";
import { explainAndNotify, explainInBackground, explainRun } from "./explain.ts";
import { correrServicio, levantarServicio, pararServicio } from "./servicio.ts";
import { describeDoctor, doctor } from "./doctor.ts";
import { installLaunchd, plistPath, uninstallLaunchd } from "./launchd.ts";
import { installSkill } from "./skill.ts";
import { installOrcaPlugin } from "./orca.ts";
import { hookOutput, sessionStartContext } from "./hook.ts";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { closedRuns, loadTree, resolveRun } from "../watch/load.ts";

import { renderRuns, watchLive, watchTargets } from "./watch.ts";
import { selfUpdate, sinProcesosVivos } from "../setup/app.ts";
import { aprobarPlugin, correrTarea, lanzarTarea, listarTareas, type Fin } from "./tareas.ts";
import { commandDir, describeInit, draftExistingBrain, init } from "../setup/init.ts";
import {
  applyAudit,
  auditBrain,
  describeAplicar,
  describeAuditar,
  proyectoDe,
  ultimaAuditoria,
  informe as informeAuditoria,
} from "../setup/auditar.ts";
import { productionRuntime } from "../runner/production.ts";
import { describeStats, describeStatsPorRun, stats, statsPorRun } from "../report/stats.ts";
import { origenSchema, type Origen } from "../store/events.ts";
import {
  abortRun,
  acceptRun,
  acceptUntested,
  responderRun,
  BIN,
  autofixRun,
  fixRun,
  rerunRun,
  resumeRun,
  skipProbar,
  runProcess,
  startRun,
  statusAll,
  statusOne,
  pauseRun,
  prioritizeRun,
} from "./runs.ts";

/** Cuántos runs cerrados devuelve `watch --json --cerrados`. */
const MAX_CLOSED = 20;

const USAGE = `uso: flowrunner <comando> [--json]

  init <ruta> [--aplicar]        revisa e infiere el setup de un repo; con --aplicar lo deja listo
  feature check <archivo>        valida una feature, su proyecto y la config del repo
  run <archivo>                  lanza un run en segundo plano y devuelve su id
  status [run]                   lista los runs, o un run fase por fase
  watch [run] [--once|--json]    el árbol de un run, o de los activos, en vivo; run puede ser la clave
                                 --json --cerrados suma los últimos cerrados y abortados
  resume <run>                   retoma un run detenido, pausado o interrumpido; después de fix --yo,
                                 commitea tu arreglo y vuelve a verificar
  fix <run> --unidad ST-n "<qué>"
                                 que esa sub-task lo corrija sobre el código que ya está
  fix <run> --yo                 lo arreglás vos en el worktree; después resume
  fix <run> --auto               formateador y lint del repo y vuelve a verificar; si sigue en
                                 rojo, las sub-tasks lo corrigen solas, una vez
  accept <run> "<por qué>"       seguir a la fase siguiente igual
  responder <run> "<respuesta>"  contesta lo que preguntó el planificador; se suma a la feature
                                 del run y el plan sigue
                                 fix, accept y responder, solo si el run detenido lo ofrece, con
                                 [--origen terminal|claude|orca]; por defecto terminal
  rerun <run> --desde <fase>     rehace un run desde una fase
  accept-untested <run> "<por qué>"
                                 entrega aunque probar dejó criterios sin probar; el motivo
                                 queda en el informe y en la PR
  skip-probar <run> "<por qué>"  cuando el run llegue a probar, la saltea; el motivo queda en el
                                 informe y en la PR. Solo antes de que probar arranque
  skip-probar <run> --deshacer   vuelve a probar normal
                                 skip-probar con [--origen terminal|claude|orca]
  pause <run> [--para <run>]     pausa un run: termina lo que está haciendo y suelta su lugar;
                                 con --para, ese run de la cola entra antes; sigue con resume
  prioritize <run>               un run en cola sale primero
                                 pause y prioritize con [--origen terminal|claude|orca]
  explain <run> [--fondo]        explica por qué el run se detuvo y qué hace cada respuesta; con
                                 --fondo, en un proceso aparte que avisa al terminar
  abort <run>                    cancela un run y borra sus worktrees; las ramas quedan
  plan <run>                     muestra el plan que espera aprobación
  approve <run> [--acepto-cambios] [--sin-probar "<por qué>"] [--origen terminal|claude|orca]
                                 aprueba el plan y sigue a implementar; si el plan cambia
                                 lo que ya existe, pide --acepto-cambios; con --sin-probar,
                                 probar se saltea con ese motivo
  changes <run> "<motivo>" [--origen terminal|claude|orca]
                                 vuelve a planificar con tu instrucción
  report <run> [--sesion s]      el informe del run, o el transcript de una sesión
  report <run> --unidad ST-n     una sub-task: qué tenía que hacer, qué dice que hizo y su diff
  report <run> --fase <fase>     una etapa: intentos, lo propio de la etapa, decisiones y sesiones
  tick                           lo que corre launchd: retoma pausados y aprende de PRs mergeadas
  learn <run> [--fondo]          revisa la PR de un run y aprende en el momento; con --fondo,
                                 en un proceso aparte que avisa al terminar
  feedback <run> "<qué no te gustó>" [--origen terminal|claude|orca]
                                 con la PR abierta: evalúa tu feedback y rehace el run desde
                                 implementar o planificar, sobre la misma PR
  servicio <run> levantar|parar  con la PR abierta, levanta el entorno de la feature con el
                                 probar.levantar del repo para probarla a mano, o lo baja
  doctor                         qué le falta a esta máquina para correr runs, y su versión
  self-update [--fondo]          mueve el flowrunner que corre runs a origin/main; con --fondo,
                                 en un proceso aparte que deja su estado en tareas
  tareas                         en qué quedaron las tareas de fondo: self-update, orca install
                                 y la auditoría del cerebro
  launchd install|uninstall      instala o quita el job que corre tick
  skill install [--confirmar]    instala la skill de Claude Code; con --confirmar, las reglas ask y el hook
  orca install [--approve fp]    carga en Orca el plugin de este flowrunner, esté donde esté clonado
  orca install --fondo           lo mismo en un proceso aparte; si Orca pide aprobarlo, la tarea
                                 dice el --approve que corrés vos
  hook session-start             el hook de Claude Code: avisa a la sesión si el repo usa flowrunner
  stats [--runs] [proyecto]      qué fase reintenta más, motivos, costo y lecciones; con --runs,
                                 tiempo activo, costo, planes y rechazos de cada run
  project add <ruta>             registra un repo [--nombre n] [--github-user u]
  brain init <ruta>              escribe las plantillas de .flowrunner/ sin pisar nada; una
                                 plantilla vieja que nadie editó pasa a la de hoy
  brain audit <ruta> [--fondo]   una sesión de solo lectura revisa el cerebro contra el código y la
                                 historia de los runs, y propone decisiones; con --fondo, aparte
  brain audit <ruta> --ultima    la última auditoría del proyecto, con su informe
  brain apply <proyecto>/<id> --decision Dn [--decision Dm]
                                 abre una PR con las decisiones elegidas de esa auditoría
  brain draft <ruta> [--reemplazar]
                                 propone en una PR un borrador del cerebro leído del repo;
                                 con --reemplazar, cambia el borrador anterior por uno nuevo`;

function describeList(list: z.infer<typeof statusListSchema>): string {
  if (list.runs.length === 0) return "no hay runs";
  return list.runs
    .map((r) => `${r.id}  ${r.status}  ${r.fase}  USD ${r.costo_usd.toFixed(2)}`)
    .join("\n");
}

function describeRun(status: z.infer<typeof statusRunSchema>): string {
  const { run, pasos } = status;
  const lines = [`${run.id} · ${run.status} · fase ${run.fase} · USD ${run.costo_usd.toFixed(2)}`];
  for (const paso of pasos) {
    const fin = paso.fin === null ? "en curso" : (paso.resultado ?? "");
    lines.push(`  ${paso.fase}  ${fin}${paso.motivo === null ? "" : `: ${paso.motivo}`}`);
  }
  if (run.detenido !== null) {
    lines.push(
      `Detenido: ${run.detenido.motivo}`,
      ...(run.detenido.unidades === undefined
        ? []
        : [`Parece ser de: ${run.detenido.unidades.join(", ")}`]),
      "Opciones:",
      ...run.detenido.opciones.map((o) => `  ${o.comando}  ·  ${o.que}`),
    );
  }
  return lines.join("\n");
}

/**
 * `_reapuntar`, oculto: lo corre `self-update` con el código de la app, así el comando, launchd, Orca
 * y la skill salen de la app y no del checkout que lanzó la actualización.
 */
async function reapuntar(env: NodeJS.ProcessEnv): Promise<{ ok: true; reapuntado: string[] }> {
  const reapuntado: string[] = [];
  const dir = commandDir(env);
  if (dir === undefined) {
    reapuntado.push("comando: agregá ~/.local/bin a tu PATH");
  } else {
    const link = join(dir, "flowrunner");
    rmSync(link, { force: true });
    symlinkSync(BIN, link);
    reapuntado.push(`comando ${link}`);
  }
  if (existsSync(plistPath(env))) reapuntado.push(`launchd ${(await installLaunchd(env)).plist}`);
  if (env.ORCA !== undefined || existsSync("/Applications/Orca.app")) {
    const orca = await installOrcaPlugin(env, undefined);
    reapuntado.push(orca.ok ? `Orca ${orca.plugin}` : `Orca ${orca.plugin}: ${orca.salida}`);
  }
  reapuntado.push(`skill ${installSkill(env, true).skill}`);
  return { ok: true, reapuntado };
}

/** El trabajo de cada tarea de `_tarea`: lo que el panel lanza y sigue (ADR 0039). */
async function tarea(
  nombre: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Fin> {
  if (nombre.startsWith("auditar-")) {
    const { deps } = await productionRuntime(env, () => undefined);
    const done = await auditBrain(need(args[0], "la ruta del repo"), deps, () => undefined);
    return { ok: true, mensaje: describeAuditar(done) };
  }
  if (nombre === "self-update") {
    const updated = await selfUpdate(env);
    const orca = updated.reapuntado.find((r) => r.startsWith("Orca "));
    const siguiente = orca === undefined ? undefined : aprobarPlugin(orca);
    return {
      ok: true,
      mensaje: `flowrunner en ${updated.sha.slice(0, 7)}: ${updated.reapuntado.join(", ")}`,
      ...(siguiente === undefined ? {} : { siguiente }),
    };
  }
  if (nombre === "orca-install") {
    const done = await installOrcaPlugin(env, undefined);
    const siguiente = done.ok ? undefined : aprobarPlugin(done.salida);
    return {
      ok: done.ok,
      mensaje: done.ok
        ? done.salida || "plugin cargado"
        : siguiente === undefined
          ? done.salida
          : "Orca pide aprobar el plugin: corré el comando de abajo en la terminal",
      ...(siguiente === undefined ? {} : { siguiente }),
    };
  }
  throw new UserError(`tarea desconocida: ${nombre}`);
}

/** De dónde viene la decisión: la skill pasa `claude`, el panel de Orca `orca` (ADR 0023). */
function parseOrigen(value: unknown): Origen {
  if (value === undefined) return "terminal";
  const parsed = origenSchema.safeParse(value);
  if (!parsed.success) throw new UserError("--origen tiene que ser terminal, claude u orca");
  return parsed.data;
}

/**
 * El motivo de `--sin-probar`: con `strict: false`, el flag sin valor llega como `true`. Ausente es
 * undefined; presente, un texto, que `approveRun` exige no vacío.
 */
function sinProbarArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : "";
}

/** Un valor de `parseArgs` con `multiple`: siempre una lista de textos. */
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new UserError(`falta ${what}`, USAGE);
  return value;
}

/** El run que nombra la persona: el id completo o la clave, como `VF-4`, que elige el más reciente. */
function runArg(home: string, value: string | undefined): string {
  const arg = need(value, "el id del run");
  return resolveRun(home, arg) ?? arg;
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = processIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean", default: false },
      desde: { type: "string" },
      para: { type: "string" },
      nombre: { type: "string" },
      sesion: { type: "string" },
      unidad: { type: "string", multiple: true },
      yo: { type: "boolean", default: false },
      auto: { type: "boolean", default: false },
      origen: { type: "string" },
      fase: { type: "string" },
      confirmar: { type: "boolean", default: false },
      aplicar: { type: "boolean", default: false },
      reemplazar: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      cerrados: { type: "boolean", default: false },
      fondo: { type: "boolean", default: false },
      runs: { type: "boolean", default: false },
      ultima: { type: "boolean", default: false },
      decision: { type: "string", multiple: true },
      "github-user": { type: "string" },
      approve: { type: "string" },
      "acepto-cambios": { type: "boolean", default: false },
      "sin-probar": { type: "string" },
      deshacer: { type: "boolean", default: false },
    },
  });
  const json = values.json === true;
  const print = (data: object, text: string) => {
    io.out(json ? JSON.stringify(data) : text);
  };
  const home = flowrunnerHome(env);
  try {
    const [command, first, ...rest] = positionals;
    switch (command) {
      case "watch": {
        const targets = watchTargets(home, first);
        if (json) {
          // Lo que lee una vista de afuera, como el panel de Orca: el mismo árbol que dibuja watch.
          // Con --cerrados, también los últimos cerrados y abortados, que el panel muestra colapsados.
          const now = Date.now();
          const ids = [
            ...targets(),
            ...(values.cerrados === true && first === undefined
              ? closedRuns(home, MAX_CLOSED)
              : []),
          ];
          print({ ok: true, runs: ids.map((id) => loadTree(home, id, now)) }, "");
          return 0;
        }
        const tty = process.stdout.isTTY && process.stdin.isTTY;
        // El run que pediste por nombre se ve entero, aunque ya esté entregado.
        const abiertos = new Map<string, boolean>(
          first === undefined ? [] : targets().map((id) => [id, true]),
        );
        if (values.once === true || !tty) {
          const { lines } = renderRuns(home, targets(), {
            width: process.stdout.columns > 0 ? process.stdout.columns : 120,
            color: process.stdout.isTTY,
            abiertos,
            now: Date.now(),
          });
          io.out(lines.join("\n"));
          return 0;
        }
        await watchLive(home, targets, abiertos);
        return 0;
      }
      case "hook": {
        if (first !== "session-start") break;
        // Un hook que falla no puede trabar el arranque de una sesión: cualquier error es no decir nada.
        try {
          const context = await sessionStartContext(readFileSync(0, "utf8"), env);
          if (context !== undefined) io.out(hookOutput(context));
        } catch {
          // sin contexto
        }
        return 0;
      }
      case "init": {
        const aplicar = values.aplicar === true;
        const { deps } = await productionRuntime(env, () => undefined);
        const result = await init(
          need(first, "la ruta del repo"),
          deps,
          aplicar,
          progressLog(io, json),
        );
        print(result, describeInit(result, aplicar));
        return result.ok ? 0 : 1;
      }
      case "feature": {
        if (first !== "check") break;
        const checked = checkFeature(need(rest[0], "el archivo de la feature"), env);
        print({ ok: true, ...checked }, describeCheckedFeature(checked));
        return 0;
      }
      case "run": {
        const started = startRun(home, need(first, "el archivo de la feature"), env, new Date());
        print(started, `run ${started.id} ${started.accion}`);
        return 0;
      }
      case "status": {
        if (first === undefined) {
          const list = statusAll(home);
          print(list, describeList(list));
        } else {
          const one = statusOne(home, runArg(home, first));
          print(one, describeRun(one));
        }
        return 0;
      }
      case "resume": {
        const resumed = await resumeRun(home, runArg(home, first), env);
        print(resumed, `run ${resumed.id} ${resumed.accion}`);
        return 0;
      }
      case "fix": {
        if (values.auto === true) {
          if (values.yo === true || strings(values.unidad).length > 0 || rest.length > 0) {
            throw new UserError(
              "--auto va solo: sin --yo, sin --unidad y sin instrucción",
              `flowrunner status ${first ?? "<run>"}`,
            );
          }
          const auto = await autofixRun(home, runArg(home, first), parseOrigen(values.origen), env);
          print(auto, `run ${auto.id} ${auto.accion}`);
          return 0;
        }
        const fixed = fixRun(
          home,
          runArg(home, first),
          {
            unidades: strings(values.unidad),
            instruccion: rest.join(" "),
            yo: values.yo === true,
            origen: parseOrigen(values.origen),
          },
          env,
        );
        print(fixed, `run ${fixed.id} ${fixed.accion}`);
        return 0;
      }
      case "accept": {
        const accepted = acceptRun(
          home,
          runArg(home, first),
          rest.join(" "),
          parseOrigen(values.origen),
          env,
        );
        print(accepted, `run ${accepted.id} ${accepted.accion}`);
        return 0;
      }
      case "responder": {
        const answered = responderRun(
          home,
          runArg(home, first),
          rest.join(" "),
          parseOrigen(values.origen),
          env,
        );
        print(answered, `run ${answered.id} ${answered.accion}`);
        return 0;
      }
      case "accept-untested": {
        const accepted = acceptUntested(home, runArg(home, first), rest.join(" "), env);
        print(accepted, `run ${accepted.id} ${accepted.accion}`);
        return 0;
      }
      case "skip-probar": {
        const skipped = skipProbar(home, runArg(home, first), {
          motivo: rest.join(" "),
          deshacer: values.deshacer === true,
          origen: parseOrigen(values.origen),
        });
        print(skipped, `run ${skipped.id}: ${skipped.accion}`);
        return 0;
      }
      case "rerun": {
        const desde = typeof values.desde === "string" ? values.desde : undefined;
        const rerun = rerunRun(home, runArg(home, first), desde, env);
        print(rerun, `run ${rerun.id} ${rerun.accion}`);
        return 0;
      }
      case "pause": {
        const para = typeof values.para === "string" ? runArg(home, values.para) : undefined;
        const paused = pauseRun(home, runArg(home, first), para, parseOrigen(values.origen));
        print(paused, `run ${paused.id} ${paused.accion}`);
        return 0;
      }
      case "prioritize": {
        const prioritized = prioritizeRun(home, runArg(home, first), parseOrigen(values.origen));
        print(prioritized, `run ${prioritized.id} ${prioritized.accion}`);
        return 0;
      }
      case "explain": {
        const id = runArg(home, first);
        const explained =
          values.fondo === true
            ? explainInBackground(home, id, env)
            : await explainRun(home, id, env);
        print(
          explained,
          explained.estado === "lista"
            ? explained.texto
            : `${explained.id}: ${explained.resultado}`,
        );
        return 0;
      }
      case "abort": {
        const aborted = abortRun(home, runArg(home, first), env);
        print(aborted, `run ${aborted.id} ${aborted.accion}`);
        return 0;
      }
      case "plan": {
        const view = await showPlan(home, runArg(home, first), env);
        print(view, describePlan(view));
        return 0;
      }
      case "approve": {
        const approved = approveRun(
          home,
          runArg(home, first),
          env,
          values["acepto-cambios"] === true,
          parseOrigen(values.origen),
          sinProbarArg(values["sin-probar"]),
        );
        print(approved, `run ${approved.id} ${approved.accion}`);
        return 0;
      }
      case "changes": {
        const changed = requestChanges(
          home,
          runArg(home, first),
          rest.join(" "),
          env,
          parseOrigen(values.origen),
        );
        print(changed, `run ${changed.id} ${changed.accion}`);
        return 0;
      }
      case "report": {
        const id = runArg(home, first);
        const unidad = strings(values.unidad)[0];
        if (typeof values.sesion === "string") {
          const session = showSession(home, id, values.sesion);
          print(session, session.texto);
        } else if (typeof values.fase === "string") {
          const phase = showPhase(home, id, values.fase);
          print(phase, phase.texto);
        } else if (unidad !== undefined) {
          const unit = await showUnit(home, id, unidad, env);
          print(unit, unit.texto);
        } else {
          const report = showReport(home, id);
          print(
            report,
            `${report.informe}\nSesiones: ${report.sesiones.join(", ") || "(ninguna)"}`,
          );
        }
        return 0;
      }
      case "tick": {
        const done = await tick(home, env, new Date());
        print(done, done.acciones.join("\n") || "nada que hacer");
        return 0;
      }
      case "feedback": {
        const sent = feedbackRun(
          home,
          runArg(home, first),
          rest.join(" "),
          parseOrigen(values.origen),
          env,
        );
        print(sent, `run ${sent.id} ${sent.accion}`);
        return 0;
      }
      case "learn": {
        const id = runArg(home, first);
        const learned =
          values.fondo === true ? learnInBackground(home, id, env) : await learnOne(home, id, env);
        print(learned, `${learned.id}: ${learned.resultado}`);
        return 0;
      }
      case "doctor": {
        const result = await doctor(env);
        print(result, describeDoctor(result));
        return result.ok ? 0 : 1;
      }
      case "self-update": {
        if (values.fondo === true) {
          // Lo que se puede rechazar enseguida, se rechaza acá: el panel lo muestra sin esperar.
          sinProcesosVivos(home);
          const started = lanzarTarea(
            home,
            "self-update",
            [],
            "actualizando flowrunner a origin/main",
            env,
            new Date(),
          );
          print(started, started.resultado);
          return 0;
        }
        const updated = await selfUpdate(env);
        print(
          updated,
          `flowrunner en ${updated.app} (${updated.sha.slice(0, 7)}): ${updated.reapuntado.join(", ")}`,
        );
        return 0;
      }
      case "_reapuntar": {
        const done = await reapuntar(env);
        print(done, done.reapuntado.join("\n"));
        return 0;
      }
      case "launchd": {
        if (first === "install") {
          const done = await installLaunchd(env);
          print(done, `instalado ${done.plist}: tick cada ${String(done.cada_minutos)} minutos`);
          return 0;
        }
        if (first === "uninstall") {
          const done = await uninstallLaunchd(env);
          print(done, `quitado ${done.plist}`);
          return 0;
        }
        break;
      }
      case "skill": {
        if (first !== "install") break;
        const done = installSkill(env, values.confirmar === true);
        const rules =
          done.pendientes.length > 0
            ? `\nPara que Claude Code te pregunte antes de aprobar y sepa qué repos usan flowrunner, corré de nuevo con --confirmar; agrega a ~/.claude/settings.json:\n  ${done.pendientes.join("\n  ")}`
            : done.agregadas.length > 0
              ? `\nAgregado a ~/.claude/settings.json: ${done.agregadas.join(", ")}`
              : "\nLas reglas ask y el hook ya estaban.";
        print(done, `skill instalada en ${done.skill}${rules}`);
        return 0;
      }
      case "orca": {
        if (first !== "install") break;
        if (values.fondo === true) {
          if (typeof values.approve === "string")
            throw new UserError(
              "--approve no va con --fondo: aprobar el plugin lo hacés vos en la terminal",
              `flowrunner orca install --approve ${values.approve}`,
            );
          const started = lanzarTarea(
            home,
            "orca-install",
            [],
            "cargando el plugin en Orca",
            env,
            new Date(),
          );
          print(started, started.resultado);
          return 0;
        }
        const done = await installOrcaPlugin(
          env,
          typeof values.approve === "string" ? values.approve : undefined,
        );
        print(done, done.salida);
        return done.ok ? 0 : 1;
      }
      case "stats": {
        if (values.runs === true) {
          const perRun = statsPorRun(home, first);
          print(perRun, describeStatsPorRun(perRun));
          return 0;
        }
        const result = stats(home, first);
        print(result, describeStats(result));
        return 0;
      }
      case "project": {
        if (first !== "add") break;
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const added = await addProject(
          need(rest[0], "la ruta del repo"),
          { name: str(values.nombre), githubUser: str(values["github-user"]) },
          env,
        );
        const pending =
          added.faltan.length === 0
            ? "listo para correr runs"
            : `falta:\n  ${added.faltan.join("\n  ")}`;
        print(added, `proyecto ${added.proyecto} registrado en ${added.repo}; ${pending}`);
        return 0;
      }
      case "brain": {
        if (first === "audit") {
          const ruta = need(rest[0], "la ruta del repo");
          if (values.ultima === true) {
            // Lo que lee el panel: la última auditoría del proyecto, con su informe ya escrito.
            const { nombre } = await proyectoDe(ruta, env);
            const ultima = ultimaAuditoria(home, nombre);
            // Sin el `.md`, por una escritura cortada, se vuelve a armar del registro.
            const informe =
              ultima === undefined
                ? null
                : existsSync(ultima.md)
                  ? readFileSync(ultima.md, "utf8")
                  : informeAuditoria(ultima.registro);
            print(
              { ok: true, proyecto: nombre, auditoria: ultima?.registro ?? null, informe },
              informe ?? `${nombre} todavía no tiene auditorías: flowrunner brain audit ${ruta}`,
            );
            return 0;
          }
          if (values.fondo === true) {
            const { nombre, repo } = await proyectoDe(ruta, env);
            const started = lanzarTarea(
              home,
              `auditar-${nombre}`,
              [repo],
              `auditando el cerebro de ${nombre}`,
              env,
              new Date(),
            );
            print({ ...started, proyecto: nombre }, started.resultado);
            return 0;
          }
          const { deps } = await productionRuntime(env, () => undefined);
          const done = await auditBrain(ruta, deps, progressLog(io, json));
          print(done, describeAuditar(done));
          return 0;
        }
        if (first === "apply") {
          const { deps } = await productionRuntime(env, () => undefined);
          const done = await applyAudit(
            need(rest[0], "la auditoría, como <proyecto>/<id>"),
            strings(values.decision),
            deps,
            progressLog(io, json),
          );
          // `resultado`: lo que muestra el panel de Orca, como en las demás tareas.
          print({ ...done, resultado: describeAplicar(done) }, describeAplicar(done));
          return 0;
        }
        if (first === "draft") {
          const { deps } = await productionRuntime(env, () => undefined);
          const drafted = await draftExistingBrain(
            need(rest[0], "la ruta del repo"),
            deps,
            progressLog(io, json),
            values.reemplazar === true,
          );
          print(drafted, `${drafted.paso.que}: ${drafted.paso.detalle}`);
          return drafted.ok ? 0 : 1;
        }
        if (first !== "init") break;
        const init = await initRepoBrain(need(rest[0], "la ruta del repo"), env);
        print(
          init,
          [
            `creados en ${init.repo}:\n  ${init.creados.join("\n  ") || "(nada: ya existía todo)"}`,
            ...(init.actualizados.length === 0
              ? []
              : [`con la plantilla de hoy:\n  ${init.actualizados.join("\n  ")}`]),
          ].join("\n"),
        );
        return 0;
      }
      case "servicio": {
        const id = runArg(home, first);
        const que = rest[0];
        if (que !== "levantar" && que !== "parar")
          throw new UserError(
            "falta qué hacer con el servicio",
            `flowrunner servicio ${id} levantar`,
          );
        const hecho =
          que === "levantar"
            ? levantarServicio(home, id, env, new Date())
            : pararServicio(home, id, new Date());
        print(hecho, `${hecho.id}: ${hecho.accion}`);
        return 0;
      }
      case "_servicio": {
        const id = runArg(home, first);
        io.out(`servicio ${id}: ${await correrServicio(home, id, env)}`);
        return 0;
      }
      case "_learn": {
        const id = runArg(home, first);
        io.out(`aprender ${id}: ${await learnAndNotify(home, id, env)}`);
        return 0;
      }
      case "_explain": {
        const done = await explainAndNotify(home, runArg(home, first), env);
        io.out(`explicar ${done.id}: ${done.estado}`);
        return 0;
      }
      case "tareas": {
        const tareas = listarTareas(home, new Date());
        print(
          { ok: true, tareas },
          tareas.map((t) => `${t.nombre}  ${t.estado}  ${t.mensaje}`).join("\n") ||
            "no corrió ninguna tarea",
        );
        return 0;
      }
      case "_tarea": {
        const nombre = need(first, "la tarea");
        const fin = await correrTarea(
          home,
          nombre,
          "trabajando",
          () => tarea(nombre, rest, env),
          env,
        );
        io.out(`${nombre}: ${fin.mensaje}`);
        return fin.ok ? 0 : 1;
      }
      case "_run": {
        const final = await runProcess(home, runArg(home, first), env);
        io.out(`run ${final.runId} quedó ${final.status}`);
        return 0;
      }
      default:
        break;
    }
    throw new UserError(
      command === undefined ? "falta el comando" : `comando desconocido: ${positionals.join(" ")}`,
      USAGE,
    );
  } catch (error) {
    return reportError(error, json, io);
  }
}
