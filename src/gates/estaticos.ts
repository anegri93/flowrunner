// La parte del gate de planificar que no corre nada: ni los comandos de los criterios ni los fixers.
// Una sola función para el gate de afuera y para `validar_plan`, la herramienta con la que el
// planificador chequea su plan antes de devolverlo: si fueran dos copias, la herramienta diría «ok»
// sobre un plan que el gate rechaza.
import type { RepoConfig } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import { changesSince } from "../git/git.ts";
import { checkConserva, type ConservaInput } from "./conserva.ts";
import { existedAt, testsInScope, testsTouched, undeclared } from "./existente.ts";
import { callersOutOfScope } from "./llamadores.ts";
import { checkPlanShape, type Plan } from "./plan.ts";

export interface EstaticosInput {
  /** El plan ya normalizado con `delRun`, el mismo que se escribe si pasa. */
  readonly plan: Plan;
  readonly feature: Feature;
  readonly worktree: string;
  /** La base del run: un test que no estaba ahí no es «existente», aunque lo haya escrito una conservada. */
  readonly base: string;
  /** Desde dónde se cuentan los tests escritos: lo de antes no lo escribió el planificador. */
  readonly desde: string;
  readonly config: RepoConfig;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Si el comando de un criterio es el verify del repo (`isVerifyCommand`). Obligatorio: el default de
   * `checkPlanShape` rechaza todo criterio del run, y la herramienta y el gate dirían cosas distintas.
   */
  readonly esVerify: (comando: string) => boolean;
  /** En un replan con `conserva: true` (ADR 0024): sus problemas van al final. */
  readonly conserva?: ConservaInput;
  /**
   * `false` deja afuera lo que mira la rama: los llamadores y los tests. Para `validar_plan` cuando la
   * rama que ve la sesión no es la que va a chequear el gate, que antes saca lo que no se conserva.
   */
  readonly rama?: boolean;
}

/** Los problemas del plan que se ven sin correr nada, en el orden del gate. */
export async function chequeosEstaticos(input: EstaticosInput): Promise<string[]> {
  const { plan, feature, worktree, config, esVerify } = input;
  const problems = checkPlanShape(plan, feature, worktree, config, esVerify);
  if (input.rama !== false) problems.push(...(await chequeosDeRama(input)));
  if (input.conserva !== undefined) problems.push(...checkConserva(input.conserva));
  return problems;
}

/** Lo que depende del código de la rama: quién llama a lo que cambia y qué tests se escribieron. */
async function chequeosDeRama(input: EstaticosInput): Promise<string[]> {
  const { plan, worktree, base, desde, config, env } = input;
  const problems = await callersOutOfScope(plan, worktree, env);
  const changes = await changesSince(worktree, desde, env);
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
      env,
    )),
  ];
  for (const path of undeclared(touched, plan.cambia_lo_existente)) {
    problems.push(
      `el plan cambia ${path}, un test que ya existe, y no lo declara en cambia_lo_existente. Declaralo con qué cambia, dónde y qué criterio lo obliga, o dejalo como está`,
    );
  }
  for (const declared of plan.tests.filter((t) => !written.includes(t))) {
    problems.push(`el plan declara el test ${declared}, pero no está escrito`);
  }
  return problems;
}
