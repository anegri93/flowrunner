// Verificar: sobre la feature integrada, los tests bloqueados intactos, cada criterio en verde y
// verify en verde. Un criterio rojo vuelve a implementar con la sub-task que lo cubre. Si la feature
// cambió lockfiles o manifiestos, primero reinstala: el setup de preparar corrió con los de la base.
// Ante una señal de entorno reinstala y repite; si el ciclo no converge, diagnostica antes de devolver.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../config/load.ts";
import { ACCEPTANCE_TIMEOUT_MS } from "../gates/plan.ts";
import { runShell, tail } from "../proc/proc.ts";
import type { PhaseFn } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { git } from "../git/git.ts";
import { diagnose, environmentHint, type Failing } from "./diagnosticar.ts";
import { featureWorktree, prepared } from "./inputs.ts";
import { SETUP_TIMEOUT_MS } from "./preparar.ts";
import { readPlan } from "./planificar.ts";
import { runVerify } from "./verify.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Las sub-tasks que, devueltas en la última entrada a implementar, no encontraron nada que cambiar. */
function unitsLeftUnchanged(events: readonly RunEvent[]): string[] {
  const start = events.findLastIndex(
    (e) => e.tipo === "accion_iniciada" && e.fase === "implementar",
  );
  return events
    .slice(start + 1)
    .flatMap((e) => (e.tipo === "unidad" && e.estado === "sin_cambios" ? [e.unidad] : []));
}

export const verificar: PhaseFn = async (ctx) => {
  const { run, deps } = ctx;
  const worktree = featureWorktree(run);
  const config = loadRepoConfig(worktree);
  const plan = readPlan(run);

  const depFiles = new Set([...config.lockfiles, ...config.manifests]);
  const changed = (
    await git(worktree, ["diff", "--name-only", prepared(ctx.events).base_sha, "HEAD"], deps.env)
  )
    .split("\n")
    .filter((f) => depFiles.has(f));
  if (changed.length > 0) {
    const setup = await runShell(config.setup, {
      cwd: worktree,
      env: deps.env,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    if (setup.code !== 0) {
      return {
        tipo: "falla",
        clase: "entorno",
        motivo: `la feature cambió ${changed.join(", ")} y el setup \`${config.setup}\` salió ${String(setup.code)} al reinstalar:\n${tail(setup)}`,
      };
    }
  }

  for (const [path, hash] of Object.entries(plan.locked)) {
    const file = join(worktree, path);
    const now = existsSync(file) ? sha256(readFileSync(file, "utf8")) : "(borrado)";
    if (now !== hash) {
      return {
        tipo: "falla",
        clase: "invariante",
        motivo: `el test bloqueado ${path} cambió desde que lo escribió planificar: lo tiene que mirar una persona`,
      };
    }
  }

  const runCriteria = async (criteria: readonly (typeof plan.criterios)[number][]) => {
    const failing: (Failing & { hint: string | undefined })[] = [];
    for (const criterion of criteria) {
      const result = await runShell(criterion.comando, {
        cwd: worktree,
        env: deps.env,
        timeoutMs: ACCEPTANCE_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        failing.push({
          id: criterion.id,
          comando: criterion.comando,
          subtarea: criterion.subtarea,
          detalle: `${criterion.id} sigue en rojo: \`${criterion.comando}\` salió ${result.code}:\n${tail(result, 20)}`,
          hint: environmentHint(`${result.stdout}\n${result.stderr}`),
        });
      }
    }
    return failing;
  };

  let failing = await runCriteria(plan.criterios);
  // Una señal de entorno no la arregla una sub-task: se reinstala y se repite una vez.
  if (failing.some((f) => f.hint !== undefined)) {
    const setup = await runShell(config.setup, {
      cwd: worktree,
      env: deps.env,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    if (setup.code === 0) {
      const again = new Set(failing.map((f) => f.id));
      failing = await runCriteria(plan.criterios.filter((c) => again.has(c.id)));
    }
    const stuck = failing.find((f) => f.hint !== undefined);
    if (stuck !== undefined) {
      return {
        tipo: "falla",
        clase: "entorno",
        motivo: `${stuck.id} falla por el entorno, no por el código, aun después de reinstalar: ${stuck.hint ?? ""}`,
      };
    }
  }
  if (failing.length > 0) {
    const returned = unitsLeftUnchanged(ctx.events);
    const previous = ctx.events.findLast(
      (e) =>
        e.tipo === "accion_terminada" && e.fase === "verificar" && e.resultado.tipo === "vuelve",
    );
    const repeated =
      previous?.tipo === "accion_terminada" &&
      previous.resultado.tipo === "vuelve" &&
      failing.every(
        (f) =>
          previous.resultado.tipo === "vuelve" &&
          previous.resultado.motivo.includes(`${f.id} sigue en rojo`),
      );
    const stalled = failing.some((f) => returned.includes(f.subtarea)) || repeated;
    if (stalled) {
      const diagnosed = await diagnose(ctx, {
        worktree,
        config,
        plan,
        failing,
        historia: [
          ...(returned.length > 0
            ? [`Devueltas sin nada que cambiar: ${returned.join(", ")}.`]
            : []),
          ...(previous?.tipo === "accion_terminada" && previous.resultado.tipo === "vuelve"
            ? [`La vuelta anterior de verificar dijo:\n\n${previous.resultado.motivo}`]
            : []),
        ].join("\n\n"),
      });
      if (diagnosed !== undefined) return diagnosed;
    }
    return {
      tipo: "vuelve",
      unidades: [...new Set(failing.map((f) => f.subtarea))],
      motivo: failing.map((f) => f.detalle).join("\n\n"),
    };
  }

  const verify = await runVerify(worktree, config, deps.env);
  if (!verify.ok) {
    if (verify.unrunnable) return { tipo: "falla", clase: "entorno", motivo: verify.detail };
    // ponytail: un verify rojo con todos los criterios verdes vuelve con todas las sub-tasks; no se
    // adivina cuál lo rompió. Salida: atribuirlo por los archivos que nombra la salida.
    return {
      tipo: "vuelve",
      unidades: plan.subtareas.map((t) => t.id),
      motivo: `los criterios pasan pero verify está en rojo: ${verify.detail}`,
    };
  }
  return { tipo: "ok" };
};
