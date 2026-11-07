// `flowrunner report <run>` y `--sesion <nombre>`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { phaseSummaries, writeReport } from "../report/report.ts";
import { describeSteps, transcriptSteps } from "../report/transcript.ts";
import { readLog } from "../store/run-log.ts";
import { loadState, runPaths } from "../store/runs.ts";
import { summarize } from "./contracts.ts";
import { UserError } from "./output.ts";

export function showReport(home: string, id: string) {
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "events.jsonl")))
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  const { events } = readLog(run.dir);
  const informe = writeReport(run, events);
  const sesiones = existsSync(join(run.dir, "sesiones"))
    ? readdirSync(join(run.dir, "sesiones"))
        .map((f) => f.replace(/\.jsonl$/, ""))
        .sort()
    : [];
  return {
    ok: true as const,
    run: summarize(loadState(home, id)),
    informe,
    fases: phaseSummaries(events),
    sesiones,
  };
}

export function showSession(home: string, id: string, session: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(session))
    throw new UserError(`nombre de sesión inválido: ${session}`);
  const file = join(runPaths(home, id).dir, "sesiones", `${session}.jsonl`);
  if (!existsSync(file))
    throw new UserError(`el run ${id} no tiene la sesión ${session}`, `flowrunner report ${id}`);
  const pasos = transcriptSteps(readFileSync(file, "utf8"));
  return { ok: true as const, sesion: session, pasos, texto: describeSteps(pasos) };
}
