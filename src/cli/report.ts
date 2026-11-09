// `flowrunner report <run>`, `--sesion <nombre>` y `--unidad <ST-n>`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, GitError } from "../git/git.ts";
import { readPlan } from "../phases/planificar.ts";
import { MAX_DIFF_CHARS } from "../phases/revisar.ts";
import { phaseSummaries, plain, writeReport } from "../report/report.ts";
import { describeSteps, transcriptSteps } from "../report/transcript.ts";
import type { RunEvent } from "../store/events.ts";
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

type UnitEvent = Extract<RunEvent, { tipo: "unidad" }>;

/** Un cerco de backticks más largo que cualquiera del contenido: un diff con ``` no corta el bloque. */
function fenced(lang: string, text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Lo último que escribió el modelo en la sesión más reciente de la sub-task. */
function lastSaid(dir: string, unidad: string): string | undefined {
  const sessions = join(dir, "sesiones");
  if (!existsSync(sessions)) return undefined;
  const own = new RegExp(`^implementar-${unidad}-(\\d+)\\.jsonl$`);
  const latest = readdirSync(sessions)
    .map((f) => ({ f, n: Number(own.exec(f)?.[1] ?? Number.NaN) }))
    .filter((x) => !Number.isNaN(x.n))
    .sort((a, b) => b.n - a.n)[0];
  if (latest === undefined) return undefined;
  const steps = transcriptSteps(readFileSync(join(sessions, latest.f), "utf8"));
  return steps.findLast((s) => s.tipo === "texto")?.texto;
}

/** Cómo le fue a una sub-task desde el último plan: su estado, sus intentos y sus commits integrados. */
export function unitHistory(events: readonly RunEvent[], unidad: string) {
  // Planificar rehace la rama desde la base: lo integrado antes del último plan ya no está en ella.
  const since = events.findLastIndex(
    (e) => e.tipo === "accion_iniciada" && e.fase === "planificar",
  );
  const own = events
    .slice(since + 1)
    .filter((e): e is UnitEvent => e.tipo === "unidad" && e.unidad === unidad);
  return {
    estado: own.at(-1)?.estado ?? ("pendiente" as const),
    intentos: own.filter((e) => e.estado === "iniciada").length,
    shas: own.flatMap((e) => (e.estado === "integrada" && e.sha !== undefined ? [e.sha] : [])),
  };
}

export const ESTADO: Record<UnitEvent["estado"] | "pendiente", string> = {
  pendiente: "pendiente",
  iniciada: "en curso",
  commiteada: "commiteada, sin integrar",
  integrada: "integrada",
  fallida: "fallida",
  sin_cambios: "devuelta, sin nada que cambiar",
};

/** Una sub-task: qué tenía que hacer según el plan, qué dice que hizo y el diff de sus commits. */
export async function showUnit(home: string, id: string, unidad: string, env: NodeJS.ProcessEnv) {
  if (!/^ST-\d+$/.test(unidad))
    throw new UserError(`sub-task inválida: ${unidad}`, "usá su id, como ST-1");
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "events.jsonl")))
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  if (!existsSync(join(run.dir, "tasks.json")))
    throw new UserError(`el run ${id} todavía no tiene plan`, `flowrunner status ${id}`);
  const plan = readPlan(run);
  const task = plan.subtareas.find((t) => t.id === unidad);
  if (task === undefined)
    throw new UserError(`el plan de ${id} no tiene ${unidad}`, `flowrunner plan ${id}`);
  const state = loadState(home, id);
  const { estado, intentos, shas } = unitHistory(readLog(run.dir).events, unidad);
  // Los worktrees del run comparten los objetos del repo: el commit se lee de ahí aunque ya no estén.
  const commits = await Promise.all(
    shas.map(async (sha) => {
      try {
        return {
          sha,
          stat: await git(state.repo, ["show", "--format=", "--stat", sha], env),
          diff: await git(state.repo, ["show", "--format=", "--patch", sha], env),
        };
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        return { sha, error: `el commit ${sha.slice(0, 7)} ya no está en ${state.repo}` };
      }
    }),
  );
  const dicho = lastSaid(run.dir, unidad);
  const criterios = plan.criterios.filter((c) => c.subtarea === unidad);

  const fullDiff = commits.map((c) => ("diff" in c ? c.diff : "")).join("\n");
  const diff =
    fullDiff.length > MAX_DIFF_CHARS
      ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n… (el diff sigue: ${String(fullDiff.length - MAX_DIFF_CHARS)} caracteres más)`
      : fullDiff;
  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  const header = [
    ESTADO[estado],
    ...(intentos > 0 ? [plural(intentos, "intento", "intentos")] : []),
    ...(shas.length > 0 ? [`commit ${shas.map((s) => s.slice(0, 7)).join(", ")}`] : []),
  ].join(" · ");
  const lines = [
    `# ${state.clave} · ${task.id} ${task.titulo}`,
    "",
    header,
    "",
    "## Qué tenía que hacer",
    "",
    plain(task.descripcion),
    "",
    `- **Alcance:** ${task.alcance.map((a) => `\`${a}\``).join(", ")}`,
    ...(criterios.length > 0
      ? [`- **Criterios:** ${criterios.map((c) => `${c.id} \`${c.comando}\``).join(", ")}`]
      : []),
    ...(task.depende_de.length > 0 ? [`- **Depende de:** ${task.depende_de.join(", ")}`] : []),
    "",
    "## Qué dice que hizo",
    "",
    dicho ?? "Todavía no hay una sesión de esta sub-task.",
    "",
    "## Cambios",
    "",
    ...(commits.length === 0 ? ["Todavía no hay cambios integrados."] : []),
    ...commits.flatMap((c) => ("error" in c ? [c.error, ""] : [])),
    ...(diff.trim() === ""
      ? []
      : [
          fenced("", commits.flatMap((c) => ("stat" in c ? [c.stat] : [])).join("\n")),
          "",
          fenced("diff", diff),
        ]),
  ];
  return {
    ok: true as const,
    run: id,
    unidad: task.id,
    titulo: task.titulo,
    estado,
    intentos,
    commits: shas,
    texto: `${lines.join("\n").trimEnd()}\n`,
  };
}
