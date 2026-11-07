// Punto de entrada del CLI. Cada comando acepta --json; la salida JSON es lo que lee la skill.
import { parseArgs } from "node:util";
import { flowrunnerHome } from "../config/load.ts";
import type { z } from "zod";
import type { statusListSchema, statusRunSchema } from "./contracts.ts";
import { checkFeature, describeCheckedFeature } from "./feature-check.ts";
import { processIo, reportError, UserError, type Io } from "./output.ts";
import { addProject, initRepoBrain } from "./project.ts";
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

  feature check <archivo>        valida una feature, su proyecto y la config del repo
  run <archivo>                  lanza un run en segundo plano y devuelve su id
  status [run]                   lista los runs, o un run fase por fase
  resume <run>                   retoma un run detenido o interrumpido
  rerun <run> --desde <fase>     rehace un run desde una fase
  abort <run>                    cancela un run y borra sus worktrees; las ramas quedan
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
