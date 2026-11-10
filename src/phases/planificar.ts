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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HookCallback, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadBrain, type Brain } from "../brain/brain.ts";
import { stateOf } from "../engine/engine.ts";
import { isVerifyCommand, loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { checkConserva, conservadas, type ConservaInput } from "../gates/conserva.ts";
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
import { buildIndex, GRAFT_TOOLS, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import { readLog } from "../store/run-log.ts";
import type { Outcome, RunEvent } from "../store/events.ts";
import type { Feature } from "../feature/feature.ts";
import type { PhaseContext, PhaseFn, RunPaths } from "../runner/types.ts";
import { runSession, type SessionResult, type SessionSpec } from "../agent/session.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { isTestFile } from "../tripwires/rules.ts";
import { copyEnvFiles } from "./env-files.ts";
import { runFixers } from "./fixers.ts";
import { reinstalarSiCambiaron } from "./reinstalar.ts";
import { conEntorno } from "./turno-entorno.ts";
import { graftIndex, prepared, runFeature, type Prepared } from "./inputs.ts";
import {
  commitsDeLaRama,
  conLosTests,
  enAnterior,
  llamadoresDelPlan,
  ramaAnterior,
  reaplicar,
  soltarAnterior,
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
}

export const readPlan = (run: RunPaths) => readPlanAt(run.dir);

export function readPlanAt(dir: string): Pick<
  Plan,
  "subtareas" | "criterios" | "cambia_lo_existente"
> & {
  plan: string;
  locked: Record<string, string>;
  conservadas: Record<string, string[]>;
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
    }),
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
  // El planificador y `llamadoresDe` tienen que ver la API del código conservado, no la de la base.
  let sinIndice: string | undefined;
  if (inicioSesion !== base) {
    try {
      await buildIndex(worktree, graftIndex(run), deps.env);
    } catch (error) {
      sinIndice = `graft no pudo reconstruir el índice: ${(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? ""}`;
      emit({
        tipo: "aviso",
        fase: "planificar",
        texto: `${sinIndice}; no se conserva nada que dependa de quién llama a qué`,
      });
    }
  }
  const implementadas: Implementada[] = armada.candidatas.flatMap((c) => {
    const task = previous?.subtareas.find((t) => t.id === c.id);
    return task === undefined
      ? []
      : [{ id: c.id, titulo: task.titulo, alcance: task.alcance, commits: c.shas.length }];
  });
  const instruccion = replanText(previous, replan, implementadas);
  const nombre = sessionName(run, "planificar");
  const result = await runSession(
    {
      ...comun.spec,
      mcpServers: servidores(ctx, comun, inicioSesion),
      nombre,
      sessionId,
      prompt: render("planificar", {
        feature: featureText(feature),
        tests_globs: config.tests_globs.join(", "),
        verify: config.verify,
        harness: config.harness_files.length === 0 ? "(ninguno)" : config.harness_files.join(", "),
        instruccion,
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
      mcpServers: servidores(ctx, comun, inicioSesion),
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
  let conserva: ConservaInput | undefined;
  if (plan.subtareas.some((t) => t.conserva === true)) {
    conserva = {
      plan,
      anteriores: previous?.subtareas ?? [],
      candidatas: armada.candidatas,
      pedidos: rama.textos,
      ...(await llamadoresDelPlan(plan, worktree, graftIndex(run), sinIndice, deps.env)),
    };
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
    if (!rearmada && sinIndice === undefined)
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
