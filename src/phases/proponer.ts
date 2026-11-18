// Antes de abrir la PR, lo que al run le costó corregirse solo se vuelve lecciones propuestas: las
// vueltas de verificar y revisar y los cambios que la persona pidió al plan. Llegan en un commit aparte
// de la misma PR, en `.flowrunner/propuestas/<clave>.md`, así que la persona las revisa junto con el
// código: si una no la convence, la borra; si mergea, aprender las pasa a lecciones.md con su número.
// Las escribe un modelo, por eso nunca entran sin esa revisión.
// Aprender es secundario: si algo falla acá, la entrega sigue con un aviso.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES, proposalsFile } from "../brain/brain.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { APRENDER_TIMEOUT_MS, lessonNumbers, MISSES_HEADING, readOnlyHook } from "./aprender.ts";
import { runFeature } from "./inputs.ts";
import { sessionName } from "./planificar.ts";

export interface Friction {
  /** Cómo se cita en la lección: `revisar, vuelta 1`. */
  readonly origen: string;
  readonly texto: string;
}

/**
 * Lo que el run tuvo que corregir: las vueltas de verificar y revisar, los cambios al plan y tu
 * feedback sobre la PR.
 */
export function frictions(events: readonly RunEvent[]): Friction[] {
  const counts = new Map<string, number>();
  const next = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  return events.flatMap((e): Friction[] => {
    // Tu feedback sobre la PR es una corrección: lo que el run entregó no era lo que pedías (ADR 0038).
    if (e.tipo === "feedback_pedido") {
      return [{ origen: `tu feedback sobre la PR ${String(next("feedback"))}`, texto: e.texto }];
    }
    if (e.tipo === "cambios_pedidos") {
      return [{ origen: `aprobar, cambios pedidos ${String(next("aprobar"))}`, texto: e.motivo }];
    }
    if (e.tipo === "accion_terminada" && e.resultado.tipo === "vuelve") {
      return [{ origen: `${e.fase}, vuelta ${String(next(e.fase))}`, texto: e.resultado.motivo }];
    }
    return [];
  });
}

const lessonSchema = z.object({
  titulo: z.string().min(1),
  regla: z.string().min(1),
  /** Dónde del repo vale la regla. Una lección que no puede decirlo era de esa feature y no sirve. */
  aplica: z.string().min(1),
  origen: z.string().min(1),
});
export const proposalSchema = z.object({
  lecciones: z.array(lessonSchema).max(2),
  /** Lo que se arregla en la configuración del repo (format, typecheck, un script), no con una lección. */
  sugerencias: z.array(z.string().min(1)).max(3).default([]),
  /** Lecciones que ya estaban, cubrían la fricción y no la evitaron. */
  no_alcanzaron: z
    .array(z.object({ leccion: z.string().regex(/^L-\d+$/), origen: z.string().min(1) }))
    .max(3)
    .default([]),
});
export type Lesson = z.infer<typeof lessonSchema>;

/**
 * Las lecciones como entradas del archivo de propuestas, sin número: el número lo pone aprender al
 * pasarlas a lecciones.md, ya con la base al día.
 */
export function formatLessons(lessons: readonly Lesson[], runId: string, today: string): string {
  return lessons
    .map(
      (l) =>
        `\n### ${l.titulo}\n\nRegla: ${l.regla}\n\nAplica: ${l.aplica}\n\nOrigen: run ${runId} · ${l.origen} · ${today}\n`,
    )
    .join("");
}

/** El archivo del run con la sección de la PR: lo que se propone, o por qué no hay nada. */
export const proposalFile = (runDir: string) => join(runDir, "lecciones-propuestas.md");

const howToReject = (file: string) =>
  `flowrunner propone sumar al cerebro estas lecciones, en un commit aparte de esta PR, en \`${file}\`. Si alguna no te convence, borrala de ese archivo antes de mergear; al mergear, flowrunner las pasa a \`.flowrunner/lecciones.md\` con su número.`;

export async function proposeLessons(
  ctx: PhaseContext,
  worktree: string,
  config: RepoConfig,
): Promise<void> {
  const { run, deps, emit } = ctx;
  const found = frictions(ctx.events);
  const write = (text: string, cantidad: number) => {
    writeFileSync(proposalFile(run.dir), `${text}\n`);
    emit({ tipo: "lecciones_propuestas", cantidad });
  };
  if (found.length === 0) {
    write("Nada nuevo para el cerebro: no hubo vueltas ni cambios al plan.", 0);
    return;
  }
  const lessonsFile = join(worktree, ".flowrunner", BRAIN_FILES.lecciones.file);
  const current = existsSync(lessonsFile) ? readFileSync(lessonsFile, "utf8") : "# Lecciones\n";
  const result = await runSession(
    {
      fase: "entregar",
      nombre: sessionName(run, "entregar-lecciones"),
      prompt: render("proponer", {
        origenes: found.map((f) => f.origen).join("\n"),
        feature: featureText(runFeature(run)),
        friccion: found.map((f) => `### ${f.origen}\n\n${f.texto}`).join("\n\n"),
        lecciones: current,
      }),
      cwd: worktree,
      model: config.models.aprender,
      tools: [],
      hook: readOnlyHook(ctx, worktree, "entregar"),
      schema: proposalSchema,
      timeoutMs: APRENDER_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok") {
    const why = result.tipo === "limite" ? "el límite de la suscripción" : result.motivo;
    emit({ tipo: "aviso", fase: "entregar", texto: `no se pudieron proponer lecciones: ${why}` });
    write("No se pudieron proponer lecciones en este run; el informe dice por qué.", 0);
    return;
  }
  const origins = new Set(found.map((f) => f.origen));
  const invented = result.output.lecciones.filter((l) => !origins.has(l.origen));
  if (invented.length > 0) {
    emit({
      tipo: "aviso",
      fase: "entregar",
      texto: `se descartaron las lecciones propuestas: una cita un origen que no pasó en el run, ${invented[0]?.origen ?? ""}`,
    });
    write(
      "Las lecciones propuestas se descartaron porque citaban algo que no pasó; el informe dice qué.",
      0,
    );
    return;
  }
  const lessons = result.output.lecciones;
  const known = new Set(lessonNumbers(current).map((n) => `L-${String(n)}`));
  const misses = result.output.no_alcanzaron.filter(
    (m) => known.has(m.leccion) && origins.has(m.origen),
  );
  if (misses.length < result.output.no_alcanzaron.length) {
    emit({
      tipo: "aviso",
      fase: "entregar",
      texto:
        "se descartó una lección que no alcanzó: no está en lecciones.md o cita algo que no pasó",
    });
  }
  const suggestions =
    result.output.sugerencias.length === 0
      ? ""
      : `\n\nSe arregla en la configuración del repo, no con una lección:\n\n${result.output.sugerencias.map((s) => `- ${s}`).join("\n")}`;
  if (lessons.length === 0 && misses.length === 0) {
    write(
      `Nada nuevo para el cerebro: lo que hubo que corregir (${found.map((f) => f.origen).join("; ")}) fue propio de esta feature.${suggestions}`,
      0,
    );
    return;
  }
  const feature = runFeature(run);
  const file = proposalsFile(feature.clave);
  const today = deps.now().toISOString().slice(0, 10);
  const added = formatLessons(lessons, run.id, today);
  const missed =
    misses.length === 0
      ? ""
      : `\n${MISSES_HEADING}\n\n${misses.map((m) => `- ${m.leccion} · run ${run.id} · ${m.origen} · ${today}`).join("\n")}\n`;
  mkdirSync(dirname(join(worktree, file)), { recursive: true });
  writeFileSync(
    join(worktree, file),
    `# Lecciones propuestas por ${feature.clave}\n\nAl mergear su PR, flowrunner las pasa a \`lecciones.md\` con su número.\n${added}${missed}`,
  );
  await git(worktree, ["add", file], deps.env);
  await git(
    worktree,
    [
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `docs(lecciones): lo que aprendió ${feature.clave}`,
      "--trailer",
      `Flowrunner-Run: ${run.id}`,
    ],
    deps.env,
  );
  const missedForPr =
    misses.length === 0
      ? ""
      : `\n\nLecciones que ya estaban y no alcanzaron (al mergear, quedan anotadas en cada una): ${misses.map((m) => `${m.leccion} (${m.origen})`).join(", ")}.`;
  const intro =
    lessons.length === 0
      ? "Ninguna lección nueva para el cerebro."
      : `${howToReject(file)}\n${added}`;
  write(`${intro}${missedForPr}${suggestions}`, lessons.length);
}
