// Planificar: una sesión de Opus que lee el código con graft y un explorador, escribe los tests de
// aceptación dentro de los globs de tests, y devuelve el plan. El gate decide si sirve.
import { createHash } from "node:crypto";
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
import { loadBrain, type Brain } from "../brain/brain.ts";
import { loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { testsInScope, testsTouched, undeclared } from "../gates/existente.ts";
import { callersOutOfScope } from "../gates/llamadores.ts";
import { checkCommandsFail, checkPlanShape, planSchema, type Plan } from "../gates/plan.ts";
import { changesSince, commitAll, discardChanges, resetHard } from "../git/git.ts";
import { GRAFT_TOOLS, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn, RunPaths } from "../runner/types.ts";
import { runSession } from "../agent/session.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { isTestFile } from "../tripwires/rules.ts";
import { runFixers } from "./fixers.ts";
import { graftIndex, prepared, runFeature } from "./inputs.ts";
import { archivePlan, previousDir, replanOf, replanText } from "./plan-anterior.ts";

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
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(join(run.dir, "plan.md"), plan.plan);
  writeFileSync(join(run.dir, "tasks.json"), json(plan.subtareas));
  writeFileSync(join(run.dir, "ac-map.json"), json(plan.criterios));
  writeFileSync(join(run.dir, "locked.json"), json(locked));
  writeFileSync(join(run.dir, "cambios-existentes.json"), json(plan.cambia_lo_existente));
}

export const readPlan = (run: RunPaths) => readPlanAt(run.dir);

export function readPlanAt(dir: string): Pick<
  Plan,
  "subtareas" | "criterios" | "cambia_lo_existente"
> & {
  plan: string;
  locked: Record<string, string>;
} {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const cambios = join(dir, "cambios-existentes.json");
  return {
    plan: read("plan.md"),
    subtareas: JSON.parse(read("tasks.json")) as Plan["subtareas"],
    criterios: JSON.parse(read("ac-map.json")) as Plan["criterios"],
    locked: JSON.parse(read("locked.json")) as Record<string, string>,
    // Un run planificado antes de que existiera el archivo no declaró nada: se lee como vacío.
    cambia_lo_existente: existsSync(cambios)
      ? (JSON.parse(readFileSync(cambios, "utf8")) as Plan["cambia_lo_existente"])
      : [],
  };
}

export const planificar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action } = ctx;
  const prep = prepared(ctx.events);
  const worktree = prep.worktree;
  // Cada intento arranca de la base con los tests del plan anterior, si lo hay, tal como quedaron
  // bloqueados: los de un intento rechazado no se arrastran, y una nueva vuelta no reescribe lo que ya
  // estaba bien.
  const previous = archivePlan(run) ? readPlanAt(previousDir(run)) : undefined;
  const restored = Object.entries(previous?.locked ?? {}).flatMap(([path, hash]) => {
    const file = join(worktree, path);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf8");
    return sha256(content) === hash ? [[path, content] as const] : [];
  });
  await resetHard(worktree, prep.base_sha, deps.env);
  for (const [path, content] of restored) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
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
  const instruccion = replanText(previous, replanOf(ctx.events, action.instruccion));
  const result = await runSession(
    {
      fase: "planificar",
      nombre: sessionName(run, "planificar"),
      prompt: render("planificar", {
        feature: featureText(feature),
        tests_globs: config.tests_globs.join(", "),
        verify: config.verify,
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
      timeoutMs: PLANIFICAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok")
    return result.tipo === "limite"
      ? result
      : { tipo: "falla", clase: result.clase, motivo: result.motivo };
  const plan = result.output;
  for (const [path] of restored.filter(([path]) => !plan.tests.includes(path))) {
    rmSync(join(worktree, path), { force: true });
  }
  for (const d of plan.decisiones)
    emit({ tipo: "decision", fase: "planificar", que: d.que, por_que: d.por_que });
  // El hook solo deja escribir tests, así que lo demás que cambió en el worktree lo escribió otro
  // proceso. En CUENTAS-1 una herramienta reescribió `.claude/helpers/*` mientras se planificaba, y
  // el commit de abajo (`add -A`) lo metió como test en rojo, bloqueado por hash, hasta la PR.
  const foreign = (await changesSince(worktree, prep.base_sha, deps.env)).filter(
    (c) => !isTestFile(config.tests_globs, c.path),
  );
  if (foreign.length > 0) {
    await discardChanges(worktree, prep.base_sha, foreign, deps.env);
    emit({
      tipo: "aviso",
      fase: "planificar",
      texto: `se descartaron cambios que no escribió el planificador: ${foreign.map((c) => c.path).join(", ")}`,
    });
  }

  const problems = [
    ...checkPlanShape(plan, feature, worktree, config),
    ...(await callersOutOfScope(plan, worktree, deps.env)),
  ];
  const changes = await changesSince(worktree, prep.base_sha, deps.env);
  const written = changes.filter((c) => c.status !== "borrado").map((c) => c.path);
  if (written.length === 0) problems.push("planificar no escribió ningún test");
  // Lo que se detecta y no se declara no pasa: así lo que ve la persona al aprobar no depende de que
  // el planificador lo cuente.
  const touched = [
    ...testsTouched(changes, config.tests_globs),
    ...testsInScope(plan.subtareas, worktree, config.tests_globs),
  ];
  for (const path of undeclared(touched, plan.cambia_lo_existente)) {
    problems.push(
      `el plan cambia ${path}, un test que ya existe, y no lo declara en cambia_lo_existente. Declaralo con qué cambia, dónde y qué criterio lo obliga, o dejalo como está`,
    );
  }
  // Los tests quedan bloqueados byte a byte: el lint y el formateador del repo los arreglan antes del
  // gate y del hash. Lo que el lint no arregla solo rechaza el plan, y el planificador lo corrige.
  for (const f of await runFixers(worktree, config, written, deps.env)) {
    problems.push(`${f.falla} en los tests: ${f.detalle}`);
  }
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
