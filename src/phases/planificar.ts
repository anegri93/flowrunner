// Planificar: una sesión de Opus que lee el código con graft y un explorador, escribe los tests de
// aceptación dentro de los globs de tests, y devuelve el plan. El gate decide si sirve.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HookCallback, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadBrain, type Brain } from "../brain/brain.ts";
import { stateOf } from "../engine/engine.ts";
import { isVerifyCommand, loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { checkConserva, conservadas } from "../gates/conserva.ts";
import { chequeosEstaticos } from "../gates/estaticos.ts";
import {
  checkCommandsFail,
  checkCommandsPass,
  delRun,
  planSchema,
  type Plan,
} from "../gates/plan.ts";
import { VALIDAR_PLAN_TOOL, validarPlanServer } from "../gates/validar-plan.ts";
import { changesSince, commitAll, discardChanges, headSha } from "../git/git.ts";
import { contextoGraft } from "../graft/contexto.ts";
import { buildIndex, GRAFT_TOOLS, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import { readLog } from "../store/run-log.ts";
import type { Outcome, RunEvent } from "../store/events.ts";
import { archivosNombrados, desajusteDe } from "../feature/citas.ts";
import type { Feature } from "../feature/feature.ts";
import type { PhaseContext, PhaseFn, RunPaths } from "../runner/types.ts";
import { runSession, type SessionResult, type SessionSpec } from "../agent/session.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { isTestFile } from "../tripwires/rules.ts";
import { versionesSchema, type Versiones } from "../versiones/versiones.ts";
import { copyEnvFiles } from "./env-files.ts";
import { EXPLORACION_FALLIDA, explorar } from "./explorar.ts";
import { runFixers } from "./fixers.ts";
import { reinstalarSiCambiaron } from "./reinstalar.ts";
import { conEntorno } from "./turno-entorno.ts";
import { graftIndex, prepared, runFeature, type Prepared } from "./inputs.ts";
import {
  commitsDeLaRama,
  conLosTests,
  conservaDelPlan,
  enAnterior,
  ramaAnterior,
  reaplicar,
  soltarAnterior,
  type BaseConserva,
  type RamaAnterior,
  type Reaplicado,
} from "./conservar.ts";
import {
  archivePlan,
  previousDir,
  replanOf,
  replanText,
  type Implementada,
  type Replan,
} from "./plan-anterior.ts";

export const PLANIFICAR_TIMEOUT_MS = 30 * 60_000;

/** `planificar-3`: un nombre de sesión que no pisa los de intentos anteriores, ni de un rerun. */
export function sessionName(run: RunPaths, base: string): string {
  const dir = join(run.dir, "sesiones");
  const taken = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(`${base}-`)).length
    : 0;
  return `${base}-${taken + 1}`;
}

export function brainVars(brain: Brain): Record<string, string> {
  const orNone = (text: string) => (text.trim() === "" ? "(vacío)" : text);
  return {
    convenciones: orNone(brain.convenciones),
    contexto: orNone(brain.contexto),
    que_es_bien: orNone(brain.queEsBien),
    lecciones: orNone(brain.lecciones),
    ejemplos: brain.ejemplos.length === 0 ? "(ninguno)" : brain.ejemplos.join(", "),
  };
}

/** Hasta cuántos archivos de la feature pasan a `contextoGraft`, en el orden en que aparecen. */
const MAX_ARCHIVOS_UBICADOS = 20;

/**
 * La sección del prompt con lo que la feature ya ubicó y el contexto de graft de esos archivos. Con
 * `sinIndice`, el índice no describe el worktree de la sesión: no se consulta, y el texto lo dice.
 */
export async function codigoUbicado(
  feature: Feature,
  worktree: string,
  indexDir: string,
  env: NodeJS.ProcessEnv,
  sinIndice?: string,
): Promise<string> {
  const citas = feature.contexto;
  const archivos =
    citas.length > 0
      ? [...new Set(citas.map((c) => c.ruta))].slice(0, MAX_ARCHIVOS_UBICADOS)
      : archivosNombrados(feature, (r) => existsSync(join(worktree, r)), MAX_ARCHIVOS_UBICADOS);
  if (archivos.length === 0)
    return "La feature no ubicó código: explorá vos, con graft y el explorador.";
  // `feature check` comparó las citas con el checkout de la persona; la sesión ve otra rama, bajada
  // después y quizás con código conservado. Lo que no coincide con ella se marca, no se da por cierto.
  const leer = (ruta: string) => {
    const abs = join(worktree, ruta);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
  };
  const lineas = citas.map((c) => {
    const lineasDe =
      c.desde === undefined
        ? ""
        : `:${c.desde}${c.hasta !== undefined && c.hasta !== c.desde ? `-${c.hasta}` : ""}`;
    const d = desajusteDe(c, leer);
    const marca =
      d === undefined
        ? ""
        : d.tipo === "falta"
          ? " · ⚠ no está en este worktree"
          : ` · ⚠ en este worktree el archivo tiene ${d.lineas} líneas`;
    return `- ${c.ruta}${lineasDe} — ${c.que}${marca}`;
  });
  const graft =
    sinIndice === undefined
      ? await contextoGraft({ repo: worktree, indexDir, archivos, env })
      : `(graft no pudo armar el contexto: ${sinIndice})`;
  return [
    ...(lineas.length === 0
      ? [`La feature no trae citas; estos son los archivos que nombra: ${archivos.join(", ")}.`]
      : ["## Lo que comprobó quien escribió la feature", "", ...lineas]),
    "",
    "## Lo que dice graft de esos archivos",
    "",
    graft,
  ].join("\n");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Los artefactos que leen aprobar, implementar y verificar. */
export function writePlanArtifacts(
  run: RunPaths,
  plan: Plan,
  locked: Record<string, string>,
  /** Los SHAs nuevos de cada sub-task conservada de un replan: implementar las da por integradas. */
  conservadas: Record<string, string[]> = {},
): void {
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(join(run.dir, "plan.md"), plan.plan);
  writeFileSync(join(run.dir, "tasks.json"), json(plan.subtareas));
  writeFileSync(join(run.dir, "ac-map.json"), json(plan.criterios));
  writeFileSync(join(run.dir, "locked.json"), json(locked));
  writeFileSync(join(run.dir, "cambios-existentes.json"), json(plan.cambia_lo_existente));
  writeFileSync(join(run.dir, "conservadas.json"), json(conservadas));
  // Las versiones son de un plan: las del anterior no valen para este. Las elige aprobar.
  rmSync(versionesFile(run.dir), { force: true });
}

const versionesFile = (dir: string) => join(dir, "versiones.json");

/** Las sub-tasks con sus dependencias fijadas, y qué eligió aprobar (ADR 0028). */
export function writeVersiones(
  run: RunPaths,
  subtareas: Plan["subtareas"],
  versiones: Versiones,
): void {
  writeFileSync(join(run.dir, "tasks.json"), `${JSON.stringify(subtareas, null, 2)}\n`);
  writeFileSync(versionesFile(run.dir), `${JSON.stringify(versiones, null, 2)}\n`);
}

export const readPlan = (run: RunPaths) => readPlanAt(run.dir);

export function readPlanAt(dir: string): Pick<
  Plan,
  "subtareas" | "criterios" | "cambia_lo_existente"
> & {
  plan: string;
  locked: Record<string, string>;
  conservadas: Record<string, string[]>;
  /** Undefined si aprobar todavía no eligió, o el repo no es de npm. */
  versiones: Versiones | undefined;
} {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const cambios = join(dir, "cambios-existentes.json");
  const kept = join(dir, "conservadas.json");
  return {
    plan: read("plan.md"),
    subtareas: JSON.parse(read("tasks.json")) as Plan["subtareas"],
    criterios: JSON.parse(read("ac-map.json")) as Plan["criterios"],
    locked: JSON.parse(read("locked.json")) as Record<string, string>,
    // Un run planificado antes de que existiera el archivo no declaró nada: se lee como vacío.
    cambia_lo_existente: existsSync(cambios)
      ? (JSON.parse(readFileSync(cambios, "utf8")) as Plan["cambia_lo_existente"])
      : [],
    // Lo mismo con lo conservado: un plan de antes no conservó nada.
    conservadas: existsSync(kept)
      ? (JSON.parse(readFileSync(kept, "utf8")) as Record<string, string[]>)
      : {},
    versiones: existsSync(versionesFile(dir))
      ? versionesSchema.parse(JSON.parse(readFileSync(versionesFile(dir), "utf8")))
      : undefined,
  };
}

/** Lo que comparten el intento nuevo, el retomado y el gate: se calcula una vez por llamada a la fase. */
interface Comun {
  readonly prep: Prepared;
  readonly worktree: string;
  readonly config: RepoConfig;
  readonly brain: Brain;
  readonly feature: Feature;
  readonly hook: HookCallback;
  /** Si un comando es el verify del repo: el mismo para el gate de afuera y para `validar_plan`. */
  readonly esVerify: (comando: string) => boolean;
  /** La sesión del planificador, sin lo que cambia entre un intento nuevo y uno retomado. */
  readonly spec: Omit<
    SessionSpec<Plan>,
    "prompt" | "nombre" | "sessionId" | "resume" | "mcpServers"
  >;
}

interface Intento {
  readonly result: SessionResult<Plan>;
  /** Los tests restaurados del plan anterior; vacío en un resume. */
  readonly restored: readonly (readonly [string, string])[];
  /** Hay que descartar los tests nuevos que el plan no declara (solo en un resume). */
  readonly limpiarNoDeclarados: boolean;
  /** Lo que el replan necesita en el gate (ADR 0024). */
  readonly previous: ReturnType<typeof readPlanAt> | undefined;
  readonly rama: RamaAnterior;
  /** Las candidatas que están en la rama al abrir la sesión, y en `nuevos` sus SHAs en esa rama. */
  readonly armada: Reaplicado;
  /** El HEAD al abrir la sesión: lo que cambió desde ahí lo escribió el planificador. */
  readonly inicioSesion: string;
  readonly sinIndice: string | undefined;
  readonly avisados: Set<string>;
  /** La conversación de este intento: la que se retoma si el gate rechaza su plan. */
  readonly sesion: { readonly sessionId: string; readonly nombre: string };
}

/**
 * La sesión de planificar que se puede retomar (ADR 0025). Es una marca de «el gate rechazó este plan,
 * con este motivo»: se escribe solo al rechazarlo y se consume al empezar la próxima llamada, así un
 * proceso que muere a mitad de camino deja al siguiente intento planificando de cero.
 */
const sesionFile = (run: RunPaths) => join(run.dir, "planificar-sesion.json");
const sesionSchema = z.object({
  sessionId: z.string().min(1),
  nombre: z.string().min(1),
  /** El motivo del rechazo: el del reintento tiene que ser este, no el de un intento anterior. */
  motivo: z.string().min(1),
});
type SesionMarcada = z.infer<typeof sesionSchema>;

/** El id de la sesión del último intento, o undefined. Un archivo roto cuenta como ausente. */
export function sesionAnterior(run: RunPaths): SesionMarcada | undefined {
  try {
    return sesionSchema.parse(JSON.parse(readFileSync(sesionFile(run), "utf8")));
  } catch {
    return undefined;
  }
}

/** Lee la marca y la borra: vale para una sola llamada a la fase. */
function tomarSesion(run: RunPaths): SesionMarcada | undefined {
  const sesion = sesionAnterior(run);
  rmSync(sesionFile(run), { force: true });
  return sesion;
}

/**
 * El motivo del gate, si este intento es el reintento de un plan rechazado: la última
 * `accion_terminada` de planificar es `falla` de clase `gate`, su motivo es la instrucción de este
 * intento, y después no hubo `rehacer` ni `cambios_pedidos`.
 */
export function gateRechazado(
  events: readonly RunEvent[],
  instruccion: string | undefined,
): string | undefined {
  if (instruccion === undefined) return undefined;
  const last = events.findLastIndex(
    (e) => e.tipo === "accion_terminada" && e.fase === "planificar",
  );
  const terminada = events[last];
  if (
    terminada?.tipo !== "accion_terminada" ||
    terminada.resultado.tipo !== "falla" ||
    terminada.resultado.clase !== "gate" ||
    terminada.resultado.motivo !== instruccion
  )
    return undefined;
  const despues = events.slice(last + 1);
  return despues.some((e) => e.tipo === "rehacer" || e.tipo === "cambios_pedidos")
    ? undefined
    : instruccion;
}

/** El único mensaje de un intento retomado. */
export const mensajeRetomado = (motivo: string) =>
  `El gate rechazó el plan que devolviste:\n\n${motivo}\n\nCorregí el plan y los tests en este mismo worktree, sin volver a explorar lo que ya leíste, y devolvé el plan completo otra vez.`;

/**
 * Borra del disco las conversaciones de esta llamada que no quedaron marcadas para retomar. Es una
 * limpieza, no un requisito: una que no se encuentra no es un error.
 */
async function olvidarSesiones(
  ctx: PhaseContext,
  worktree: string,
  usadas: readonly string[],
): Promise<void> {
  const marcada = sesionAnterior(ctx.run)?.sessionId;
  for (const id of new Set(usadas)) {
    if (id === marcada) continue;
    try {
      await ctx.deps.deleteSession(id, { dir: worktree });
    } catch {
      // En modo token la conversación vive en la config de Claude de flowrunner, que este proceso no
      // busca: queda como residuo (ADR 0025).
    }
  }
}

function armarComun(ctx: PhaseContext): Comun {
  const { run, emit } = ctx;
  const prep = prepared(ctx.events);
  const worktree = prep.worktree;
  const config: RepoConfig = loadRepoConfig(worktree);
  const brain = loadBrain(worktree);
  const feature = runFeature(run);
  const hook = tripwireHook(
    {
      scope: {
        root: realpathSync(worktree),
        owner: "planificar",
        writable: [],
        writeGlobs: config.tests_globs,
        locked: [],
        harness: config.harness_files,
        lockfiles: config.lockfiles,
        manifests: config.manifests,
        depsDeclared: false,
        testGlobs: config.tests_globs,
        comandos: SIN_COMANDOS,
      },
      fase: "planificar",
      write: true,
      bash: false,
      agents: true,
      graft: true,
      mcp: [VALIDAR_PLAN_TOOL],
    },
    emit,
  );
  return {
    prep,
    worktree,
    config,
    brain,
    feature,
    hook,
    esVerify: (comando) => isVerifyCommand(config, comando),
    spec: {
      fase: "planificar",
      cwd: worktree,
      model: config.models.planificar,
      tools: ["Read", "Grep", "Glob", "Write", "Edit", "Agent"],
      hook,
      schema: planSchema,
      agents: {
        explorador: {
          description:
            "Recorre el código del repo y devuelve un resumen con rutas y líneas. Usalo para preguntas que tocan muchos archivos. Solo lee.",
          prompt:
            "Explorá el repo para responder lo que te piden. Ubicá primero con graft (graft_find_code, graft_trace_calls, graft_find_all) y leé con Read solo los rangos de líneas que hagan falta. No escribas archivos. Respondé con un resumen corto: rutas, líneas y lo que hace cada lugar, sin pegar código largo.",
          tools: ["Read", "Grep", "Glob", ...GRAFT_TOOLS],
          model: config.models.explorar.model,
        },
      },
      timeoutMs: PLANIFICAR_TIMEOUT_MS,
    },
  };
}

/**
 * Los servidores MCP de un intento. `validar_plan` cuenta los tests desde `inicioSesion`, el HEAD al
 * abrir (o retomar) la sesión, como el gate: lo conservado de un replan ya está ahí y no lo escribió el
 * planificador. Un servidor en proceso se conecta a una sola sesión, así que es uno por intento.
 */
function servidores(
  ctx: PhaseContext,
  comun: Comun,
  inicioSesion: string,
  conserva: BaseConserva,
): Record<string, McpServerConfig> {
  const { worktree, config, feature, esVerify } = comun;
  return {
    graft: graftMcpServer(worktree, graftIndex(ctx.run), ctx.deps.env),
    gate: validarPlanServer({
      feature,
      worktree,
      base: comun.prep.base_sha,
      desde: inicioSesion,
      config,
      env: ctx.deps.env,
      esVerify,
      candidatas: conserva.candidatas.map((c) => c.id),
      conservaDe: (plan) => conservaDelPlan(plan, conserva),
    }),
  };
}

/** Con qué arman el `conserva` de un plan el gate y `validar_plan` en este intento: lo mismo para los dos. */
function baseConserva(
  ctx: PhaseContext,
  comun: Comun,
  intento: Pick<Intento, "previous" | "armada" | "rama" | "sinIndice">,
): BaseConserva {
  return {
    anteriores: intento.previous?.subtareas ?? [],
    candidatas: intento.armada.candidatas,
    pedidos: intento.rama.textos,
    worktree: comun.worktree,
    indexDir: graftIndex(ctx.run),
    sinIndice: intento.sinIndice,
    env: ctx.deps.env,
  };
}

/**
 * Para la regla (c), lo que dijo la persona o la detención: los pedidos y el motivo del `rerun`. No
 * el texto de un gate rechazado, que nombra sub-tasks porque las rechaza, no porque cambien: ni el de
 * un reintento ni el de una detención de planificar, que lo repite.
 */
function textosDeConserva(events: readonly RunEvent[], replan: Replan): string[] {
  const rehacer = events.findLastIndex((e) => e.tipo === "rehacer" && e.desde === "planificar");
  const rerun =
    rehacer >= 0 && stateOf(events.slice(0, rehacer)).fase === "planificar"
      ? undefined
      : replanOf(events, undefined).motivo;
  return [...replan.pedidos, ...(rerun === undefined ? [] : [rerun])];
}

/**
 * El informe del explorador previo, si lo hay. Solo el primer plan del run explora: si
 * `exploracion.md` ya existe, un replan, un pedido de cambios o un reintento lo reusan. Una exploración
 * que falla deja planificar sin informe, también en los planes que siguen; un `limite` se devuelve tal cual, y si lo que gastó detuvo el
 * run por su tope, la sesión del planificador no se abre: lo pasaría más.
 */
async function informePrevio(
  ctx: PhaseContext,
  comun: Comun,
  codigo: string,
): Promise<
  | { readonly tipo: "seguir"; readonly md: string | undefined }
  | { readonly tipo: "cortar"; readonly result: SessionResult<Plan> }
> {
  const file = join(ctx.run.dir, "exploracion.md");
  if (existsSync(file)) return { tipo: "seguir", md: readFileSync(file, "utf8") };
  // El primer plan ya intentó explorar y falló: los que siguen tampoco tienen informe.
  if (!comun.config.explorar_antes || existsSync(join(ctx.run.dir, EXPLORACION_FALLIDA)))
    return { tipo: "seguir", md: undefined };
  const { worktree, config, feature } = comun;
  const e = await explorar(ctx, { worktree, config, feature, codigo });
  if (e.tipo === "limite") return { tipo: "cortar", result: e };
  const estado = stateOf(readLog(ctx.run.dir).events);
  if (estado.status !== "en_curso")
    return {
      tipo: "cortar",
      result: {
        tipo: "falla",
        clase: "infra",
        motivo: `el run se detuvo durante la exploración previa${estado.halt === undefined ? "" : `: ${estado.halt.motivo}`}`,
      },
    };
  return { tipo: "seguir", md: e.tipo === "ok" ? e.md : undefined };
}

/** El camino de siempre: archiva, resetea, restaura y abre una sesión nueva persistida. */
async function intentoNuevo(ctx: PhaseContext, comun: Comun, sessionId: string): Promise<Intento> {
  const { run, deps, emit, action } = ctx;
  const { worktree, config, brain, feature } = comun;
  const base = comun.prep.base_sha;
  // Cada intento arranca de la base con los tests del plan anterior, si lo hay, tal como quedaron
  // bloqueados: los de un intento rechazado no se arrastran, y una nueva vuelta no reescribe lo que ya
  // estaba bien. En un replan, la base lleva además el código de las sub-tasks ya integradas, para que
  // el planificador lo vea y decida qué conserva (ADR 0024).
  const previous = archivePlan(run) ? readPlanAt(previousDir(run)) : undefined;
  // Del worktree, o de la punta vieja si un intento cortado en pleno rearmado ya no los dejó ahí.
  // Antes de `ramaAnterior`, que puede mover la ref a la rama de ahora.
  const restored: (readonly [string, string])[] = [];
  for (const [path, hash] of Object.entries(previous?.locked ?? {})) {
    const file = join(worktree, path);
    const here = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const content =
      here !== undefined && sha256(here) === hash
        ? here
        : await enAnterior(run, worktree, path, deps.env);
    if (content !== undefined && sha256(content) === hash) restored.push([path, content]);
  }
  const replan = replanOf(ctx.events, action.instruccion);
  const textos = textosDeConserva(ctx.events, replan);
  const rama =
    previous === undefined
      ? { subtasks: [], manuales: [], textos }
      : await ramaAnterior(run, worktree, ctx.events, base, textos, deps.env);
  const avisados = new Set<string>();
  // Con 0 candidatas es el `resetHard` de siempre.
  const armada = await reaplicar(
    worktree,
    base,
    rama,
    previous?.subtareas ?? [],
    deps.env,
    emit,
    avisados,
  );
  for (const [path, content] of restored) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
  const inicioSesion = await headSha(worktree, deps.env);
  // El índice tiene que describir la rama que ve la sesión: `codigoUbicado` y `llamadoresDe` lo leen
  // sin refrescar. Siempre se reconstruye: con código conservado no es el de la base; en un replan es
  // el que dejaron implementar o revisar; y en cualquier reintento, el MCP de la sesión anterior lo
  // refrescó con los tests que el reset acaba de descartar.
  let sinIndice: string | undefined;
  try {
    await buildIndex(worktree, graftIndex(run), deps.env);
  } catch (error) {
    sinIndice = `graft no pudo reconstruir el índice: ${(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? ""}`;
    emit({
      tipo: "aviso",
      fase: "planificar",
      texto: `${sinIndice}; el planificador arranca sin el contexto de graft y no se conserva nada que dependa de quién llama a qué`,
    });
  }
  const implementadas: Implementada[] = armada.candidatas.flatMap((c) => {
    const task = previous?.subtareas.find((t) => t.id === c.id);
    return task === undefined
      ? []
      : [{ id: c.id, titulo: task.titulo, alcance: task.alcance, commits: c.shas.length }];
  });
  const instruccion = replanText(previous, replan, implementadas);
  // Después de reaplicar, de restaurar los tests y de reconstruir el índice: describe la rama que ve la
  // sesión, conservadas incluidas. Solo en el intento nuevo: el retomado ya lo tiene en su conversación.
  const codigo = await codigoUbicado(feature, worktree, graftIndex(run), deps.env, sinIndice);
  const informe = await informePrevio(ctx, comun, codigo);
  const nombre = sessionName(run, "planificar");
  const result: SessionResult<Plan> =
    informe.tipo === "cortar"
      ? informe.result
      : await runSession(
          {
            ...comun.spec,
            mcpServers: servidores(
              ctx,
              comun,
              inicioSesion,
              baseConserva(ctx, comun, { previous, armada, rama, sinIndice }),
            ),
            nombre,
            sessionId,
            prompt: render("planificar", {
              feature: featureText(feature),
              tests_globs: config.tests_globs.join(", "),
              verify: config.verify,
              harness:
                config.harness_files.length === 0 ? "(ninguno)" : config.harness_files.join(", "),
              instruccion,
              codigo_ubicado: codigo,
              exploracion: informe.md ?? "(no hubo exploración previa)",
              ...brainVars(brain),
            }),
          },
          { run, deps, emit },
        );
  return {
    result,
    restored,
    limpiarNoDeclarados: false,
    previous,
    rama,
    armada,
    inicioSesion,
    sinIndice,
    avisados,
    sesion: { sessionId, nombre },
  };
}

/**
 * Retoma la sesión del intento rechazado con un solo mensaje. Sin reset: el worktree queda como lo
 * dejó el gate, que es el que vio la sesión. Las candidatas de un replan son las que guardó el intento
 * nuevo (`ramaAnterior` las reusa), y las que siguen en la rama.
 */
async function intentoRetomado(
  ctx: PhaseContext,
  comun: Comun,
  sesion: { sessionId: string; nombre: string },
  motivo: string,
): Promise<Intento> {
  const { run, deps, emit, action } = ctx;
  const { worktree } = comun;
  const base = comun.prep.base_sha;
  // El intento nuevo ya archivó el plan vigente, que no cambió: el gate no lo dejó pasar.
  const previous = existsSync(join(run.dir, "plan.md")) ? readPlanAt(previousDir(run)) : undefined;
  const textos = textosDeConserva(ctx.events, replanOf(ctx.events, action.instruccion));
  const rama =
    previous === undefined
      ? { subtasks: [], manuales: [], textos }
      : await ramaAnterior(run, worktree, ctx.events, base, textos, deps.env);
  // La rama es la que armó el intento nuevo: el gate la deja como estaba, y si la rearma no marca la
  // sesión. Lo que no entró entonces (chocó) tampoco está ahora.
  const enRama =
    previous === undefined ? undefined : await commitsDeLaRama(worktree, base, deps.env);
  const armada: Reaplicado = {
    candidatas: rama.subtasks.filter((c) => enRama?.subtasks.some((e) => e.id === c.id) === true),
    nuevos: Object.fromEntries((enRama?.subtasks ?? []).map((c) => [c.id, [...c.shas]])),
  };
  const inicioSesion = await headSha(worktree, deps.env);
  const result = await runSession(
    {
      ...comun.spec,
      mcpServers: servidores(
        ctx,
        comun,
        inicioSesion,
        baseConserva(ctx, comun, { previous, armada, rama, sinIndice: undefined }),
      ),
      nombre: sessionName(run, "planificar"),
      resume: sesion.sessionId,
      prompt: mensajeRetomado(motivo),
    },
    { run, deps, emit },
  );
  return {
    result,
    restored: [],
    limpiarNoDeclarados: true,
    previous,
    rama,
    armada,
    inicioSesion,
    // La sesión se marca solo si el intento que la abrió pudo reconstruir el índice.
    sinIndice: undefined,
    avisados: new Set<string>(),
    sesion: { sessionId: sesion.sessionId, nombre: sesion.nombre },
  };
}

/** Lo de siempre después de la sesión: descarta lo ajeno, corre el gate, commitea y escribe artefactos. */
async function gateYCierre(ctx: PhaseContext, comun: Comun, intento: Intento): Promise<Outcome> {
  const { run, deps, emit } = ctx;
  const { worktree, config, feature, esVerify } = comun;
  const base = comun.prep.base_sha;
  const { result, restored, previous, rama, armada, inicioSesion, sinIndice, avisados } = intento;
  if (result.tipo !== "ok")
    return result.tipo === "limite"
      ? result
      : { tipo: "falla", clase: result.clase, motivo: result.motivo };
  // «verify en verde» es del run, no de una sub-task (VF-6: AC-12 en ST-6, que no era dueña de lo que
  // se rompía). flowrunner lo corrige solo en vez de rechazar: es el plan que pasa el gate y se escribe.
  const plan = delRun(result.output, esVerify);
  for (const [path] of restored.filter(([path]) => !plan.tests.includes(path))) {
    rmSync(join(worktree, path), { force: true });
  }
  // Lo que en un intento nuevo hace el reset: un test que el intento rechazado escribió y el plan
  // corregido ya no declara no se bloquea. Contra donde arrancó la sesión: lo que commitearon las
  // conservadas no lo escribió el planificador.
  if (intento.limpiarNoDeclarados) {
    const sobran = (await changesSince(worktree, inicioSesion, deps.env)).filter(
      (c) =>
        c.status === "agregado" &&
        isTestFile(config.tests_globs, c.path) &&
        !plan.tests.includes(c.path),
    );
    if (sobran.length > 0) {
      await discardChanges(worktree, inicioSesion, sobran, deps.env);
      emit({
        tipo: "aviso",
        fase: "planificar",
        texto: `se descartaron tests que el plan no declara: ${sobran.map((c) => c.path).join(", ")}`,
      });
    }
  }
  for (const d of plan.decisiones)
    emit({ tipo: "decision", fase: "planificar", que: d.que, por_que: d.por_que });
  // El hook solo deja escribir tests, así que lo demás que cambió en el worktree lo escribió otro
  // proceso. En CUENTAS-1 una herramienta reescribió `.claude/helpers/*` mientras se planificaba, y
  // el commit de abajo (`add -A`) lo metió como test en rojo, bloqueado por hash, hasta la PR.
  // Contra donde arrancó la sesión, no contra la base: el código conservado no es ajeno.
  const foreign = (await changesSince(worktree, inicioSesion, deps.env)).filter(
    (c) => !isTestFile(config.tests_globs, c.path),
  );
  if (foreign.length > 0) {
    await discardChanges(worktree, inicioSesion, foreign, deps.env);
    emit({
      tipo: "aviso",
      fase: "planificar",
      texto: `se descartaron cambios que no escribió el planificador: ${foreign.map((c) => c.path).join(", ")}`,
    });
  }

  let kept: string[] = [];
  let rearmada = false;
  let invalid: string[] = [];
  let nuevos = armada.nuevos;
  let inicioTests = inicioSesion;
  // Sobre el worktree que vio la sesión, como `validar_plan`.
  const conserva = await conservaDelPlan(plan, baseConserva(ctx, comun, intento));
  if (conserva !== undefined) {
    // Antes del resto: decide qué queda en la rama. Sus problemas los suma `chequeosEstaticos`.
    invalid = checkConserva(conserva);
    if (invalid.length === 0) kept = conservadas(conserva);
  }
  // Lo que no se conserva se saca de la rama antes del resto del gate: sus criterios tienen que fallar
  // sin ello, y un llamador que estaba en su código ya no existe. Con un `conserva` inválido la rama no
  // se toca: el plan vuelve igual, y el próximo intento la ve entera.
  if (invalid.length === 0 && armada.candidatas.some((c) => !kept.includes(c.id))) {
    // La rama deja de ser la que vio la sesión: si el gate rechaza este plan, no se marca para retomar.
    rearmada = true;
    const final = await conLosTests(worktree, inicioSesion, config.tests_globs, deps.env, () =>
      reaplicar(
        worktree,
        base,
        { subtasks: armada.candidatas.filter((c) => kept.includes(c.id)), manuales: rama.manuales },
        // Lo que dependía de algo que choca, en el plan nuevo o en el viejo, tampoco queda.
        [...plan.subtareas, ...(previous?.subtareas ?? [])],
        deps.env,
        emit,
        avisados,
      ),
    );
    kept = kept.filter((id) => final.candidatas.some((c) => c.id === id));
    nuevos = final.nuevos;
    inicioTests = await headSha(worktree, deps.env);
  }
  // Los mismos chequeos que `validar_plan` en la sesión, acá sobre la rama ya rearmada: un llamador que
  // estaba en el código que no se conserva ya no existe. Desde donde empiezan los tests: lo conservado
  // no se bloquea como test.
  const problems = await chequeosEstaticos({
    plan,
    feature,
    worktree,
    base,
    desde: inicioTests,
    config,
    env: deps.env,
    esVerify,
    ...(conserva === undefined ? {} : { conserva }),
  });
  const written = (await changesSince(worktree, inicioTests, deps.env))
    .filter((c) => c.status !== "borrado")
    .map((c) => c.path);
  // Los tests quedan bloqueados byte a byte: el lint y el formateador del repo los arreglan antes del
  // gate y del hash. Lo que el lint no arregla solo rechaza el plan, y el planificador lo corrige.
  for (const f of await runFixers(worktree, config, written, deps.env)) {
    problems.push(`${f.falla} en los tests: ${f.detalle}`);
  }
  if (problems.length === 0) {
    // Lo conservado puede haber agregado paquetes: sus criterios corren con ellos instalados.
    if (kept.length > 0) {
      const reinstalar = await reinstalarSiCambiaron(worktree, config, base, deps.env);
      if (reinstalar !== undefined) return { tipo: "falla", clase: "entorno", motivo: reinstalar };
    }
    const env = copyEnvFiles(ctx.state.repo, worktree, config.env_files);
    if (!env.ok) return { tipo: "falla", clase: "entorno", motivo: env.motivo };
    try {
      // Con el turno del entorno, como verificar: un criterio que tiene que pasar no puede chocar con
      // los puertos o la base local de otro run del proyecto (ADR 0019).
      const gate = await conEntorno(ctx, async () => [
        // Lo conservado no vuelve a correr: sus criterios tienen que pasar ya con su código.
        ...(await checkCommandsPass(plan, worktree, deps.env, kept, esVerify)),
        // «verify en verde» pasa sobre la base, como debe: lo comprueba verificar, no este rojo. Un
        // criterio de lo conservado ya pasa: su código está. Uno compartido con lo nuevo tiene que fallar.
        ...(await checkCommandsFail(
          plan,
          worktree,
          deps.env,
          (comando) =>
            esVerify(comando) ||
            plan.criterios
              .filter((c) => c.comando === comando)
              .every((c) => kept.includes(c.subtarea)),
        )),
      ]);
      problems.push(...gate);
    } finally {
      env.remove();
    }
  }
  if (problems.length > 0) {
    const motivo = `el plan no pasó el gate:\n- ${problems.join("\n- ")}`;
    // Se retoma solo sobre el worktree que vio la sesión, y con el índice que miró su gate (ADR 0025).
    // Sin candidatas, el gate no consulta el índice: un índice que no se reconstruyó no cambia nada.
    if (!rearmada && (sinIndice === undefined || armada.candidatas.length === 0))
      writeFileSync(sesionFile(run), `${JSON.stringify({ ...intento.sesion, motivo })}\n`);
    return { tipo: "falla", clase: "gate", motivo };
  }
  const locked = Object.fromEntries(
    written.map((path) => [path, sha256(readFileSync(join(worktree, path), "utf8"))]),
  );
  await commitAll(
    worktree,
    `test: los criterios de ${feature.clave}, en rojo`,
    { "Flowrunner-Run": run.id },
    deps.env,
  );
  // Antes de los artefactos: si se corta entre los dos, el próximo intento no rearma con las
  // candidatas de un plan que ya no es el anterior.
  await soltarAnterior(run, worktree, deps.env);
  writePlanArtifacts(
    run,
    plan,
    locked,
    Object.fromEntries(kept.flatMap((id) => (nuevos[id] === undefined ? [] : [[id, nuevos[id]]]))),
  );
  return { tipo: "ok" };
}

export const planificar: PhaseFn = async (ctx) => {
  const comun = armarComun(ctx);
  const sesion = tomarSesion(ctx.run);
  const motivo = gateRechazado(ctx.events, ctx.action.instruccion);
  const usadas = sesion === undefined ? [] : [sesion.sessionId];
  try {
    if (sesion !== undefined && motivo !== undefined && sesion.motivo === motivo) {
      const retomado = await intentoRetomado(ctx, comun, sesion, motivo);
      if (retomado.result.tipo === "ok" || retomado.result.tipo === "limite")
        return await gateYCierre(ctx, comun, retomado);
      // Si lo que gastó la sesión retomada detuvo el run por su tope, otra sesión entera lo pasaría más.
      if (stateOf(readLog(ctx.run.dir).events).status !== "en_curso")
        return { tipo: "falla", clase: retomado.result.clase, motivo: retomado.result.motivo };
      ctx.emit({
        tipo: "aviso",
        fase: "planificar",
        texto: `no se pudo retomar la sesión del plan (${retomado.result.motivo}): planifica de cero`,
      });
    }
    const sessionId = randomUUID();
    usadas.push(sessionId);
    return await gateYCierre(ctx, comun, await intentoNuevo(ctx, comun, sessionId));
  } finally {
    await olvidarSesiones(ctx, comun.worktree, usadas);
  }
};
