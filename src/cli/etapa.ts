// `flowrunner report <run> --fase <fase>`: el detalle de una etapa, lo que el panel de Orca abre al
// tocarla. Lo común a todas (intentos, decisiones, rechazos, avisos, sesiones) y lo propio de cada una,
// armado con lo que el run ya guardó. Lo que escribió un modelo pasa por `plain`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateOf } from "../engine/engine.ts";
import { quienCubre } from "../gates/plan.ts";
import { lastTestDir } from "../phases/probar.ts";
import { reviewSchema } from "../phases/revisar.ts";
import { planChanges, previousDir } from "../phases/plan-anterior.ts";
import { readPlan, readPlanAt } from "../phases/planificar.ts";
import { phaseSummaries, plain, testResults } from "../report/report.ts";
import type { RunPaths } from "../runner/types.ts";
import { PHASES, type Outcome, type Phase, type RunEvent } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import { runPaths } from "../store/runs.ts";
import { UserError } from "./output.ts";
import { ESTADO, unitHistory } from "./report.ts";

const NAMES: Record<Phase, string> = {
  preparar: "Preparar",
  planificar: "Planificar",
  aprobar: "Aprobar",
  implementar: "Implementar",
  verificar: "Verificar",
  revisar: "Revisar",
  probar: "Probar",
  entregar: "Entregar",
  aprender: "Aprender",
};

const CHANGES = [
  ["subtareas_agregadas", "Sub-tasks nuevas"],
  ["subtareas_quitadas", "Sub-tasks que ya no están"],
  ["alcance_agregado", "Alcance nuevo"],
  ["alcance_quitado", "Alcance que ya no está"],
  ["tests_agregados", "Tests nuevos"],
  ["tests_quitados", "Tests que ya no están"],
] as const;

/** La hora local de un evento, como `09/11 10:25`. */
function when(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
};

function outcomeText(o: Outcome): string {
  switch (o.tipo) {
    case "ok":
      return "ok";
    case "falla":
      return `falla de ${o.clase}: ${plain(o.motivo)}`;
    case "vuelve":
      return `devolvió ${o.unidades.join(", ")} a implementar: ${plain(o.motivo)}`;
    case "espera":
      return "quedó esperando";
    case "limite":
      return `pausado por el límite de la suscripción hasta ${new Date(o.hasta).toISOString()}`;
    case "pregunta":
      return `se detuvo a preguntar${o.unidades === undefined ? "" : ` por ${o.unidades.join(", ")}`}: ${plain(o.motivo)}`;
  }
}

interface Attempt {
  readonly inicio: string;
  readonly ms: number | undefined;
  readonly resultado: Outcome | undefined;
}

/** Cada vez que la etapa corrió: cuándo, cuánto tardó y cómo terminó. La última puede seguir abierta. */
function attemptsOf(events: readonly RunEvent[], fase: Phase): Attempt[] {
  const out: Attempt[] = [];
  let open: string | undefined;
  for (const e of events) {
    if (e.tipo === "accion_iniciada" && e.fase === fase) open = e.at;
    else if (e.tipo === "accion_terminada" && e.fase === fase && open !== undefined) {
      out.push({ inicio: open, ms: Date.parse(e.at) - Date.parse(open), resultado: e.resultado });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ inicio: open, ms: undefined, resultado: undefined });
  return out;
}

const section = (title: string, body: readonly string[]) =>
  body.length === 0 ? [] : ["", `## ${title}`, "", ...body];

function own(events: readonly RunEvent[], run: RunPaths, fase: Phase): string[] {
  const aborted = events.some((e) => e.tipo === "abortado");
  switch (fase) {
    case "preparar": {
      const prep = events.findLast((e) => e.tipo === "preparado");
      return prep?.tipo === "preparado"
        ? section("Dónde trabaja", [
            `- **Rama:** \`${prep.rama}\``,
            `- **Worktree:** \`${prep.worktree}\``,
            `- **Commit base:** \`${prep.base_sha.slice(0, 7)}\``,
          ])
        : [];
    }
    case "planificar": {
      if (!existsSync(join(run.dir, "tasks.json"))) return [];
      const plan = readPlan(run);
      const tasks = plan.subtareas.map(
        (t) =>
          `- **${t.id}** ${plain(t.titulo)}${t.depende_de.length > 0 ? ` (depende de ${t.depende_de.join(", ")})` : ""}`,
      );
      const criteria = plan.criterios.map(
        (c) => `- **${c.id}** → ${quienCubre(c.subtarea)}: \`${c.comando}\``,
      );
      const diff = existsSync(join(previousDir(run), "tasks.json"))
        ? planChanges(readPlanAt(previousDir(run)), plan)
        : undefined;
      const changed =
        diff === undefined
          ? []
          : CHANGES.flatMap(([key, label]) =>
              diff[key].length === 0 ? [] : [`- **${label}:** ${diff[key].join(", ")}`],
            );
      return [
        ...section("Sub-tasks", tasks),
        ...section("Criterios", criteria),
        ...section(
          "Tests bloqueados",
          Object.keys(plan.locked).map((t) => `- \`${t}\``),
        ),
        ...section("Qué cambió respecto del plan anterior", changed),
        ...section("Enfoque", [plain(plan.plan.trim())]),
      ];
    }
    case "aprobar": {
      const asked = events.flatMap((e) =>
        e.tipo === "cambios_pedidos" ? [`- ${when(e.at)}: ${plain(e.motivo)}`] : [],
      );
      // La etapa termina enseguida con «espera»: lo que tarda es la persona, hasta el evento aprobado.
      const waiting = events.find((e) => e.tipo === "accion_iniciada" && e.fase === "aprobar");
      const approved = events.findLast((e) => e.tipo === "aprobado");
      const waited =
        waiting !== undefined && approved !== undefined
          ? `, después de esperar ${clock(Date.parse(approved.at) - Date.parse(waiting.at))}`
          : "";
      return [
        ...section("Cambios que pediste", asked),
        ...section(
          "Aprobación",
          approved === undefined
            ? ["Todavía sin aprobar."]
            : [`Aprobado el ${when(approved.at)}${waited}.`],
        ),
      ];
    }
    case "implementar": {
      if (!existsSync(join(run.dir, "tasks.json"))) return [];
      return section(
        "Sub-tasks",
        readPlan(run).subtareas.map((t) => {
          const h = unitHistory(events, t.id);
          const extra = [
            ...(h.intentos > 0
              ? [`${String(h.intentos)} ${h.intentos === 1 ? "intento" : "intentos"}`]
              : []),
            ...(h.shas.length > 0 ? [`commit ${h.shas.map((s) => s.slice(0, 7)).join(", ")}`] : []),
          ];
          const said = h.estado === "iniciada" && aborted ? "cortada al abortar" : ESTADO[h.estado];
          return `- **${t.id}** ${plain(t.titulo)}: ${[said, ...extra].join(" · ")}`;
        }),
      );
    }
    case "verificar":
      return section("Criterios", [
        "flowrunner todavía no guarda el resultado de cada criterio: de verificar queda el motivo cuando algo falla, en los intentos y los avisos.",
      ]);
    case "revisar": {
      const file = join(run.dir, "review.json");
      if (!existsSync(file)) return [];
      const review = reviewSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!review.success) return section("Hallazgos", ["review.json no tiene la forma esperada."]);
      return section(
        "Hallazgos",
        review.data.hallazgos.length === 0
          ? ["Sin hallazgos."]
          : review.data.hallazgos.map(
              (h) =>
                `- **${h.severidad}** \`${h.archivo}:${String(h.linea)}\` (${h.subtarea}): ${plain(h.afirmacion)}${h.regla === "" ? "" : ` · ${plain(h.regla)}`}`,
            ),
      );
    }
    case "probar": {
      const dir = lastTestDir(run);
      return dir === undefined ? [] : section("Pruebas en el entorno", testResults(dir, true));
    }
    case "entregar": {
      const pr = events.findLast((e) => e.tipo === "pr");
      const proposed = join(run.dir, "lecciones-propuestas.md");
      return [
        ...section("PR", pr?.tipo === "pr" ? [`#${String(pr.numero)}: ${pr.url}`] : []),
        ...section(
          "Lecciones propuestas",
          existsSync(proposed) ? [plain(readFileSync(proposed, "utf8").trim())] : [],
        ),
      ];
    }
    case "aprender": {
      const closed = events.findLast((e) => e.tipo === "pr_cerrada");
      const learned = events.findLast((e) => e.tipo === "lecciones");
      return [
        ...section(
          "La PR",
          closed?.tipo === "pr_cerrada"
            ? [closed.mergeada ? "Mergeada." : "Cerrada sin mergear."]
            : [],
        ),
        ...section(
          "Lecciones",
          learned?.tipo === "lecciones"
            ? [
                `${String(learned.cantidad)} en #${String(learned.numero)} (${learned.url})${learned.auto_merge ? ", con auto-merge" : ""}.`,
              ]
            : [],
        ),
      ];
    }
  }
}

export function showPhase(home: string, id: string, fase: string) {
  const phase = PHASES.find((p) => p === fase);
  if (phase === undefined)
    throw new UserError(`fase inválida: ${fase}`, `una de: ${PHASES.join(", ")}`);
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "events.jsonl")))
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  const { events } = readLog(run.dir);
  const state = stateOf(events);
  const attempts = attemptsOf(events, phase);
  const last = attempts.at(-1);
  // Abortar corta la etapa sin cerrarla: su último intento queda abierto para siempre.
  const running = state.status === "abortado" ? "cortado al abortar" : "en curso";
  const approved = phase === "aprobar" && events.some((e) => e.tipo === "aprobado");
  const estado =
    last === undefined
      ? "pendiente"
      : last.resultado === undefined
        ? running
        : approved
          ? "aprobado"
          : (outcomeText(last.resultado).split(":")[0] ?? "");
  const summary = phaseSummaries(events).find((s) => s.fase === phase);
  const usage = events.filter(
    (e): e is Extract<RunEvent, { tipo: "uso" }> => e.tipo === "uso" && e.fase === phase,
  );
  const models = [...new Set(usage.map((u) => u.modelo))];
  const header = [
    estado,
    ...(attempts.length > 1 ? [`${String(attempts.length)} intentos`] : []),
    ...(summary !== undefined && Math.round(summary.minutos * 60) > 0
      ? [clock(summary.minutos * 60_000)]
      : []),
    ...(summary !== undefined && summary.costoUsd > 0 ? [`≥ $${summary.costoUsd.toFixed(2)}`] : []),
    ...models,
  ].join(" · ");
  const byPhase = <T extends RunEvent>(tipo: T["tipo"]) =>
    events.filter((e): e is T => e.tipo === tipo && "fase" in e && e.fase === phase);
  const lines = [
    `# ${state.clave} · ${NAMES[phase]}`,
    "",
    header,
    ...section(
      "Intentos",
      attempts.map(
        (a, i) =>
          `${String(i + 1)}. ${when(a.inicio)}${a.ms === undefined ? "" : ` · ${clock(a.ms)}`}: ${a.resultado === undefined ? running : outcomeText(a.resultado)}`,
      ),
    ),
    ...own(events, run, phase),
    ...section(
      "Decisiones",
      byPhase<Extract<RunEvent, { tipo: "decision" }>>("decision").map(
        (d) =>
          `- ${d.unidad === undefined ? "" : `${d.unidad}: `}${plain(d.que)}: ${plain(d.por_que)}`,
      ),
    ),
    ...section(
      "Rechazos de tripwires",
      byPhase<Extract<RunEvent, { tipo: "rechazo" }>>("rechazo").map(
        (r) => `- ${r.unidad ?? phase} · ${r.herramienta}: ${plain(r.motivo)}`,
      ),
    ),
    ...section(
      "Avisos",
      byPhase<Extract<RunEvent, { tipo: "aviso" }>>("aviso").map((a) => `- ${plain(a.texto)}`),
    ),
    ...section(
      "Sesiones",
      usage.map(
        (u) =>
          `- \`${u.sesion}\`: ${u.modelo}, ${clock(u.duracion_ms)}, ≥ $${u.costo_usd.toFixed(2)}, ${String(u.tokens_entrada + u.tokens_salida)} tokens`,
      ),
    ),
  ];
  return { ok: true as const, run: id, fase: phase, estado, texto: `${lines.join("\n")}\n` };
}
