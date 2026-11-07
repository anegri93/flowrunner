// Implementar: las sub-tasks en paralelo, cada una en su worktree y su sesión, con los tripwires.
// flowrunner hace un commit por sub-task y lo integra por cherry-pick sobre la rama de la feature.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runSession } from "../agent/session.ts";
import { loadBrain } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { blockedByFailure, readyToStart } from "../engine/scheduler.ts";
import { allDependencies, type Subtask } from "../gates/plan.ts";
import {
  addWorktree,
  changesSince,
  cherryPick,
  commitAll,
  headSha,
  removeWorktree,
} from "../git/git.ts";
import { runShell, tail } from "../proc/proc.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn } from "../runner/types.ts";
import type { Outcome, RunEvent } from "../store/events.ts";
import { checkChanges } from "../tripwires/diff.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import type { Scope } from "../tripwires/rules.ts";
import { featureWorktree, runFeature, unitWorktree } from "./inputs.ts";
import { brainVars, readPlan, sessionName } from "./planificar.ts";
import { SETUP_TIMEOUT_MS } from "./preparar.ts";

export const MAX_UNIT_ATTEMPTS = 3;
export const UNIT_BUDGET_USD = 4;
export const UNIT_TIMEOUT_MS = 60 * 60_000;

type UnitEvent = Extract<RunEvent, { tipo: "unidad" }>;

/** Los eventos de esta entrada a implementar: los que siguen a su última `accion_iniciada`. */
export function currentEntry(events: readonly RunEvent[]): RunEvent[] {
  const start = events.findLastIndex(
    (e) => e.tipo === "accion_iniciada" && e.fase === "implementar",
  );
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

export function unitCommands(
  config: RepoConfig,
  task: Subtask,
  acCommands: readonly string[],
  exact: boolean,
): string[] {
  const verify = config.verify.replace(/^\.\//, "");
  return [
    ...acCommands,
    verify,
    `./${verify}`,
    "git status",
    "git diff",
    "git log --oneline -10",
    ...installCommands(config, task, exact),
  ];
}

export function unitScope(
  root: string,
  config: RepoConfig,
  task: Subtask,
  locked: readonly string[],
  bash: string[],
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
    bash,
  };
}

type UnitResult =
  { readonly ok: true } | { readonly ok: false; readonly fatal?: Outcome; readonly motivo: string };

export const implementar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action, state } = ctx;
  const featureWt = featureWorktree(run);
  const config = loadRepoConfig(featureWt);
  const brain = loadBrain(featureWt);
  const feature = runFeature(run);
  const plan = readPlan(run);
  const locked = Object.keys(plan.locked);
  const manifest = join(featureWt, "package.json");
  const exact = existsSync(manifest) && prefersExact(readFileSync(manifest, "utf8"));
  const entry = currentEntry(ctx.events).filter((e): e is UnitEvent => e.tipo === "unidad");
  const lastOf = (id: string) => entry.findLast((e) => e.unidad === id);
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
    const bash = unitCommands(
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
    let motivo = action.unidades?.includes(task.id) === true ? action.instruccion : undefined;
    const tried = entry.filter((e) => e.unidad === task.id && e.estado === "iniciada").length;
    let stalled = false;
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
      const scope = unitScope(wt, config, task, locked, bash);
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
                : acs.map((c) => `${c.id}: \`${c.comando}\``).join(", "),
            dependencias: dependencyText(task),
            bloqueados: locked.join(", "),
            comandos: bash.map((c) => `\`${c}\``).join(", "),
            instruccion:
              motivo === undefined
                ? ""
                : `# Atención: esto ya se intentó\n\n${motivo}\n\nCorregilo.`,
            feature: featureText(feature),
            plan: plan.plan,
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
            emit,
          ),
          maxBudgetUsd: UNIT_BUDGET_USD,
          timeoutMs: UNIT_TIMEOUT_MS,
        },
        { run, deps, emit },
      );
      if (result.tipo === "limite") return { ok: false, motivo: "límite", fatal: result };
      if (result.tipo === "falla") {
        if (result.clase === "entorno")
          return {
            ok: false,
            motivo: result.motivo,
            fatal: { tipo: "falla", clase: "entorno", motivo: result.motivo },
          };
        motivo = result.motivo;
        continue;
      }
      const changes = await changesSince(wt, start, deps.env);
      const violations = checkChanges(scope, changes);
      if (changes.length === 0) {
        // Devuelta y sin nada que cambiar: su código ya está integrado y la sub-task lo sostiene.
        // Reintentarla no arregla nada; verificar decide de qué lado está el problema.
        if (action.unidades?.includes(task.id) === true) {
          emit({ tipo: "unidad", fase: "implementar", unidad: task.id, estado: "sin_cambios" });
          await removeWorktree(state.repo, wt, deps.env);
          return { ok: true };
        }
        const said = result.texto.trim();
        const why = `no cambió ningún archivo${said === "" ? "" : `. Lo último que dijo: ${said.slice(0, 400)}`}`;
        // Dos intentos seguidos sin avanzar: un tercero no va a ser distinto.
        if (stalled) {
          const stop = `${task.id} no avanzó en dos intentos seguidos: ${why}`;
          emit({
            tipo: "unidad",
            fase: "implementar",
            unidad: task.id,
            estado: "fallida",
            motivo: stop,
          });
          return { ok: false, motivo: stop };
        }
        stalled = true;
        motivo = `${task.id} ${why}`;
        continue;
      }
      stalled = false;
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
    const fatal = [...failed.values()].find((r) => !r.ok && r.fatal !== undefined);
    if (fatal !== undefined && !fatal.ok && fatal.fatal !== undefined) {
      await Promise.all(running.values());
      return fatal.fatal;
    }
  }
  const blocked = blockedByFailure({
    todo,
    integrated,
    running: new Set(),
    failed: new Set(failed.keys()),
  });
  if (failed.size > 0) {
    const reasons = [...failed.entries()].map(([id, r]) => `${id}: ${r.ok ? "" : r.motivo}`);
    const tail_ = blocked.length > 0 ? `\nQuedaron sin arrancar: ${blocked.join(", ")}` : "";
    return { tipo: "falla", clase: "gate", motivo: `${reasons.join("\n")}${tail_}` };
  }
  // ponytail: los worktrees de sub-tasks fallidas quedan para mirarlos; `abort` los borra todos.
  return { tipo: "ok" };
};
