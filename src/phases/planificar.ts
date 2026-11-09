// Planificar: una sesión de Opus que lee el código con graft y un explorador, escribe los tests de
// aceptación dentro de los globs de tests, y devuelve el plan. El gate decide si sirve.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, type Brain } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { checkCommandsFail, checkPlanShape, planSchema, type Plan } from "../gates/plan.ts";
import { changesSince, commitAll, resetHard } from "../git/git.ts";
import { GRAFT_TOOLS, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn, RunPaths } from "../runner/types.ts";
import { runSession } from "../agent/session.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { graftIndex, prepared, runFeature } from "./inputs.ts";

export const PLANIFICAR_BUDGET_USD = 8;
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
): void {
  writeFileSync(join(run.dir, "plan.md"), plan.plan);
  writeFileSync(join(run.dir, "tasks.json"), `${JSON.stringify(plan.subtareas, null, 2)}\n`);
  writeFileSync(join(run.dir, "ac-map.json"), `${JSON.stringify(plan.criterios, null, 2)}\n`);
  writeFileSync(join(run.dir, "locked.json"), `${JSON.stringify(locked, null, 2)}\n`);
}

export function readPlan(
  run: RunPaths,
): Pick<Plan, "subtareas" | "criterios"> & { plan: string; locked: Record<string, string> } {
  const read = (name: string) => readFileSync(join(run.dir, name), "utf8");
  return {
    plan: read("plan.md"),
    subtareas: JSON.parse(read("tasks.json")) as Plan["subtareas"],
    criterios: JSON.parse(read("ac-map.json")) as Plan["criterios"],
    locked: JSON.parse(read("locked.json")) as Record<string, string>,
  };
}

export const planificar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action } = ctx;
  const prep = prepared(ctx.events);
  const worktree = prep.worktree;
  // Cada intento arranca de la base: los tests de un intento rechazado no se arrastran.
  await resetHard(worktree, prep.base_sha, deps.env);
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
        bash: [],
      },
      fase: "planificar",
      write: true,
      bash: false,
      agents: true,
      graft: true,
    },
    emit,
  );
  const instruccion =
    action.instruccion === undefined
      ? ""
      : `# Atención: este es un nuevo intento\n\n${action.instruccion}\n\nCorregilo en este plan.`;
  const result = await runSession(
    {
      fase: "planificar",
      nombre: sessionName(run, "planificar"),
      prompt: render("planificar", {
        feature: featureText(feature),
        tests_globs: config.tests_globs.join(", "),
        harness: config.harness_files.length === 0 ? "(ninguno)" : config.harness_files.join(", "),
        instruccion,
        ...brainVars(brain),
      }),
      cwd: worktree,
      model: config.models.planificar,
      tools: ["Read", "Grep", "Glob", "Write", "Edit", "Agent"],
      hook,
      schema: planSchema,
      mcpServers: { graft: graftMcpServer(worktree, graftIndex(run), deps.env) },
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
      maxBudgetUsd: PLANIFICAR_BUDGET_USD,
      timeoutMs: PLANIFICAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok")
    return result.tipo === "limite"
      ? result
      : { tipo: "falla", clase: result.clase, motivo: result.motivo };
  const plan = result.output;
  for (const d of plan.decisiones)
    emit({ tipo: "decision", fase: "planificar", que: d.que, por_que: d.por_que });

  const problems = checkPlanShape(plan, feature, worktree, config);
  const written = (await changesSince(worktree, prep.base_sha, deps.env))
    .filter((c) => c.status !== "borrado")
    .map((c) => c.path);
  if (written.length === 0) problems.push("planificar no escribió ningún test");
  for (const declared of plan.tests.filter((t) => !written.includes(t))) {
    problems.push(`el plan declara el test ${declared}, pero no está escrito`);
  }
  if (problems.length === 0) problems.push(...(await checkCommandsFail(plan, worktree, deps.env)));
  if (problems.length > 0) {
    return {
      tipo: "falla",
      clase: "gate",
      motivo: `el plan no pasó el gate:\n- ${problems.join("\n- ")}`,
    };
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
  writePlanArtifacts(run, plan, locked);
  return { tipo: "ok" };
};
