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
import { isVerifyCommand, loadRepoConfig } from "../config/load.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { existedAt, testsInScope, testsTouched, undeclared } from "../gates/existente.ts";
import { checkConserva, conservadas, type ConservaInput } from "../gates/conserva.ts";
import { callersOutOfScope } from "../gates/llamadores.ts";
import {
  checkCommandsFail,
  checkCommandsPass,
  checkPlanShape,
  planSchema,
  type Plan,
} from "../gates/plan.ts";
import { changesSince, commitAll, discardChanges, headSha } from "../git/git.ts";
import { buildIndex, GRAFT_TOOLS, graftMcpServer } from "../graft/graft.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn, RunPaths } from "../runner/types.ts";
import { runSession } from "../agent/session.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { isTestFile } from "../tripwires/rules.ts";
import { copyEnvFiles } from "./env-files.ts";
import { runFixers } from "./fixers.ts";
import { graftIndex, prepared, runFeature } from "./inputs.ts";
import {
  conLosTests,
  enAnterior,
  llamadoresDelPlan,
  ramaAnterior,
  reaplicar,
  soltarAnterior,
} from "./conservar.ts";
import {
  archivePlan,
  previousDir,
  replanOf,
  replanText,
  type Implementada,
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

export const planificar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action } = ctx;
  const prep = prepared(ctx.events);
  const worktree = prep.worktree;
  const base = prep.base_sha;
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
  const textos = [...replan.pedidos, ...(replan.motivo === undefined ? [] : [replan.motivo])];
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
    },
    emit,
  );
  const implementadas: Implementada[] = armada.candidatas.flatMap((c) => {
    const task = previous?.subtareas.find((t) => t.id === c.id);
    return task === undefined
      ? []
      : [{ id: c.id, titulo: task.titulo, alcance: task.alcance, commits: c.shas.length }];
  });
  const instruccion = replanText(previous, replan, implementadas);
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

  const problems = checkPlanShape(plan, feature, worktree, config);
  let kept: string[] = [];
  let invalid: string[] = [];
  let nuevos = armada.nuevos;
  let inicioTests = inicioSesion;
  if (plan.subtareas.some((t) => t.conserva === true)) {
    const conserva: ConservaInput = {
      plan,
      anteriores: previous?.subtareas ?? [],
      candidatas: armada.candidatas,
      pedidos: rama.textos,
      ...(await llamadoresDelPlan(plan, worktree, graftIndex(run), sinIndice, deps.env)),
    };
    invalid = checkConserva(conserva);
    problems.push(...invalid);
    if (invalid.length === 0) kept = conservadas(conserva);
  }
  // Lo que no se conserva se saca de la rama antes del resto del gate: sus criterios tienen que fallar
  // sin ello, y un llamador que estaba en su código ya no existe. Con un `conserva` inválido la rama no
  // se toca: el plan vuelve igual, y el próximo intento la ve entera.
  if (invalid.length === 0 && armada.candidatas.some((c) => !kept.includes(c.id))) {
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
  problems.push(...(await callersOutOfScope(plan, worktree, deps.env)));
  // Desde donde empiezan los tests: lo conservado no se bloquea como test.
  const changes = await changesSince(worktree, inicioTests, deps.env);
  const written = changes.filter((c) => c.status !== "borrado").map((c) => c.path);
  if (written.length === 0) problems.push("planificar no escribió ningún test");
  // Lo que se detecta y no se declara no pasa: así lo que ve la persona al aprobar no depende de que
  // el planificador lo cuente.
  const touched = [
    ...testsTouched(changes, config.tests_globs),
    // Los que existían en la base: uno que escribió una sub-task conservada no es «existente».
    ...(await existedAt(
      worktree,
      base,
      testsInScope(plan.subtareas, worktree, config.tests_globs),
      deps.env,
    )),
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
  if (problems.length === 0) {
    const env = copyEnvFiles(ctx.state.repo, worktree, config.env_files);
    if (!env.ok) return { tipo: "falla", clase: "entorno", motivo: env.motivo };
    try {
      // Lo conservado no vuelve a correr: sus criterios tienen que pasar ya con su código.
      problems.push(
        ...(await checkCommandsPass(plan, worktree, deps.env, kept, (comando) =>
          isVerifyCommand(config, comando),
        )),
      );
      problems.push(
        // «verify en verde» pasa sobre la base, como debe: lo comprueba verificar, no este rojo. Un
        // criterio de lo conservado ya pasa: su código está. Uno compartido con lo nuevo tiene que fallar.
        ...(await checkCommandsFail(
          plan,
          worktree,
          deps.env,
          (comando) =>
            isVerifyCommand(config, comando) ||
            plan.criterios
              .filter((c) => c.comando === comando)
              .every((c) => kept.includes(c.subtarea)),
        )),
      );
    } finally {
      env.remove();
    }
  }
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
};
