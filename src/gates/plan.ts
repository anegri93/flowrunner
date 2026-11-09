// El plan que devuelve planificar y su gate. El modelo propone; este código decide si sirve.
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { Feature } from "../feature/feature.ts";
import { isUnrunnable, runShell, tail } from "../proc/proc.ts";
import { insideRoot, type Scope } from "../tripwires/rules.ts";

/** Un nombre de paquete, con scope y versión opcionales: `jsqr`, `@types/qrcode`, `jsqr@1.4.0`. */
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9A-Za-z.^~*+-]+)?$/;
const packageName = z
  .string()
  .regex(
    PACKAGE,
    "tiene que ser solo un nombre de paquete, con versión opcional: `jsqr` o `jsqr@1.4.0`. Una dependencia de desarrollo va en `dependencias_dev`, sin aclaraciones",
  );

export const subtaskSchema = z.object({
  id: z.string().regex(/^ST-\d+$/, "tiene que ser ST-n"),
  titulo: z.string().min(1),
  descripcion: z.string().min(1),
  /** Rutas concretas, archivos o carpetas, relativas al repo. Nunca globs. */
  alcance: z.array(z.string().min(1)).min(1),
  /** Paquetes que usa en ejecución y puede agregar; vacío si no agrega ninguno. */
  dependencias: z.array(packageName),
  /** Paquetes de desarrollo y de tests que puede agregar. */
  dependencias_dev: z.array(packageName).optional(),
  depende_de: z.array(z.string()),
});
export type Subtask = z.infer<typeof subtaskSchema>;

/** Todas las dependencias que puede agregar una sub-task, de ejecución y de desarrollo. */
export const allDependencies = (task: Subtask) => [
  ...task.dependencias,
  ...(task.dependencias_dev ?? []),
];

export const decisionSchema = z.object({ que: z.string().min(1), por_que: z.string().min(1) });

/**
 * Un comportamiento que hoy existe y el plan cambia. No es una decisión técnica: es de la persona, y
 * `approve` no sigue sin que lo acepte. En CUENTAS-1 el planificador anotó como decisión que
 * reescribía el test que protegía una regla vigente, y el plan se aprobó sin que nadie lo viera.
 */
export const cambioExistenteSchema = z.object({
  que: z.string().min(1).describe("qué hace hoy el código y cómo queda después del plan"),
  donde: z
    .string()
    .min(1)
    .describe("archivo:línea del código o del test que hoy fija ese comportamiento"),
  criterio: z.string().min(1).describe("el criterio de la feature que obliga a cambiarlo, AC-n"),
  simbolo: z
    .string()
    .optional()
    .describe(
      "si cambia la firma o el contrato de una función o un método: su nombre, como `Clase.metodo` o `funcion`. flowrunner busca a todos sus llamadores",
    ),
});
export type CambioExistente = z.infer<typeof cambioExistenteSchema>;

export const planSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe("plan.md: enfoque, qué se reusa, casos límite, qué queda afectado"),
  subtareas: z.array(subtaskSchema).min(1),
  criterios: z.array(
    z.object({
      id: z.string().regex(/^AC-\d+$/),
      comando: z.string().min(1).describe("el comando que corre el test de este criterio"),
      subtarea: z.string(),
    }),
  ),
  /** Los archivos de test que escribió, relativos al repo. */
  tests: z.array(z.string().min(1)).min(1),
  decisiones: z.array(decisionSchema),
  cambia_lo_existente: z
    .array(cambioExistenteSchema)
    .describe(
      "cada comportamiento que hoy existe y el plan cambia, incluido todo test existente que se modifica o se borra; vacío si no cambia nada",
    ),
});
export type Plan = z.infer<typeof planSchema>;

export interface PlanRepoRules {
  readonly lockfiles: readonly string[];
  readonly manifests: readonly string[];
}

const normalize = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** El alcance efectivo: lo que declaró, más lockfiles y manifiestos si agrega dependencias. */
export function effectiveScope(task: Subtask, rules: PlanRepoRules): string[] {
  const own = task.alcance.map(normalize);
  return allDependencies(task).length > 0 ? [...own, ...rules.lockfiles, ...rules.manifests] : own;
}

/** Las sub-tasks de las que depende `id`, directa o indirectamente. */
function ancestors(tasks: readonly Subtask[], id: string, seen = new Set<string>()): Set<string> {
  for (const dep of tasks.find((t) => t.id === id)?.depende_de ?? []) {
    if (!seen.has(dep)) {
      seen.add(dep);
      ancestors(tasks, dep, seen);
    }
  }
  return seen;
}

function findCycle(tasks: readonly Subtask[]): string[] | undefined {
  const state = new Map<string, "visitando" | "hecho">();
  const visit = (id: string, path: string[]): string[] | undefined => {
    if (state.get(id) === "visitando") return [...path.slice(path.indexOf(id)), id];
    if (state.get(id) === "hecho") return undefined;
    state.set(id, "visitando");
    for (const dep of tasks.find((t) => t.id === id)?.depende_de ?? []) {
      const cycle = visit(dep, [...path, id]);
      if (cycle !== undefined) return cycle;
    }
    state.set(id, "hecho");
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id, []);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** La parte del gate que no corre nada: forma, referencias, rutas, alcances y ciclos. */
export function checkPlanShape(
  plan: Plan,
  feature: Feature,
  root: string,
  rules: PlanRepoRules,
): string[] {
  const problems: string[] = [];
  const ids = plan.subtareas.map((t) => t.id);
  const idSet = new Set(ids);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i))
    problems.push(`${id} está repetida`);
  for (const ac of feature.criterios) {
    const entry = plan.criterios.find((c) => c.id === ac.id);
    if (entry === undefined) problems.push(`${ac.id} no tiene comando ni sub-task`);
    else if (!idSet.has(entry.subtarea))
      problems.push(`${ac.id} apunta a ${entry.subtarea}, que no existe`);
  }
  for (const extra of plan.criterios.filter((c) => !feature.criterios.some((a) => a.id === c.id))) {
    problems.push(`${extra.id} no es un criterio de la feature`);
  }
  for (const task of plan.subtareas) {
    for (const dep of task.depende_de) {
      if (!idSet.has(dep)) problems.push(`${task.id} depende de ${dep}, que no existe`);
    }
  }
  const cycle = findCycle(plan.subtareas);
  if (cycle !== undefined) problems.push(`hay un ciclo de dependencias: ${cycle.join(" → ")}`);
  const scope = { root: realpathSync(root) } as Scope;
  for (const task of plan.subtareas) {
    for (const path of task.alcance) {
      if (/[*?[\]{}]/.test(path))
        problems.push(`${task.id}: "${path}" es un glob; el alcance son rutas concretas`);
      else if (insideRoot(scope, path) === undefined)
        problems.push(`${task.id}: "${path}" queda fuera del repo`);
    }
  }
  if (cycle === undefined) {
    for (const [i, a] of plan.subtareas.entries()) {
      for (const b of plan.subtareas.slice(i + 1)) {
        if (ancestors(plan.subtareas, a.id).has(b.id) || ancestors(plan.subtareas, b.id).has(a.id))
          continue;
        const scopeA = effectiveScope(a, rules);
        const scopeB = effectiveScope(b, rules);
        const clash = scopeA.flatMap((pa) =>
          scopeB.filter((pb) => overlaps(pa, pb)).map((pb) => [pa, pb]),
        );
        if (clash.length > 0) {
          const [pa, pb] = clash[0] ?? ["", ""];
          problems.push(
            `${a.id} y ${b.id} pueden correr a la vez y sus alcances se pisan (${pa} y ${pb}): hacé que una dependa de la otra o separá los archivos`,
          );
        }
      }
    }
  }
  for (const wide of plan.subtareas) {
    const covered = plan.subtareas.filter(
      (other) =>
        other.id !== wide.id &&
        other.alcance.every((p) => wide.alcance.some((w) => overlaps(normalize(w), normalize(p)))),
    );
    // En CUENTAS-1, «ST-5 Cierre: verify completo en verde» tenía la unión de casi todos los alcances.
    if (covered.length >= 2)
      problems.push(
        `${wide.id} abarca el alcance de ${covered.map((t) => t.id).join(", ")}: una sub-task de cierre o de «verify en verde» no va, porque el verify de conjunto lo corre verificar sobre la rama integrada. Lo que haga falta cambiar va en la sub-task dueña de cada archivo`,
      );
  }
  return problems;
}

export const ACCEPTANCE_TIMEOUT_MS = 10 * 60_000;

/** La parte del gate que corre los comandos: cada uno tiene que fallar, y fallar de verdad. */
export async function checkCommandsFail(
  plan: Plan,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const problems: string[] = [];
  for (const criterion of plan.criterios) {
    const result = await runShell(criterion.comando, {
      cwd: worktree,
      env,
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    });
    if (isUnrunnable(result)) {
      problems.push(
        `${criterion.id} no se puede ejecutar (exit ${result.code}): \`${criterion.comando}\` no es un rojo válido:\n${tail(result, 8)}`,
      );
    } else if (result.code === 0) {
      problems.push(
        `${criterion.id} ya pasa antes de implementar: \`${criterion.comando}\` tiene que fallar`,
      );
    }
  }
  return problems;
}
