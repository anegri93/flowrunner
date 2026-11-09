// Antes de abrir la PR, lo que al run le costó corregirse solo se vuelve lecciones propuestas: las
// vueltas de verificar y revisar y los cambios que la persona pidió al plan. Llegan en un commit aparte
// de la misma PR, así que la persona las revisa junto con el código: si una no la convence, la borra;
// si mergea, quedan en el cerebro. Las escribe un modelo, por eso nunca entran sin esa revisión.
// Aprender es secundario: si algo falla acá, la entrega sigue con un aviso.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES } from "../brain/brain.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { APRENDER_TIMEOUT_MS, nextLessonNumber, readOnlyHook } from "./aprender.ts";
import { runFeature } from "./inputs.ts";
import { sessionName } from "./planificar.ts";

export interface Friction {
  /** Cómo se cita en la lección: `revisar, vuelta 1`. */
  readonly origen: string;
  readonly texto: string;
}

/** Lo que el run tuvo que corregir: las vueltas de verificar y revisar y los cambios al plan. */
export function frictions(events: readonly RunEvent[]): Friction[] {
  const counts = new Map<string, number>();
  const next = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  return events.flatMap((e): Friction[] => {
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
  origen: z.string().min(1),
});
export const proposalSchema = z.object({ lecciones: z.array(lessonSchema).max(3) });
export type Lesson = z.infer<typeof lessonSchema>;

/** Las lecciones como entradas de lecciones.md, numeradas después de la última que ya hay. */
export function formatLessons(
  lessons: readonly Lesson[],
  current: string,
  runId: string,
  today: string,
): string {
  let n = nextLessonNumber(current);
  return lessons
    .map(
      (l) =>
        `\n### L-${String(n++)} · ${l.titulo}\n\nRegla: ${l.regla}\n\nOrigen: run ${runId} · ${l.origen} · ${today}\n`,
    )
    .join("");
}

/** El archivo del run con la sección de la PR: lo que se propone, o por qué no hay nada. */
export const proposalFile = (runDir: string) => join(runDir, "lecciones-propuestas.md");

const HOW_TO_REJECT =
  "flowrunner propone sumar al cerebro estas lecciones, en un commit aparte de esta PR. Si alguna no te convence, borrala de `.flowrunner/lecciones.md` antes de mergear; si mergeás, quedan.";

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
  if (lessons.length === 0) {
    write(
      `Nada nuevo para el cerebro: lo que hubo que corregir (${found.map((f) => f.origen).join("; ")}) fue propio de esta feature.`,
      0,
    );
    return;
  }
  const added = formatLessons(lessons, current, run.id, deps.now().toISOString().slice(0, 10));
  writeFileSync(lessonsFile, `${current.trimEnd()}\n${added}`);
  const feature = runFeature(run);
  await git(worktree, ["add", join(".flowrunner", BRAIN_FILES.lecciones.file)], deps.env);
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
  write(`${HOW_TO_REJECT}\n${added}`, lessons.length);
}
