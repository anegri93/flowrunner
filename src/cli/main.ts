// Punto de entrada del CLI. Cada comando acepta --json; la salida JSON es lo que lee la skill.
import { parseArgs } from "node:util";
import { flowrunnerHome } from "../config/load.ts";
import type { z } from "zod";
import type { statusListSchema, statusRunSchema } from "./contracts.ts";
import { checkFeature, describeCheckedFeature } from "./feature-check.ts";
import { processIo, reportError, UserError, type Io } from "./output.ts";
import { addProject, initRepoBrain } from "./project.ts";
import { approveRun, describePlan, requestChanges, showPlan } from "./approval.ts";
import { showReport, showSession } from "./report.ts";
import { learnOne, tick } from "./tick.ts";
import { describeDoctor, doctor } from "./doctor.ts";
import { installLaunchd, uninstallLaunchd } from "./launchd.ts";
import { installSkill } from "./skill.ts";
import { describeInit, init } from "../setup/init.ts";
import { describeStats, stats } from "../report/stats.ts";
import {
  abortRun,
  rerunRun,
  resumeRun,
  runProcess,
  startRun,
  statusAll,
  statusOne,
} from "./runs.ts";

const USAGE = `uso: flowrunner <comando> [--json]

  init <ruta> [--aplicar]        revisa e infiere el setup de un repo; con --aplicar lo deja listo
  feature check <archivo>        valida una feature, su proyecto y la config del repo
  run <archivo>                  lanza un run en segundo plano y devuelve su id
  status [run]                   lista los runs, o un run fase por fase
  resume <run>                   retoma un run detenido o interrumpido
  rerun <run> --desde <fase>     rehace un run desde una fase
  abort <run>                    cancela un run y borra sus worktrees; las ramas quedan
  plan <run>                     muestra el plan que espera aprobación
  approve <run>                  aprueba el plan y sigue a implementar
  changes <run> "<motivo>"       vuelve a planificar con tu instrucción
  report <run> [--sesion s]      el informe del run, o el transcript de una sesión
  tick                           lo que corre launchd: retoma pausados y aprende de PRs mergeadas
  learn <run>                    revisa la PR de un run y aprende en el momento
  doctor                         qué le falta a esta máquina para correr runs
  launchd install|uninstall      instala o quita el job que corre tick
  skill install [--confirmar]    instala la skill de Claude Code; con --confirmar, las reglas ask
  stats [proyecto]               qué fase reintenta más, motivos, costo y lecciones
  project add <ruta>             registra un repo [--nombre n] [--github-user u]
  brain init <ruta>              escribe las plantillas de .flowrunner/ sin pisar nada`;

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
    lines.push(`Detenido: ${run.detenido.motivo}`, `Para seguir: ${run.detenido.siguiente}`);
  }
  return lines.join("\n");
}

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new UserError(`falta ${what}`, USAGE);
  return value;
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
      nombre: { type: "string" },
      sesion: { type: "string" },
      confirmar: { type: "boolean", default: false },
      aplicar: { type: "boolean", default: false },
      "github-user": { type: "string" },
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
      case "init": {
        const aplicar = values.aplicar === true;
        const result = await init(need(first, "la ruta del repo"), env, aplicar);
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
          const one = statusOne(home, first);
          print(one, describeRun(one));
        }
        return 0;
      }
      case "resume": {
        const resumed = resumeRun(home, need(first, "el id del run"), env);
        print(resumed, `run ${resumed.id} ${resumed.accion}`);
        return 0;
      }
      case "rerun": {
        const desde = typeof values.desde === "string" ? values.desde : undefined;
        const rerun = rerunRun(home, need(first, "el id del run"), desde, env);
        print(rerun, `run ${rerun.id} ${rerun.accion}`);
        return 0;
      }
      case "abort": {
        const aborted = abortRun(home, need(first, "el id del run"));
        print(aborted, `run ${aborted.id} ${aborted.accion}`);
        return 0;
      }
      case "plan": {
        const view = await showPlan(home, need(first, "el id del run"), env);
        print(view, describePlan(view));
        return 0;
      }
      case "approve": {
        const approved = approveRun(home, need(first, "el id del run"), env);
        print(approved, `run ${approved.id} ${approved.accion}`);
        return 0;
      }
      case "changes": {
        const changed = requestChanges(home, need(first, "el id del run"), rest.join(" "), env);
        print(changed, `run ${changed.id} ${changed.accion}`);
        return 0;
      }
      case "report": {
        const id = need(first, "el id del run");
        if (typeof values.sesion === "string") {
          const session = showSession(home, id, values.sesion);
          print(session, session.texto);
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
      case "learn": {
        const learned = await learnOne(home, need(first, "el id del run"), env);
        print(learned, `${learned.id}: ${learned.resultado}`);
        return 0;
      }
      case "doctor": {
        const result = await doctor(env);
        print(result, describeDoctor(result));
        return result.ok ? 0 : 1;
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
            ? `\nPara que Claude Code te pregunte antes de aprobar, corré de nuevo con --confirmar; agrega a ~/.claude/settings.json:\n  ${done.pendientes.join("\n  ")}`
            : done.agregadas.length > 0
              ? `\nReglas ask agregadas: ${done.agregadas.join(", ")}`
              : "\nLas reglas ask ya estaban.";
        print(done, `skill instalada en ${done.skill}${rules}`);
        return 0;
      }
      case "stats": {
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
        if (first !== "init") break;
        const init = await initRepoBrain(need(rest[0], "la ruta del repo"), env);
        print(
          init,
          `creados en ${init.repo}:\n  ${init.creados.join("\n  ") || "(nada: ya existía todo)"}`,
        );
        return 0;
      }
      case "_run": {
        const final = await runProcess(home, need(first, "el id del run"), env);
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
