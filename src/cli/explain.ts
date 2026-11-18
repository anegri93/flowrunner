// `flowrunner explain <run>`: una sesión de solo lectura que le explica a la persona por qué el run se
// detuvo y qué hace cada respuesta que ofrece, antes de que elija (ADR 0037). No decide ni escribe en
// el log nada que cambie el run: deja un Markdown por detención y su uso en un evento propio.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadRepoConfig } from "../config/load.ts";
import { DEFAULT_MODELS, type ModelChoice } from "../config/schemas.ts";
import { detencionDe, stateOf, type Halt, type RunState } from "../engine/engine.ts";
import { notifyMac } from "../notify/notify.ts";
import { featureWorktree, runFeature } from "../phases/inputs.ts";
import { sessionName } from "../phases/planificar.ts";
import { featureText, render } from "../prompts/render.ts";
import { productionRuntime } from "../runner/production.ts";
import type { Deps, RunPaths } from "../runner/types.ts";
import type { NewEvent, Phase } from "../store/events.ts";
import { explicacionPaths, explicando } from "../store/explicaciones.ts";
import { tryLock } from "../store/lock.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { runPaths } from "../store/runs.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { showPhase } from "./etapa.ts";
import { UserError } from "./output.ts";
import { showUnit } from "./report.ts";
import { spawnRunProcess } from "./runs.ts";

export const EXPLICAR_TIMEOUT_MS = 10 * 60_000;
const MAX_TURNS = 40;
/** Lo que entra de cada pieza larga en el prompt: el plan y el detalle de cada sub-task. */
const MAX_PIEZA = 12_000;

export const explicacionSchema = z.object({
  resumen: z.string().min(1),
  que_paso: z.string().min(1),
  por_que_frena: z.string().min(1),
  opciones: z.array(
    z.object({
      numero: z.int().min(1),
      que_hace: z.string().min(1),
      riesgos: z.string().default(""),
    }),
  ),
  recomendada: z.int().min(1),
  por_que_recomienda: z.string().min(1),
});
export type Explicacion = z.infer<typeof explicacionSchema>;

const recortar = (text: string, max = MAX_PIEZA) =>
  text.length > max
    ? `${text.slice(0, max)}\n… (sigue: ${String(text.length - max)} caracteres más)`
    : text;

/** Las respuestas del halt, numeradas: el modelo las nombra por número y nunca copia un comando. */
export function numberedOptions(halt: Halt): string {
  return halt.opciones.map((o, i) => `${String(i + 1)}. \`${o.comando}\`: ${o.que}`).join("\n");
}

/**
 * Lo que devolvió la sesión, validado contra lo que ofrece el halt: una respuesta que no existe, o
 * repetida, no se muestra como si el run la ofreciera.
 */
export function checkExplicacion(e: Explicacion, halt: Halt): string | undefined {
  const n = halt.opciones.length;
  const fuera = e.opciones.find((o) => o.numero > n);
  if (fuera !== undefined)
    return `la explicación nombró la respuesta ${String(fuera.numero)} y el run ofrece ${String(n)}`;
  const numeros = e.opciones.map((o) => o.numero);
  if (new Set(numeros).size !== numeros.length) return "la explicación repitió una respuesta";
  if (e.recomendada > n)
    return `la explicación recomendó la respuesta ${String(e.recomendada)} y el run ofrece ${String(n)}`;
  return undefined;
}

const NOMBRE: Record<Phase, string> = {
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

/**
 * El Markdown que lee la persona. Cada respuesta del halt aparece, en su orden y con su comando tal
 * cual: la que la sesión no explicó queda con lo que dice flowrunner de ella.
 */
export function explicacionMarkdown(input: {
  clave: string;
  fase: Phase;
  halt: Halt;
  explicacion: Explicacion;
  modelo: string;
  at: Date;
}): string {
  const { halt, explicacion: e } = input;
  const opciones = halt.opciones.flatMap((o, i) => {
    const numero = i + 1;
    const dicha = e.opciones.find((x) => x.numero === numero);
    const recomendada = e.recomendada === numero;
    return [
      `### ${String(numero)}. ${o.que}${recomendada ? " · recomendada" : ""}`,
      "",
      "```sh",
      o.comando,
      "```",
      "",
      dicha?.que_hace ?? o.que,
      ...(dicha === undefined || dicha.riesgos.trim() === ""
        ? []
        : ["", `**Riesgos:** ${dicha.riesgos.trim()}`]),
      "",
    ];
  });
  return [
    `# ${input.clave} · Por qué se detuvo en ${NOMBRE[input.fase]}`,
    "",
    `> ${e.resumen.replaceAll("\n", "\n> ")}`,
    "",
    "## Qué pasó",
    "",
    e.que_paso.trim(),
    "",
    "## Por qué frena",
    "",
    e.por_que_frena.trim(),
    "",
    "## Qué podés hacer",
    "",
    ...opciones,
    "## Lo que recomiendo",
    "",
    `**${String(e.recomendada)}.** ${e.por_que_recomienda.trim()}`,
    "",
    "## El motivo, tal cual",
    "",
    "```text",
    halt.motivo,
    "```",
    "",
    `---`,
    "",
    `Explicación de ${input.modelo}, ${input.at.toISOString().slice(0, 16).replace("T", " ")} UTC. Es una ayuda para decidir: la decisión es tuya, con las respuestas de arriba.`,
    "",
  ].join("\n");
}

function modelOf(cwd: string): ModelChoice {
  try {
    return loadRepoConfig(cwd).models.explicar;
  } catch {
    // Una config que no carga no impide explicar: justamente puede ser el motivo de la detención.
    return DEFAULT_MODELS.explicar;
  }
}

/** El detalle de las sub-tasks señaladas; una que no se puede leer dice por qué en vez de frenar. */
async function unitsText(
  home: string,
  id: string,
  unidades: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  if (unidades.length === 0) return "(el run no señaló ninguna)";
  const parts = await Promise.all(
    unidades.map(async (u) => {
      try {
        return recortar((await showUnit(home, id, u, env)).texto);
      } catch (error) {
        return `## ${u}\n\nNo se pudo leer: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
  return parts.join("\n\n");
}

/** Escribe la explicación de la detención actual con una sesión de solo lectura. */
async function writeExplanation(
  run: RunPaths,
  state: RunState,
  halt: Halt,
  detencion: number,
  deps: Deps,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const feature = featureWorktree(run);
  const cwd = existsSync(feature) ? feature : state.repo;
  const model = modelOf(cwd);
  const planFile = join(run.dir, "plan.md");
  const nombre = sessionName(run, "explicar");
  const log = explicacionPaths(run, detencion).log;
  // El uso va en su propio evento; lo demás de la sesión (rechazos, avisos) a su log, no al de la
  // fase: el detalle de la etapa no tiene que mostrar a la explicación como si fuera parte de ella.
  const emit = (event: NewEvent) => {
    if (event.tipo === "uso") {
      appendEvent(run.dir, {
        tipo: "explicacion",
        fase: state.fase,
        detencion,
        sesion: event.sesion,
        modelo: event.modelo,
        costo_usd: event.costo_usd,
        tokens_entrada: event.tokens_entrada,
        tokens_salida: event.tokens_salida,
        duracion_ms: event.duracion_ms,
      });
      return;
    }
    writeFileSync(log, `${JSON.stringify(event)}\n`, { flag: "a" });
  };
  let featureMd: string;
  try {
    featureMd = featureText(runFeature(run));
  } catch {
    featureMd = "(no se pudo leer la feature del run)";
  }
  let etapa: string;
  try {
    etapa = recortar(showPhase(run.home, run.id, state.fase).texto);
  } catch (error) {
    etapa = `No se pudo leer: ${error instanceof Error ? error.message : String(error)}`;
  }
  const result = await runSession(
    {
      fase: state.fase,
      nombre,
      prompt: render("explicar", {
        feature: featureMd,
        fase: state.fase,
        motivo: halt.motivo,
        unidades:
          halt.unidades === undefined || halt.unidades.length === 0
            ? ""
            : `Parece ser de: ${halt.unidades.join(", ")}`,
        opciones: numberedOptions(halt),
        etapa,
        subtareas: await unitsText(run.home, run.id, halt.unidades ?? [], deps.env),
        plan: existsSync(planFile) ? recortar(readFileSync(planFile, "utf8")) : "(todavía no hay)",
      }),
      cwd,
      model,
      tools: ["Read", "Grep", "Glob"],
      hook: tripwireHook(
        {
          scope: {
            root: realpathSync(cwd),
            owner: state.fase,
            writable: [],
            writeGlobs: [],
            locked: [],
            harness: [],
            lockfiles: [],
            manifests: [],
            depsDeclared: false,
            testGlobs: [],
            comandos: { ampliables: [], exactos: [], fixers: [] },
          },
          fase: state.fase,
          write: false,
          bash: false,
          agents: false,
          graft: false,
        },
        emit,
      ),
      schema: explicacionSchema,
      timeoutMs: EXPLICAR_TIMEOUT_MS,
      maxTurns: MAX_TURNS,
    },
    { run, deps, emit },
  );
  if (result.tipo === "limite")
    return { ok: false, motivo: "la suscripción llegó a su límite; probá más tarde" };
  if (result.tipo === "falla") return { ok: false, motivo: result.motivo };
  const invalid = checkExplicacion(result.output, halt);
  if (invalid !== undefined) return { ok: false, motivo: invalid };
  writeFileSync(
    explicacionPaths(run, detencion).md,
    explicacionMarkdown({
      clave: state.clave,
      fase: state.fase,
      halt,
      explicacion: result.output,
      modelo: model.model,
      at: deps.now(),
    }),
  );
  return { ok: true };
}

/** El run detenido y su detención, o por qué no se explica. */
function stopped(home: string, id: string) {
  const run = runPaths(home, id);
  if (!existsSync(join(run.dir, "events.jsonl")))
    throw new UserError(`no existe el run ${id}`, "flowrunner status");
  const { events } = readLog(run.dir);
  const state = stateOf(events);
  const detencion = detencionDe(events);
  if (state.status !== "detenido" || state.halt === undefined || detencion === undefined) {
    throw new UserError(
      `el run ${id} está ${state.status}: solo se explica un run detenido`,
      state.status === "esperando_aprobacion" ? `flowrunner plan ${id}` : `flowrunner status ${id}`,
    );
  }
  return { run, state, halt: state.halt, detencion };
}

type Respuesta =
  | { ok: true; id: string; estado: "lista"; archivo: string; texto: string }
  | { ok: true; id: string; estado: "explicando"; resultado: string };

const lista = (id: string, md: string): Respuesta => ({
  ok: true,
  id,
  estado: "lista",
  archivo: md,
  texto: readFileSync(md, "utf8"),
});

/**
 * `explain <run>`: la explicación de la detención actual. Si ya está, se devuelve sin otra sesión; si
 * otro proceso la está escribiendo, se dice. Si no, se escribe ahora.
 */
export async function explainRun(
  home: string,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<Respuesta> {
  const { run, state, halt, detencion } = stopped(home, id);
  const p = explicacionPaths(run, detencion);
  if (existsSync(p.md)) return lista(id, p.md);
  mkdirSync(p.dir, { recursive: true });
  if (!tryLock(p.lock))
    return { ok: true, id, estado: "explicando", resultado: "otro proceso la está escribiendo" };
  try {
    rmSync(p.error, { force: true });
    const { deps } = await productionRuntime(env, (t, b) => {
      notifyMac(t, b, env);
    });
    const done = await writeExplanation(run, state, halt, detencion, deps);
    if (!done.ok) {
      writeFileSync(p.error, `${done.motivo}\n`);
      throw new UserError(`no se pudo explicar ${id}: ${done.motivo}`, `flowrunner explain ${id}`);
    }
    return lista(id, p.md);
  } finally {
    rmSync(p.lock, { force: true });
  }
}

/**
 * `explain --fondo`: lo mismo en un proceso aparte, para el panel de Orca, que corta cada comando a
 * los 20 s. Si ya está, la devuelve; si no, contesta enseguida y avisa al terminar.
 */
export function explainInBackground(home: string, id: string, env: NodeJS.ProcessEnv): Respuesta {
  const { run, detencion } = stopped(home, id);
  const p = explicacionPaths(run, detencion);
  if (existsSync(p.md)) return lista(id, p.md);
  mkdirSync(p.dir, { recursive: true });
  if (explicando(p.lock))
    return { ok: true, id, estado: "explicando", resultado: "la estoy escribiendo" };
  rmSync(p.error, { force: true });
  // El candado lleva el pid del proceso nuevo desde ya: el panel lo ve «explicando» sin esperar a
  // que arranque, y el proceso lo reconoce como suyo.
  const pid = spawnRunProcess(run, env, "_explain");
  writeFileSync(p.lock, String(pid));
  return { ok: true, id, estado: "explicando", resultado: "explicando: te aviso cuando esté" };
}

/** El proceso de `explain --fondo`: escribe la explicación y avisa en qué quedó. */
export async function explainAndNotify(home: string, id: string, env: NodeJS.ProcessEnv) {
  const clave = stateOf(readLog(runPaths(home, id).dir).events).clave;
  try {
    const done = await explainRun(home, id, env);
    if (done.estado === "lista")
      notifyMac("flowrunner", `${clave}: la explicación está lista`, env);
    return done;
  } catch (error) {
    notifyMac(
      "flowrunner",
      `${clave}: no pude explicar la detención. ${error instanceof Error ? error.message : ""}`,
      env,
    );
    throw error;
  }
}
