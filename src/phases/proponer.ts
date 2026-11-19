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
 * feedback sobre la PR. Y lo que aprendió sin vueltas (flowrunner 2.0): lo que descubrió el que
 * implementa, lo que preguntó el planificador con tu respuesta, y las decisiones de revisar con cómo
 * las resolviste.
 */
export function frictions(events: readonly RunEvent[]): Friction[] {
  const counts = new Map<string, number>();
  const next = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  // La pregunta que espera tu respuesta: la de planificar se responde con `respondido`; la de revisar,
  // con cualquier respuesta a la detención.
  let pendiente: { fase: "planificar" | "revisar"; motivo: string } | undefined;
  const resuelta = (como: string): Friction[] => {
    if (pendiente?.fase !== "revisar") return [];
    const f = {
      origen: `revisar, decisión ${String(next("decision"))}`,
      texto: `${pendiente.motivo}\n${como}`,
    };
    pendiente = undefined;
    return [f];
  };
  return events.flatMap((e): Friction[] => {
    if (e.tipo === "descubrimiento") {
      return [
        {
          origen: `${e.fase} ${e.unidad}, descubrimiento ${String(next(`desc-${e.unidad}`))}`,
          texto: `${e.que} (${e.donde}): ${e.como}`,
        },
      ];
    }
    if (
      e.tipo === "accion_terminada" &&
      e.resultado.tipo === "pregunta" &&
      (e.fase === "planificar" || e.fase === "revisar")
    ) {
      pendiente = { fase: e.fase, motivo: e.resultado.motivo };
      return [];
    }
    if (e.tipo === "respondido" && pendiente?.fase === "planificar") {
      const f = {
        origen: `planificar, pregunta ${String(next("pregunta"))}`,
        texto: `${pendiente.motivo}\nRespondiste: ${e.respuesta}`,
      };
      pendiente = undefined;
      return [f];
    }
    if (e.tipo === "aceptado") return resuelta(`Decidiste seguir igual: ${e.motivo}`);
    if (e.tipo === "arreglo_pedido")
      return resuelta(`Pediste que ${e.unidades.join(", ")} lo corrija: ${e.instruccion}`);
    if (e.tipo === "arreglo_manual_iniciado") return resuelta("Lo arreglaste a mano");
    if (e.tipo === "rehacer") return resuelta(`Rehiciste desde ${e.desde}`);
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
  lecciones: z.array(lessonSchema).max(3),
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

/**
 * Las partes del archivo de propuestas que ya está en la rama: las lecciones, cada una desde su
 * `### `, y las líneas de las que no alcanzaron. Después de un feedback la PR se entrega de nuevo y
 * ese archivo sigue en la rama: lo nuevo se suma, no lo reemplaza (ADR 0038).
 */
export function partesDePropuestas(text: string): { lecciones: string; noAlcanzaron: string[] } {
  const i = text.indexOf(`\n${MISSES_HEADING}`);
  const antes = i === -1 ? text : text.slice(0, i);
  const despues = i === -1 ? "" : text.slice(i + MISSES_HEADING.length + 1);
  const j = antes.indexOf("\n### ");
  return {
    lecciones: j === -1 ? "" : `${antes.slice(j).trimEnd()}\n`,
    noAlcanzaron: despues.split("\n").filter((l) => l.startsWith("- ")),
  };
}

export const cuantasLecciones = (lecciones: string) => (lecciones.match(/^### /gm) ?? []).length;

/** El archivo de propuestas de la feature, con sus lecciones y las que no alcanzaron. */
export function archivoDePropuestas(
  clave: string,
  lecciones: string,
  noAlcanzaron: readonly string[],
): string {
  const missed =
    noAlcanzaron.length === 0 ? "" : `\n${MISSES_HEADING}\n\n${noAlcanzaron.join("\n")}\n`;
  return `# Lecciones propuestas por ${clave}\n\nAl mergear su PR, flowrunner las pasa a \`lecciones.md\` con su número.\n${lecciones}${missed}`;
}

export async function proposeLessons(
  ctx: PhaseContext,
  worktree: string,
  config: RepoConfig,
): Promise<void> {
  const { run, deps, emit } = ctx;
  const found = frictions(ctx.events);
  const feature = runFeature(run);
  const file = proposalsFile(feature.clave);
  // Lo que propuso una entrega anterior de esta misma PR sigue en la rama: al mergear entra igual,
  // así que la sección de la PR lo muestra y la sesión no lo repite.
  const previas = existsSync(join(worktree, file))
    ? partesDePropuestas(readFileSync(join(worktree, file), "utf8"))
    : { lecciones: "", noAlcanzaron: [] };
  const cuantasPrevias = cuantasLecciones(previas.lecciones);
  const hayPrevias = cuantasPrevias > 0 || previas.noAlcanzaron.length > 0;
  const bloquePrevio = hayPrevias
    ? `\n\nYa propuesto en una entrega anterior de esta PR:\n${previas.lecciones}${
        previas.noAlcanzaron.length === 0
          ? ""
          : `\n${MISSES_HEADING}\n\n${previas.noAlcanzaron.join("\n")}\n`
      }`
    : "";
  const write = (text: string, cantidad: number) => {
    writeFileSync(proposalFile(run.dir), `${text}\n`);
    emit({ tipo: "lecciones_propuestas", cantidad });
  };
  /** Sin nada nuevo: la sección dice por qué, y sigue mostrando lo que ya estaba en la rama. */
  const nadaNuevo = (porque: string) => {
    if (!hayPrevias) write(porque, 0);
    else write(`${howToReject(file)}${bloquePrevio}\nEn esta entrega: ${porque}`, cuantasPrevias);
  };
  if (found.length === 0) {
    nadaNuevo(
      "Nada nuevo para el cerebro: no hubo vueltas, cambios al plan, preguntas ni descubrimientos.",
    );
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
        lecciones:
          cuantasPrevias === 0
            ? current
            : `${current}\n\n# Ya propuestas en esta PR, que no hay que repetir\n${previas.lecciones}`,
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
    nadaNuevo("No se pudieron proponer lecciones en este run; el informe dice por qué.");
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
    nadaNuevo(
      "Las lecciones propuestas se descartaron porque citaban algo que no pasó; el informe dice qué.",
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
    nadaNuevo(
      `Nada nuevo para el cerebro: lo que hubo que corregir (${found.map((f) => f.origen).join("; ")}) fue propio de esta feature.${suggestions}`,
    );
    return;
  }
  const today = deps.now().toISOString().slice(0, 10);
  const added = formatLessons(lessons, run.id, today);
  const missLines = misses.map((m) => `- ${m.leccion} · run ${run.id} · ${m.origen} · ${today}`);
  mkdirSync(dirname(join(worktree, file)), { recursive: true });
  writeFileSync(
    join(worktree, file),
    archivoDePropuestas(feature.clave, `${previas.lecciones}${added}`, [
      ...previas.noAlcanzaron,
      ...missLines,
    ]),
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
      ? hayPrevias
        ? `${howToReject(file)}\n\nNinguna lección nueva en esta entrega.`
        : "Ninguna lección nueva para el cerebro."
      : `${howToReject(file)}\n${added}`;
  write(`${intro}${missedForPr}${suggestions}${bloquePrevio}`, lessons.length + cuantasPrevias);
}
