// Verificar: sobre la feature integrada, los tests bloqueados intactos, cada criterio en verde y
// verify en verde. Un criterio rojo vuelve a implementar con la sub-task que lo cubre. Si la feature
// cambió lockfiles o manifiestos, primero reinstala: el setup de preparar corrió con los de la base.
// Ante una señal de entorno reinstala y repite; si el ciclo no converge, diagnostica antes de devolver.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isVerifyCommand, loadRepoConfig } from "../config/load.ts";
import { acceptanceRunner } from "../gates/plan.ts";
import { runShell, tail } from "../proc/proc.ts";
import type { PhaseFn } from "../runner/types.ts";
import type { RunEvent } from "../store/events.ts";
import { git } from "../git/git.ts";
import { diagnose, environmentHint, type Failing } from "./diagnosticar.ts";
import { copyEnvFiles, withEnvFiles } from "./env-files.ts";
import { runFixers } from "./fixers.ts";
import { repairTest } from "./reparar.ts";
import { featureWorktree, prepared } from "./inputs.ts";
import { SETUP_TIMEOUT_MS } from "./preparar.ts";
import { readPlan } from "./planificar.ts";
import { conEntorno } from "./turno-entorno.ts";
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
  const { run, deps, emit } = ctx;
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

  // Un test bloqueado que no pasa el lint o el formato del repo deja verify en rojo y ninguna sub-task
  // lo puede tocar: en VF-4, un `let` que debía ser `const` trabó el run cuatro veces. Las herramientas
  // del repo lo arreglan sin cambiar lo que prueba; el arreglo va en su propio commit, con el hash nuevo.
  const lockedPaths = Object.keys(plan.locked);
  if (config.lint_fix !== undefined || config.format !== undefined) {
    await runFixers(worktree, config, lockedPaths, deps.env);
    const hashOf = (path: string) => sha256(readFileSync(join(worktree, path), "utf8"));
    const fixed = lockedPaths.filter((path) => hashOf(path) !== plan.locked[path]);
    if (fixed.length > 0) {
      await git(worktree, ["add", "--", ...fixed], deps.env);
      await git(
        worktree,
        [
          "commit",
          "--quiet",
          "--no-verify",
          "-m",
          "test: lint y formato de los tests de criterios",
          "--trailer",
          `Flowrunner-Run: ${run.id}`,
        ],
        deps.env,
      );
      const locked = { ...plan.locked, ...Object.fromEntries(fixed.map((p) => [p, hashOf(p)])) };
      writeFileSync(join(run.dir, "locked.json"), `${JSON.stringify(locked, null, 2)}\n`);
      emit({
        tipo: "aviso",
        fase: "verificar",
        texto: `flowrunner pasó el lint y el formateador del repo por ${fixed.join(", ")} y commiteó el arreglo`,
      });
    }
  }

  // Los .env existen antes de correr nada: si faltan, ningún criterio puede pasar y no es del código.
  const envCheck = copyEnvFiles(ctx.state.repo, worktree, config.env_files);
  if (!envCheck.ok) return { tipo: "falla", clase: "entorno", motivo: envCheck.motivo };
  envCheck.remove();

  // Los .env solo mientras corren los comandos: diagnosticar y reparar leen este worktree.
  // Con el turno del entorno por tanda, no por fase: entre tandas corren diagnosticar y reparar.
  const runCriteria = (criteria: readonly (typeof plan.criterios)[number][]) =>
    conEntorno(ctx, () =>
      withEnvFiles(ctx.state.repo, worktree, config.env_files, async () => {
        const run = acceptanceRunner(worktree, deps.env);
        const failing: (Failing & { hint: string | undefined })[] = [];
        for (const criterion of criteria) {
          const result = await run(criterion.comando);
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
      }),
    );

  // Un criterio que es el verify del repo, como «verify.sh en verde», no es de la sub-task que lo
  // tiene asignado: lo corre el paso de verify de abajo, que atribuye el rojo por archivo. Corrido acá
  // volvía a esa sub-task aunque el rojo fuera de otra (VF-6: el Prettier de ST-3 volvía a ST-6).
  const criteria = plan.criterios.filter((c) => !isVerifyCommand(config, c.comando));
  let failing = await runCriteria(criteria);
  // Una señal de entorno no la arregla una sub-task: se reinstala y se repite una vez.
  if (failing.some((f) => f.hint !== undefined)) {
    const setup = await runShell(config.setup, {
      cwd: worktree,
      env: deps.env,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    if (setup.code === 0) {
      const again = new Set(failing.map((f) => f.id));
      failing = await runCriteria(criteria.filter((c) => again.has(c.id)));
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
    // Diagnosticar y reparar corren solos solo si el repo pidió vueltas: con 0, el primer rojo ya es
    // una pregunta para la persona (D5, ADR 0023).
    const stalled =
      ctx.state.vueltasMax > 0 && (failing.some((f) => returned.includes(f.subtarea)) || repeated);
    if (stalled) {
      const diagnosed = await diagnose(ctx, {
        worktree,
        config,
        plan,
        locked: Object.keys(plan.locked),
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
      if (diagnosed?.tipo === "reparar") {
        const locked = readPlan(run).locked;
        const repaired = await repairTest(ctx, { worktree, config, plan, locked, ...diagnosed });
        if (!repaired) {
          return {
            tipo: "falla",
            clase: "entorno",
            motivo: `el test bloqueado ${diagnosed.archivo} tiene que cambiar y flowrunner no pudo repararlo: ${diagnosed.explicacion}. Para replanificar: flowrunner rerun ${run.id} --desde planificar`,
          };
        }
        failing = await runCriteria(criteria);
      } else if (diagnosed !== undefined) return diagnosed;
    }
    if (failing.length > 0) {
      return {
        tipo: "vuelve",
        unidades: [...new Set(failing.map((f) => f.subtarea))],
        motivo: failing.map((f) => f.detalle).join("\n\n"),
      };
    }
  }

  const verify = await conEntorno(ctx, () => runVerify(worktree, config, deps.env));
  if (!verify.ok) {
    if (verify.unrunnable) return { tipo: "falla", clase: "entorno", motivo: verify.detail };
    // Se atribuye por los archivos que nombra la salida: vuelve la sub-task dueña de cada uno. Sin
    // archivos reconocibles, vuelven todas, porque no se adivina cuál lo rompió.
    const output =
      verify.result === undefined
        ? verify.detail
        : `${verify.result.stdout}\n${verify.result.stderr}`;
    const named = (await namedFiles(output, worktree, deps.env)).filter(
      (f) => !Object.keys(plan.locked).includes(f),
    );
    const ownerOf = (file: string) =>
      plan.subtareas.filter((t) => t.alcance.some((a) => covers(a, file)));
    const owners = [...new Set(named.flatMap((f) => ownerOf(f).map((t) => t.id)))];
    const orphans = named.filter((f) => ownerOf(f).length === 0);
    if (named.length > 0 && owners.length === 0) {
      // Devolverlo no sirve: ninguna sub-task puede escribir esos archivos, y el ciclo se repetiría
      // hasta agotar los intentos (CUENTAS-1, con seeds que llamaban a una función que cambió).
      return {
        tipo: "falla",
        clase: "entorno",
        motivo: `verify está en rojo por ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? ` y ${String(orphans.length - 5)} más` : ""}, y ningún archivo de esos está en el alcance de una sub-task: nadie lo puede arreglar. Para replanificar con esos archivos en algún alcance: flowrunner rerun ${run.id} --desde planificar\n\n${verify.detail}`,
      };
    }
    return {
      tipo: "vuelve",
      unidades: owners.length > 0 ? owners : plan.subtareas.map((t) => t.id),
      motivo: `los criterios pasan pero verify está en rojo${owners.length > 0 ? ` en ${named.join(", ")}` : ""}: ${verify.detail}`,
    };
  }
  return { tipo: "ok" };
};

const normalize = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const covers = (scope: string, file: string) =>
  file === normalize(scope) || file.startsWith(`${normalize(scope)}/`);

/**
 * Los archivos versionados que nombra una salida: con su línea, como `src/a.ts:12`, `src/a.ts(12,5)` o
 * la ruta absoluta del worktree, o solos en una línea, como los muestran Prettier y ESLint. Una ruta relativa a un paquete del monorepo, como la que imprime
 * `tsc` desde `apps/api`, cuenta si termina un único archivo del repo.
 */
export async function namedFiles(
  output: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const tracked = (await git(worktree, ["ls-files"], env)).split("\n").filter((f) => f !== "");
  const relative = output.replaceAll(`${worktree}/`, "");
  const mentioned = [
    ...relative.matchAll(/(?:^|[\s'"`(])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,6})(?=[:(]\d)/gm),
  ].map((m) => (m[1] ?? "").replace(/^\.\//, ""));
  // Lo que nombra un archivo sin línea: Prettier (`[warn] src/a.ts`) y el formato de ESLint, que pone
  // la ruta sola en una línea y debajo sus errores. Solo cuenta si la línea entera es la ruta.
  const alone = relative
    .split("\n")
    .map((line) => line.trim().replace(/^\[(?:warn|error)\]\s+/, ""))
    .filter((line) => /^(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,6}$/.test(line))
    .map((line) => line.replace(/^\.\//, ""));
  mentioned.push(...alone);
  const found = mentioned.flatMap((m) => {
    if (tracked.includes(m)) return [m];
    const suffix = tracked.filter((t) => t.endsWith(`/${m}`));
    return suffix.length === 1 ? suffix : [];
  });
  return [...new Set(found)];
}
