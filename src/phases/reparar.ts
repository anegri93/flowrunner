// Reparar un test bloqueado. Los tests de aceptación quedan bloqueados para que nadie los ablande, pero
// un detalle que no cambia lo que prueban (un `let` que el lint quiere `const`, como en VF-4) trababa
// el run sin salida. Cuando el diagnóstico dice que la causa es el test, una sesión chica lo edita, solo
// ese archivo, y flowrunner acepta el cambio solo si el test sigue fallando sin la feature y pasa con
// ella. El arreglo va en su propio commit y la PR lo muestra. Una reparación por test y por run.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runSession } from "../agent/session.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { ACCEPTANCE_TIMEOUT_MS, type Plan } from "../gates/plan.ts";
import { git, removeWorktree } from "../git/git.ts";
import { isUnrunnable, runShell } from "../proc/proc.ts";
import { render } from "../prompts/render.ts";
import type { PhaseContext } from "../runner/types.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { runFixers } from "./fixers.ts";
import { sessionName } from "./planificar.ts";

export const REPARAR_TIMEOUT_MS = 10 * 60_000;

/** El comienzo del aviso de una reparación hecha: con él se cuenta una por test. */
export const REPAIRED = "flowrunner reparó el test bloqueado";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface RepairInput {
  readonly worktree: string;
  readonly config: RepoConfig;
  readonly plan: Pick<Plan, "criterios">;
  readonly locked: Readonly<Record<string, string>>;
  readonly archivo: string;
  readonly instruccion: string;
  readonly explicacion: string;
}

/**
 * Repara el test y devuelve true si quedó commiteado, con su hash nuevo en `locked.json`. Si no se
 * puede o los controles no pasan, deja el test como estaba, avisa por qué y devuelve false.
 */
export async function repairTest(ctx: PhaseContext, input: RepairInput): Promise<boolean> {
  const { run, deps, emit } = ctx;
  const { worktree, config, archivo } = input;
  const refuse = (por: string) => {
    emit({ tipo: "aviso", fase: "verificar", texto: `no se reparó ${archivo}: ${por}` });
    return false;
  };
  const already = ctx.events.some(
    (e) => e.tipo === "aviso" && e.texto.startsWith(`${REPAIRED} ${archivo}`),
  );
  if (already) return refuse("ya se reparó una vez en este run");
  const file = join(worktree, archivo);
  if (!existsSync(file) || sha256(readFileSync(file, "utf8")) !== input.locked[archivo]) {
    return refuse("no está como lo bloqueó planificar");
  }
  const original = readFileSync(file, "utf8");
  // La sesión solo puede editar este archivo: el hook rechaza cualquier otra escritura.
  const restore = () => {
    writeFileSync(file, original);
  };

  const result = await runSession(
    {
      fase: "verificar",
      nombre: sessionName(run, "verificar-reparacion"),
      prompt: render("reparar", {
        archivo,
        instruccion: input.instruccion,
        explicacion: input.explicacion,
      }),
      cwd: worktree,
      model: config.models.implementar,
      tools: ["Read", "Edit"],
      hook: tripwireHook(
        {
          scope: {
            root: realpathSync(worktree),
            owner: "reparar",
            writable: [archivo],
            writeGlobs: [],
            locked: [],
            harness: config.harness_files,
            lockfiles: config.lockfiles,
            manifests: config.manifests,
            depsDeclared: false,
            testGlobs: config.tests_globs,
            bash: [],
          },
          fase: "verificar",
          write: true,
          bash: false,
          agents: false,
          graft: false,
        },
        emit,
      ),
      timeoutMs: REPARAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo !== "ok") {
    restore();
    return refuse(
      `la sesión de reparación no terminó: ${result.tipo === "limite" ? "límite de uso" : result.motivo}`,
    );
  }

  // Los archivos cambiados y los nuevos, por nombre: `git` recorta la salida, y el formato de
  // `status --porcelain` empieza con un espacio.
  const listed = async (args: string[]) =>
    (await git(worktree, args, deps.env)).split("\n").filter(Boolean);
  const touched = [
    ...(await listed(["diff", "--name-only"])),
    ...(await listed(["ls-files", "--others", "--exclude-standard"])),
  ];
  if (touched.some((path) => path !== archivo)) {
    restore();
    return refuse(
      `la sesión tocó otros archivos: ${touched.filter((p) => p !== archivo).join(", ")}`,
    );
  }
  if (readFileSync(file, "utf8") === original) return refuse("la sesión no cambió nada");
  await runFixers(worktree, config, [archivo], deps.env);

  // Los criterios que corren este test: tienen que pasar con la feature y fallar sin ella.
  const own = input.plan.criterios.filter((c) => c.comando.includes(archivo));
  for (const c of own) {
    const now = await runShell(c.comando, {
      cwd: worktree,
      env: deps.env,
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    });
    if (now.code !== 0) {
      restore();
      return refuse(`${c.id} sigue en rojo con el test reparado`);
    }
  }
  const redOnBase = await stillRedWithoutFeature(ctx, input, readFileSync(file, "utf8"), own);
  if (redOnBase !== undefined) {
    restore();
    return refuse(redOnBase);
  }

  await git(worktree, ["add", "--", archivo], deps.env);
  await git(
    worktree,
    [
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `test: reparación de ${archivo}`,
      "--trailer",
      `Flowrunner-Run: ${run.id}`,
    ],
    deps.env,
  );
  const locked = { ...input.locked, [archivo]: sha256(readFileSync(file, "utf8")) };
  writeFileSync(join(run.dir, "locked.json"), `${JSON.stringify(locked, null, 2)}\n`);
  emit({
    tipo: "aviso",
    fase: "verificar",
    texto: `${REPAIRED} ${archivo}: ${input.instruccion}. El cambio está en su propio commit; revisalo en la PR.`,
  });
  return true;
}

/**
 * Corre los criterios del test reparado sobre el commit en que planificar escribió los tests, sin
 * la feature: si alguno pasa, el test ya no prueba lo que tenía que probar. Undefined si siguen en rojo.
 */
async function stillRedWithoutFeature(
  ctx: PhaseContext,
  input: RepairInput,
  repaired: string,
  own: Pick<Plan, "criterios">["criterios"],
): Promise<string | undefined> {
  const { run, deps } = ctx;
  if (own.length === 0)
    return "ningún criterio corre ese test: no hay cómo comprobar que sigue probando algo";
  const testsCommit = (
    await git(
      input.worktree,
      ["log", "--format=%H", "-n", "1", "--grep", "^test: los criterios de"],
      deps.env,
    )
  ).trim();
  if (testsCommit === "") return "no encontré el commit de los tests del plan";
  const base = join(run.worktrees, "reparacion");
  await removeWorktree(input.worktree, base, deps.env).catch(() => undefined);
  await git(
    input.worktree,
    ["worktree", "add", "--quiet", "--detach", base, testsCommit],
    deps.env,
  );
  try {
    mkdirSync(dirname(join(base, input.archivo)), { recursive: true });
    writeFileSync(join(base, input.archivo), repaired);
    // Las dependencias instaladas de la feature: sin ellas el test fallaría por no poder correr.
    const modules = join(input.worktree, "node_modules");
    if (existsSync(modules) && !existsSync(join(base, "node_modules"))) {
      symlinkSync(modules, join(base, "node_modules"));
    }
    for (const c of own) {
      const before = await runShell(c.comando, {
        cwd: base,
        env: deps.env,
        timeoutMs: ACCEPTANCE_TIMEOUT_MS,
      });
      if (before.code === 0)
        return `${c.id} pasa sin la feature con el test reparado: el cambio ablandó el test`;
      if (isUnrunnable(before))
        return `${c.id} no se pudo correr sin la feature para comprobar el test`;
    }
    return undefined;
  } finally {
    await removeWorktree(input.worktree, base, deps.env).catch(() => undefined);
  }
}
