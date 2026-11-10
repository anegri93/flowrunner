// Implementar: las sub-tasks en paralelo, cada una en su worktree y su sesión, con los tripwires.
// flowrunner hace un commit por sub-task y lo integra por cherry-pick sobre la rama de la feature.
// Una sub-task sin cambios no reintenta: la fase termina en una pregunta (ADR 0023).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runSession } from "../agent/session.ts";
import { loadBrain } from "../brain/brain.ts";
import { isVerifyCommand, loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { esEsperaDeRed, initialState, reduce } from "../engine/engine.ts";
import { blockedByFailure, readyToStart } from "../engine/scheduler.ts";
import { AVISO_TEST_EXISTENTE, existedAt, testsTouched, undeclared } from "../gates/existente.ts";
import { allDependencies, type Plan, type Subtask } from "../gates/plan.ts";
import {
  addWorktree,
  changesSince,
  cherryPick,
  commitAll,
  git,
  headSha,
  removeWorktree,
  type FileChange,
} from "../git/git.ts";
import { contextoGraft, marcarFueraDeAlcance } from "../graft/contexto.ts";
import { buildIndex } from "../graft/graft.ts";
import { runShell, tail } from "../proc/proc.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn, RunPaths } from "../runner/types.ts";
import type { Outcome, RunEvent } from "../store/events.ts";
import { readLog } from "../store/run-log.ts";
import { describeComandos, type Comandos } from "../tripwires/comandos.ts";
import { checkChanges, type Violation } from "../tripwires/diff.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { dependencySectionsChanged, WRITE_TOOLS, type Scope } from "../tripwires/rules.ts";
import { copyEnvFiles } from "./env-files.ts";
import { featureWorktree, graftIndex, prepared, runFeature, unitWorktree } from "./inputs.ts";
import { brainVars, readPlan, sessionName } from "./planificar.ts";
import { runFixers } from "./fixers.ts";
import { SETUP_TIMEOUT_MS } from "./preparar.ts";

export const MAX_UNIT_ATTEMPTS = 3;
export const UNIT_TIMEOUT_MS = 60 * 60_000;

type UnitEvent = Extract<RunEvent, { tipo: "unidad" }>;

/**
 * Los intentos que gastó una sub-task en esta entrada: los que reintentó en la misma acción, y el que
 * dejó abierto un proceso que murió. Uno que terminó con la acción sin cerrarse (un corte de red, un
 * límite, el entorno, o el `fatal` de otra sub-task) no se gastó en ella.
 */
export function spentAttempts(entry: readonly RunEvent[], unidad: string): number {
  let spent = 0;
  let open = false;
  for (const e of entry) {
    if (e.tipo === "accion_terminada" && e.fase === "implementar") open = false;
    else if (e.tipo === "unidad" && e.unidad === unidad) {
      if (e.estado === "iniciada") {
        if (open) spent++;
        open = true;
      } else if (e.estado !== "commiteada") open = false;
    }
  }
  return open ? spent + 1 : spent;
}

/**
 * Los eventos de esta entrada a implementar: los que siguen a la `accion_iniciada` que la abrió. Un
 * reintento del engine por infraestructura sigue la misma entrada, como en el engine, que no la
 * reinicia; y también retomar una detención a la que se llegó con esos reintentos. Así lo integrado
 * antes de un corte no se rehace, y los intentos se siguen contando (ADR 0023).
 */
export function currentEntry(events: readonly RunEvent[]): RunEvent[] {
  let state = initialState();
  let start = -1;
  /** Un `reanudado` de una detención con reintentos de infraestructura: sigue la misma entrada. */
  let resumed = false;
  events.forEach((e, i) => {
    if (e.tipo === "accion_iniciada" && e.fase === "implementar") {
      // Un run creado antes de `reintentos_red` abre una entrada en cada acción, como antes.
      const sigue = state.reintentosRed !== undefined && (state.infra > 0 || resumed);
      if (!sigue) start = i;
      resumed = false;
    } else if (e.tipo === "reanudado") {
      resumed ||=
        state.fase === "implementar" &&
        state.infra > 0 &&
        (state.status === "detenido" || state.status === "pausado_por_limite");
    } else if (e.tipo !== "encolado") {
      resumed = false;
    }
    state = reduce(state, e);
  });
  return events.slice(start + 1);
}

/** Una versión fija, como `1.2.3` o `4.0.0-rc.1`. */
const EXACT = /^\d+\.\d+\.\d+([-+][\w.]+)?$/;
/** Una versión de registro: un número o un rango. `workspace:`, `file:` o una URL no cuentan. */
const REGISTRY = /^[\d^~<>=*]/;

/** El repo fija versiones si todas las de registro de su manifiesto son exactas. */
export function prefersExact(manifest: string): boolean {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(manifest) as typeof pkg;
  } catch {
    return false;
  }
  const versions = [
    ...Object.values(pkg.dependencies ?? {}),
    ...Object.values(pkg.devDependencies ?? {}),
  ].filter((v) => REGISTRY.test(v));
  return versions.length > 0 && versions.every((v) => EXACT.test(v));
}

/** Las dependencias de una sub-task como texto para su prompt. */
function dependencyText(task: Subtask): string {
  const dev = task.dependencias_dev ?? [];
  if (task.dependencias.length === 0 && dev.length === 0) return "(ninguna)";
  return [
    ...(task.dependencias.length > 0 ? [task.dependencias.join(", ")] : []),
    ...(dev.length > 0 ? [`de desarrollo: ${dev.join(", ")}`] : []),
  ].join("; ");
}

/** Los comandos de instalar las dependencias de la sub-task, según el lockfile y el estilo del repo. */
export function installCommands(config: RepoConfig, task: Subtask, exact: boolean): string[] {
  const lock = config.lockfiles.join(" ");
  const tool = lock.includes("pnpm-lock")
    ? "pnpm add"
    : lock.includes("yarn.lock")
      ? "yarn add"
      : "npm install";
  const pin = exact ? " -E" : "";
  const dev = task.dependencias_dev ?? [];
  return [
    ...(task.dependencias.length > 0 ? [`${tool}${pin} ${task.dependencias.join(" ")}`] : []),
    ...(dev.length > 0 ? [`${tool} -D${pin} ${dev.join(" ")}`] : []),
  ];
}

export function unitComandos(
  config: RepoConfig,
  task: Subtask,
  acCommands: readonly string[],
  exact: boolean,
): Comandos {
  // Sin el verify del repo: corre en verificar, sobre la rama con todas las sub-tasks integradas. En el
  // worktree de una, antes de que las demás se integren, daba rojos que no eran suyos y costaba minutos.
  // Tampoco entra como comando de un criterio de «verify en verde»: ese criterio lo corre verificar.
  // Rutas citadas: `[id]` y `(grupo)` de Next son patrón y sintaxis para el shell, y la política de
  // comandos pide citarlas para pasarlas por el lint o el formato.
  // El lint y el formato van sobre su alcance; el typecheck, del repo entero, porque los tipos no se
  // ven por archivo. Sin poder correrlos, en VF-6 una sub-task formateó a mano y rompió el typecheck.
  // Mirar (git status, ls, cat…) no está acá: lo permite la política como lectura.
  return {
    ampliables: [
      ...new Set([
        ...acCommands.filter((c) => !isVerifyCommand(config, c)),
        ...(config.typecheck === undefined ? [] : [config.typecheck]),
      ]),
    ],
    exactos: installCommands(config, task, exact),
    fixers: [config.lint_fix, config.format].filter((c): c is string => c !== undefined),
  };
}

export function unitScope(
  root: string,
  config: RepoConfig,
  task: Subtask,
  locked: readonly string[],
  comandos: Comandos,
): Scope {
  return {
    root: realpathSync(root),
    owner: task.id,
    writable: task.alcance,
    writeGlobs: [],
    locked,
    harness: config.harness_files,
    lockfiles: config.lockfiles,
    manifests: config.manifests,
    depsDeclared: allDependencies(task).length > 0,
    testGlobs: config.tests_globs,
    comandos,
    unreadable: config.env_files,
  };
}

/**
 * Un package.json tocado por una sub-task sin dependencias declaradas: puede cambiar scripts, pero no
 * sus dependencias. El hook deja editarlo entero; esto mira el resultado.
 */
async function dependencyEdits(
  wt: string,
  start: string,
  changes: readonly FileChange[],
  env: NodeJS.ProcessEnv,
): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const change of changes) {
    if (!(change.path === "package.json" || change.path.endsWith("/package.json"))) continue;
    if (change.status !== "modificado") continue;
    const before = await git(wt, ["show", `${start}:${change.path}`], env);
    const changed = dependencySectionsChanged(before, readFileSync(join(wt, change.path), "utf8"));
    if (changed.length > 0)
      out.push({
        path: change.path,
        motivo: `${change.path} cambia ${changed.join(", ")} sin dependencias declaradas: solo se pueden cambiar otras partes, como los scripts`,
      });
  }
  return out;
}

/** El mensaje de un error hasta el primer salto de línea. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/** Puro: «- ST-1 · <título> · <sha corto> · alcance: a, b», o «Ninguna todavía.». */
export function integradasText(
  events: readonly RunEvent[],
  plan: Pick<Plan, "subtareas">,
  self: string,
): string {
  // Lo integrado antes de la última aprobación es de otro plan: un replan lo descarta.
  const desde = events.findLastIndex((e) => e.tipo === "aprobado") + 1;
  const integradas = events
    .slice(desde)
    .filter((e): e is UnitEvent => e.tipo === "unidad" && e.estado === "integrada");
  const lineas = plan.subtareas.flatMap((t) => {
    if (t.id === self) return [];
    const ultima = integradas.findLast((e) => e.unidad === t.id);
    if (ultima === undefined) return [];
    const sha = ultima.sha === undefined ? "sin sha" : ultima.sha.slice(0, 7);
    return [`- ${t.id} · ${t.titulo} · ${sha} · alcance: ${t.alcance.join(", ")}`];
  });
  return lineas.length === 0 ? "Ninguna todavía." : lineas.join("\n");
}

/** Lo que la sub-task tiene que saber antes de empezar: lo ya integrado y su alcance según graft. */
export async function orientacionDe(
  run: RunPaths,
  plan: Pick<Plan, "subtareas">,
  task: Subtask,
  featureWt: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // Del log de ahora, no de `ctx.events`: una sub-task paralela pudo integrarse después de que
  // empezó la fase.
  const integradas = integradasText(readLog(run.dir).events, plan, task.id);
  const api = marcarFueraDeAlcance(
    await contextoGraft({
      repo: featureWt,
      indexDir: graftIndex(run),
      archivos: task.alcance,
      env,
    }),
    task.alcance,
  );
  return [
    "## Sub-tasks ya integradas en tu rama",
    "",
    integradas,
    "",
    "## Tu alcance hoy, según graft",
    "",
    api,
  ].join("\n");
}

type UnitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly fatal?: Outcome;
      readonly motivo: string;
      /** Se detiene sin reintentar: lo que falta lo decide la persona. */
      readonly pregunta?: true;
    };

export const implementar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action, state } = ctx;
  const featureWt = featureWorktree(run);
  // La rama tiene los tests del plan y lo ya integrado, que el índice de preparar no tiene. Sin índice
  // no se detiene nada: cada sub-task recibe el texto de falla de `contextoGraft` y sigue como antes.
  try {
    await buildIndex(featureWt, graftIndex(run), deps.env);
  } catch (error) {
    emit({
      tipo: "aviso",
      fase: "implementar",
      texto: `graft no pudo reconstruir el índice: ${firstLine(error)}; las sub-tasks arrancan sin su contexto`,
    });
  }
  const config = loadRepoConfig(featureWt);
  const brain = loadBrain(featureWt);
  const feature = runFeature(run);
  const plan = readPlan(run);
  const locked = Object.keys(plan.locked);
  const manifest = join(featureWt, "package.json");
  const exact = existsSync(manifest) && prefersExact(readFileSync(manifest, "utf8"));
  const entryEvents = currentEntry(ctx.events);
  const entry = entryEvents.filter((e): e is UnitEvent => e.tipo === "unidad");
  const lastOf = (id: string) => entry.findLast((e) => e.unidad === id);
  // Las integradas de este plan: lo de antes de la última aprobación lo descarta un replan.
  const integradas = new Set(
    ctx.events
      .slice(ctx.events.findLastIndex((e) => e.tipo === "aprobado") + 1)
      .flatMap((e) => (e.tipo === "unidad" && e.estado === "integrada" ? [e.unidad] : [])),
  );
  const todo = plan.subtareas.filter(
    (t) => action.unidades === undefined || action.unidades.includes(t.id),
  );

  let integrationQueue: Promise<unknown> = Promise.resolve();
  /** Las integraciones van de a una: cada cherry-pick ve la punta que dejó el anterior. */
  const integrate = (sha: string) => {
    const result = integrationQueue.then(() => cherryPick(featureWt, sha, deps.env));
    integrationQueue = result.catch(() => undefined);
    return result;
  };

  const runUnit = async (task: Subtask): Promise<UnitResult> => {
    const wt = unitWorktree(run, task.id);
    const branch = `feat/${feature.clave}/${task.id}`;
    const acs = plan.criterios.filter((c) => c.subtarea === task.id);
    const comandos = unitComandos(
      config,
      task,
      acs.map((c) => c.comando),
      exact,
    );
    const previous = lastOf(task.id);
    // Retomado con el commit hecho y sin integrar: se integra ese commit, sin otra sesión.
    if (previous?.estado === "commiteada" && previous.sha !== undefined) {
      const picked = await integrate(previous.sha);
      if (picked.ok) {
        emit({
          tipo: "unidad",
          fase: "implementar",
          unidad: task.id,
          estado: "integrada",
          sha: picked.sha,
        });
        await removeWorktree(state.repo, wt, deps.env);
        return { ok: true };
      }
    }
    // Retomado después de que ya falló en esta entrada: lo que falta lo decide la persona, no otra sesión.
    // Un corte de red no: la sub-task no falló, se cortó la conexión.
    if (previous?.estado === "fallida" && previous.corte_de_red !== true)
      return { ok: false, motivo: previous.motivo ?? `${task.id} no pudo terminar` };
    let motivo = action.unidades?.includes(task.id) === true ? action.instruccion : undefined;
    // Los intentos que cortó la red, o un límite, no cuentan: la sub-task no tuvo la oportunidad.
    const tried = spentAttempts(entryEvents, task.id);
    for (let attempt = tried + 1; attempt <= MAX_UNIT_ATTEMPTS; attempt++) {
      const start = await headSha(featureWt, deps.env);
      await addWorktree(state.repo, wt, branch, start, deps.env);
      const setup = await runShell(config.setup, {
        cwd: wt,
        env: deps.env,
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (setup.code !== 0) {
        const why = `el setup falló en el worktree de ${task.id}: ${tail(setup)}`;
        return { ok: false, motivo: why, fatal: { tipo: "falla", clase: "entorno", motivo: why } };
      }
      emit({
        tipo: "unidad",
        fase: "implementar",
        unidad: task.id,
        estado: "iniciada",
        sha: start,
      });
      // Antes de copiar los .env: armarla tarda hasta 60 s, y si tira no hay `finally` que los borre.
      const orientacion = await orientacionDe(run, plan, task, featureWt, deps.env);
      // Sus criterios los corre el agente: los .env están mientras dura la sesión, sin poder leerse, y
      // se borran antes de mirar qué cambió, así no entran en el commit.
      const env = copyEnvFiles(state.repo, wt, config.env_files);
      if (!env.ok) {
        return {
          ok: false,
          motivo: env.motivo,
          fatal: { tipo: "falla", clase: "entorno", motivo: env.motivo },
        };
      }
      const scope = unitScope(wt, config, task, locked, comandos);
      // Lo que el bloqueo no le dejó escribir en esta sesión. Una sub-task devuelta que termina sin
      // cambios por eso no está «sin cambios» (VF-6: ST-6, cuatro veces, sobre CLAUDE.md).
      const rejectedWrites: string[] = [];
      const sessionEmit: typeof emit = (event) => {
        if (event.tipo === "rechazo" && WRITE_TOOLS.has(event.herramienta))
          rejectedWrites.push(event.motivo);
        return emit(event);
      };
      const result = await runSession(
        {
          fase: "implementar",
          unidad: task.id,
          nombre: sessionName(run, `implementar-${task.id}`),
          prompt: render("implementar", {
            id: task.id,
            titulo: task.titulo,
            descripcion: task.descripcion,
            alcance: task.alcance.join(", "),
            criterios:
              acs.length === 0
                ? "(ninguno directo)"
                : acs
                    .map((c) =>
                      isVerifyCommand(config, c.comando)
                        ? `${c.id}: lo corre verificar sobre la rama integrada, no lo corras vos`
                        : `${c.id}: \`${c.comando}\``,
                    )
                    .join(", "),
            dependencias: dependencyText(task),
            bloqueados: locked.join(", "),
            comandos: describeComandos(comandos),
            instruccion:
              motivo === undefined
                ? ""
                : `# Atención: esto ya se intentó\n\n${motivo}\n\nCorregilo.`,
            feature: featureText(feature),
            plan: plan.plan,
            orientacion,
            ...brainVars(brain),
          }),
          cwd: wt,
          model: config.models.implementar,
          tools: ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "Bash"],
          hook: tripwireHook(
            {
              scope,
              fase: "implementar",
              unidad: task.id,
              write: true,
              bash: true,
              agents: false,
              graft: false,
            },
            sessionEmit,
          ),
          timeoutMs: UNIT_TIMEOUT_MS,
        },
        { run, deps, emit },
      ).finally(env.remove);
      if (result.tipo === "limite") return { ok: false, motivo: "límite", fatal: result };
      if (result.tipo === "falla") {
        if (result.clase === "entorno")
          return {
            ok: false,
            motivo: result.motivo,
            fatal: { tipo: "falla", clase: "entorno", motivo: result.motivo },
          };
        // Un corte de red sube al engine, que espera y reintenta la fase: reintentar enseguida acá
        // gastaba los intentos en segundos. Un run viejo, sin `reintentos_red`, sigue como antes.
        if (result.clase === "infra" && esEsperaDeRed(state, result.motivo)) {
          emit({
            tipo: "unidad",
            fase: "implementar",
            unidad: task.id,
            estado: "fallida",
            motivo: result.motivo,
            corte_de_red: true,
          });
          return {
            ok: false,
            motivo: result.motivo,
            fatal: { tipo: "falla", clase: "infra", motivo: result.motivo },
          };
        }
        motivo = result.motivo;
        continue;
      }
      const changes = await changesSince(wt, start, deps.env);
      const violations = checkChanges(scope, changes);
      if (changes.length === 0) {
        // Devuelta y sin nada que cambiar: su código ya está integrado y la sub-task lo sostiene.
        // Reintentarla no arregla nada; verificar decide de qué lado está el problema.
        // Con escrituras rechazadas no: no es que no hubiera nada que hacer, es que no la dejaron.
        // Y solo si se integró alguna vez: un `fix` desde una pregunta de implementar también la
        // nombra, y sin código integrado «sin cambios» sería una sub-task sin hacer que pasa como hecha.
        if (
          action.unidades?.includes(task.id) === true &&
          integradas.has(task.id) &&
          rejectedWrites.length === 0
        ) {
          emit({ tipo: "unidad", fase: "implementar", unidad: task.id, estado: "sin_cambios" });
          await removeWorktree(state.repo, wt, deps.env);
          return { ok: true };
        }
        const said = result.texto.trim();
        const blocked =
          rejectedWrites.length === 0
            ? ""
            : `. El bloqueo rechazó lo que intentó escribir: ${[...new Set(rejectedWrites)].join("; ")}`;
        // Sin reintento: en PIZ-2, VF-1 y VF-6 ninguna sesión sin cambios repetida salió bien. Lo que
        // falta lo dice la persona con `fix --unidad`, que es la misma sesión con su instrucción.
        const stop = `${task.id} no cambió ningún archivo${blocked}${said === "" ? "" : `. Lo último que dijo: ${said.slice(0, 400)}`}`;
        emit({
          tipo: "unidad",
          fase: "implementar",
          unidad: task.id,
          estado: "fallida",
          motivo: stop,
        });
        // El worktree queda, como el de toda sub-task fallida, para mirarlo; `abort` lo borra.
        return { ok: false, motivo: stop, pregunta: true };
      }
      if (!scope.depsDeclared)
        violations.push(...(await dependencyEdits(wt, start, changes, deps.env)));
      if (violations.length > 0) {
        motivo = `el diff de ${task.id} rompe las reglas:\n${violations.map((v) => `- ${v.motivo}`).join("\n")}`;
        for (const v of violations)
          emit({
            tipo: "rechazo",
            fase: "implementar",
            unidad: task.id,
            herramienta: "diff",
            motivo: v.motivo,
          });
        continue;
      }
      // No se frena: una sub-task puede tener que actualizar un test existente por un cambio legítimo.
      // Pero si el plan aprobado no lo declaraba, la persona tiene que verlo en la PR.
      const existing = await existedAt(
        wt,
        prepared(ctx.events).base_sha,
        testsTouched(changes, config.tests_globs),
        deps.env,
      );
      for (const path of undeclared(existing, plan.cambia_lo_existente))
        emit({
          tipo: "aviso",
          fase: "implementar",
          texto: `${AVISO_TEST_EXISTENTE}${task.id} cambió ${path}, que ya existía y el plan aprobado no declaraba`,
        });
      // El lint y el formateador del repo sobre lo que cambió, antes del commit: un formato a mano
      // no llega rojo a verify (VF-6: 12 rechazos de prettier y una coma que rompió el typecheck).
      const fixable = changes.filter((c) => c.status !== "borrado").map((c) => c.path);
      for (const f of await runFixers(wt, config, fixable, deps.env))
        emit({
          tipo: "aviso",
          fase: "implementar",
          texto: `${task.id}: ${f.falla}; verify lo va a mostrar. ${f.detalle}`,
        });
      const sha = await commitAll(
        wt,
        `feat: ${task.titulo} · ${task.id}`,
        { "Flowrunner-Subtask": task.id, "Flowrunner-Run": run.id },
        deps.env,
      );
      if (sha === undefined) {
        motivo = `${task.id} no dejó nada para commitear`;
        continue;
      }
      emit({ tipo: "unidad", fase: "implementar", unidad: task.id, estado: "commiteada", sha });
      const picked = await integrate(sha);
      if (!picked.ok) {
        motivo = `el commit de ${task.id} chocó al integrarse con la rama de la feature en: ${picked.conflicts.join(", ")}. Rehacelo sobre la rama actualizada.`;
        continue;
      }
      emit({
        tipo: "unidad",
        fase: "implementar",
        unidad: task.id,
        estado: "integrada",
        sha: picked.sha,
      });
      await removeWorktree(state.repo, wt, deps.env);
      return { ok: true };
    }
    const why = `${task.id} no salió en ${MAX_UNIT_ATTEMPTS} intentos. Último motivo: ${motivo ?? "sin motivo"}`;
    emit({ tipo: "unidad", fase: "implementar", unidad: task.id, estado: "fallida", motivo: why });
    return { ok: false, motivo: why };
  };

  const integrated = new Set(
    todo.filter((t) => lastOf(t.id)?.estado === "integrada").map((t) => t.id),
  );
  // Lo que un replan conservó ya está en la rama: se da por integrado al entrar después de aprobar,
  // con el evento de siempre, así watch, Orca y una vuelta posterior lo ven como cualquier integrada.
  // Con `unidades` (un `fix` o una vuelta) no: si nombra una conservada, corre sobre su código.
  if (action.unidades === undefined) {
    for (const t of todo) {
      const shas = plan.conservadas[t.id];
      if (shas === undefined || integrated.has(t.id)) continue;
      emit({
        tipo: "unidad",
        fase: "implementar",
        unidad: t.id,
        estado: "integrada",
        ...(shas.at(-1) === undefined ? {} : { sha: shas.at(-1) }),
        motivo: "conservada del plan anterior",
      });
      integrated.add(t.id);
    }
  }
  const failed = new Map<string, UnitResult>();
  const running = new Map<string, Promise<void>>();
  for (;;) {
    const units = {
      todo,
      integrated,
      running: new Set(running.keys()),
      failed: new Set(failed.keys()),
    };
    for (const id of readyToStart(units, config.max_parallel)) {
      const task = todo.find((t) => t.id === id);
      if (task === undefined) continue;
      running.set(
        id,
        runUnit(task).then((r) => {
          running.delete(id);
          if (r.ok) integrated.add(id);
          else failed.set(id, r);
        }),
      );
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
    if ([...failed.values()].some((r) => !r.ok && r.fatal !== undefined)) {
      await Promise.all(running.values());
      const fatals = [...failed.values()].flatMap((r) =>
        !r.ok && r.fatal !== undefined ? [r.fatal] : [],
      );
      // Una detención le gana a un corte de red: reintentarla no la arregla, y así no se pierden su
      // motivo (una credencial pide `doctor`) ni la hora del límite.
      const stop = fatals.find((f) => !(f.tipo === "falla" && f.clase === "infra"));
      const fatal = stop ?? fatals[0];
      if (fatal !== undefined) return fatal;
    }
  }
  const blocked = blockedByFailure({
    todo,
    integrated,
    running: new Set(),
    failed: new Set(failed.keys()),
  });
  // Reintentar la fase no arregla una sub-task fallida: pregunta por ella y por las que esperan por ella.
  if (failed.size > 0) {
    const ids = todo.map((t) => t.id).filter((id) => failed.has(id));
    const reasons = ids.map((id) => {
      const r = failed.get(id);
      return `- ${r !== undefined && !r.ok ? r.motivo : id}`;
    });
    const tail_ =
      blocked.length > 0
        ? `\nQuedaron sin arrancar, porque dependen de esas: ${blocked.join(", ")}`
        : "";
    return {
      tipo: "pregunta",
      motivo: `${ids.length === 1 ? "una sub-task no pudo terminar" : `${String(ids.length)} sub-tasks no pudieron terminar`}:\n${reasons.join("\n")}${tail_}`,
      unidades: [...ids, ...blocked],
    };
  }
  // ponytail: los worktrees de sub-tasks fallidas quedan para mirarlos; `abort` los borra todos.
  return { tipo: "ok" };
};
