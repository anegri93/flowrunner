// Aprender: después del merge, las correcciones de la persona se vuelven lecciones que llegan a la
// base por una PR chica con auto-merge. Solo cuentan los commits y comentarios de `github_user`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES } from "../brain/brain.ts";
import { loadGlobalConfig, loadRepoConfig } from "../config/load.ts";
import {
  addWorktree,
  commitAll,
  fetchOrigin,
  git,
  pushBranch,
  removeWorktree,
} from "../git/git.ts";
import {
  createPr,
  enableAutoMerge,
  findPr,
  GhError,
  prDetail,
  type PrDetail,
} from "../github/gh.ts";
import { render } from "../prompts/render.ts";
import type { PhaseContext, PhaseFn } from "../runner/types.ts";
import type { Phase } from "../store/events.ts";
import { intentarTurno, soltarTurno, turnoFile } from "../store/turno.ts";
import { SIN_COMANDOS } from "../tripwires/comandos.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { featureWorktree, runFeature } from "./inputs.ts";
import { sessionName } from "./planificar.ts";

export interface Correction {
  readonly tipo: "commit" | "comentario";
  /** Link al commit o al comentario: el origen que cita la lección. */
  readonly origen: string;
  readonly texto: string;
}

const MAX_PATCH = 6_000;

/** Lo que corrigió la persona: sus commits posteriores al último de flowrunner y sus comentarios. */
export async function corrections(
  pr: PrDetail,
  githubUser: string,
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Correction[]> {
  const isPerson = (login: string) => login.toLowerCase() === githubUser.toLowerCase();
  const lastOurs = pr.commits.findLastIndex((c) => c.messageBody.includes("Flowrunner-Run:"));
  const out: Correction[] = [];
  for (const commit of pr.commits.slice(lastOurs + 1)) {
    if (!commit.authors.some((a) => isPerson(a.login))) continue;
    // Tocar solo el cerebro, por ejemplo borrar una lección propuesta, no corrige el código.
    const files = await git(repo, ["show", "--name-only", "--format=", commit.oid], env).catch(
      () => "",
    );
    const touched = files.split("\n").filter((f) => f !== "");
    if (touched.length > 0 && touched.every((f) => f.startsWith(".flowrunner/"))) continue;
    const patch = await git(repo, ["show", "--format=%s%n%n%b", commit.oid], env).catch(
      () => commit.messageHeadline,
    );
    out.push({
      tipo: "commit",
      origen: `${pr.url}/commits/${commit.oid}`,
      texto: patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (cortado)` : patch,
    });
  }
  for (const c of pr.comments) {
    if (isPerson(c.author.login) && c.body.trim() !== "")
      out.push({ tipo: "comentario", origen: c.url, texto: c.body });
  }
  for (const r of pr.reviews) {
    if (isPerson(r.author.login) && r.body.trim() !== "")
      out.push({ tipo: "comentario", origen: `${pr.url}#review`, texto: r.body });
  }
  return out;
}

export const lessonsSchema = z.object({
  lecciones: z
    .array(
      z.object({ titulo: z.string().min(1), regla: z.string().min(1), origen: z.string().min(1) }),
    )
    .min(1)
    .max(3),
});
export const consolidationSchema = z.object({ lecciones_md: z.string().min(1) });

/** El auto-merge solo entra si el diff toca únicamente lecciones.md y no hubo consolidación (spec, sección 4). */
export function autoMergeAllowed(touched: readonly string[], consolidated: boolean): boolean {
  return (
    !consolidated &&
    touched.length === 1 &&
    touched[0] === `.flowrunner/${BRAIN_FILES.lecciones.file}`
  );
}

export const APRENDER_TIMEOUT_MS = 15 * 60_000;

export const nextLessonNumber = (text: string) =>
  1 + Math.max(0, ...[...text.matchAll(/^### L-(\d+)/gm)].map((m) => Number(m[1])));

/**
 * Una sesión que solo lee: sin herramientas de escritura, Bash ni agentes. Con `graft`, también las del
 * MCP de graft, que solo consultan el índice (el explorador previo de planificar).
 */
export function readOnlyHook(
  ctx: PhaseContext,
  root: string,
  fase: Phase = "aprender",
  graft = false,
) {
  return tripwireHook(
    {
      scope: {
        root,
        owner: fase,
        writable: [],
        writeGlobs: [],
        locked: [],
        harness: [],
        lockfiles: [],
        manifests: [],
        depsDeclared: false,
        testGlobs: [],
        comandos: SIN_COMANDOS,
      },
      fase,
      write: false,
      bash: false,
      agents: false,
      graft,
    },
    ctx.emit,
  );
}

export const aprender: PhaseFn = async (ctx) => {
  const { run, deps, emit, state } = ctx;
  const prEvent = ctx.events.findLast((e) => e.tipo === "pr");
  if (prEvent?.tipo !== "pr")
    return { tipo: "falla", clase: "invariante", motivo: "el run entregado no tiene PR" };
  const featureWt = featureWorktree(run);
  let pr: PrDetail;
  try {
    pr = await prDetail(featureWt, prEvent.numero, deps.env);
  } catch (error) {
    if (error instanceof GhError) return { tipo: "falla", clase: "infra", motivo: error.message };
    throw error;
  }
  if (pr.state === "OPEN") return { tipo: "espera" };
  if (pr.state === "CLOSED") {
    emit({ tipo: "pr_cerrada", mergeada: false });
    return { tipo: "ok" };
  }
  if (!ctx.events.some((e) => e.tipo === "pr_cerrada"))
    emit({ tipo: "pr_cerrada", mergeada: true });
  const githubUser = loadGlobalConfig(deps.env).github_user;
  await fetchOrigin(state.repo, deps.env).catch(() => undefined);
  const found = await corrections(pr, githubUser, state.repo, deps.env);
  if (found.length === 0) return { tipo: "ok" };

  const config = loadRepoConfig(state.repo);
  const feature = runFeature(run);
  // Dos PRs de lecciones a la vez se pisarían en lecciones.md. Ocupado no se espera: tick reintenta.
  const turno = turnoFile(run.home, state.proyecto, "lecciones");
  const intento = intentarTurno(turno, run.id);
  if (intento.tipo === "ocupado") return { tipo: "espera" };
  try {
    const wt = join(run.worktrees, "lecciones");
    const branch = `chore/lecciones-${feature.clave}`;
    await addWorktree(state.repo, wt, branch, `origin/${config.base_branch}`, deps.env);
    const lessonsFile = join(wt, ".flowrunner", BRAIN_FILES.lecciones.file);
    const current = readFileSync(lessonsFile, "utf8");
    const result = await runSession(
      {
        fase: "aprender",
        nombre: sessionName(run, "aprender"),
        prompt: render("aprender", {
          correcciones: found.map((c) => `### ${c.tipo} · ${c.origen}\n\n${c.texto}`).join("\n\n"),
          lecciones: current,
          origenes: found.map((c) => c.origen).join("\n"),
        }),
        cwd: wt,
        model: config.models.aprender,
        tools: [],
        hook: readOnlyHook(ctx, wt),
        schema: lessonsSchema,
        timeoutMs: APRENDER_TIMEOUT_MS,
      },
      { run, deps, emit },
    );
    if (result.tipo !== "ok")
      return result.tipo === "limite"
        ? result
        : { tipo: "falla", clase: result.clase, motivo: result.motivo };
    const origins = new Set(found.map((c) => c.origen));
    const invented = result.output.lecciones.filter((l) => !origins.has(l.origen));
    if (invented.length > 0) {
      return {
        tipo: "falla",
        clase: "gate",
        motivo: `una lección cita un origen que no es una corrección de ${githubUser}: ${invented[0]?.origen ?? ""}`,
      };
    }
    let n = nextLessonNumber(current);
    const today = deps.now().toISOString().slice(0, 10);
    const added = result.output.lecciones
      .map(
        (l) =>
          `\n### L-${n++} · ${l.titulo}\n\nRegla: ${l.regla}\n\nOrigen: ${l.origen} · ${today}\n`,
      )
      .join("");
    let text = `${current.trimEnd()}\n${added}`;
    let consolidated = false;
    if (Array.from(text).length > BRAIN_FILES.lecciones.max) {
      const merged = await runSession(
        {
          fase: "aprender",
          nombre: sessionName(run, "aprender-consolidar"),
          prompt: render("consolidar", {
            lecciones: text,
            maximo: String(BRAIN_FILES.lecciones.max),
          }),
          cwd: wt,
          model: config.models.aprender,
          tools: [],
          hook: readOnlyHook(ctx, wt),
          schema: consolidationSchema,
          timeoutMs: APRENDER_TIMEOUT_MS,
        },
        { run, deps, emit },
      );
      if (merged.tipo !== "ok")
        return merged.tipo === "limite"
          ? merged
          : { tipo: "falla", clase: merged.clase, motivo: merged.motivo };
      text = merged.output.lecciones_md;
      consolidated = true;
    }
    writeFileSync(lessonsFile, text.endsWith("\n") ? text : `${text}\n`);
    await commitAll(
      wt,
      `docs(lecciones): lo aprendido de ${feature.clave}`,
      { "Flowrunner-Run": run.id },
      deps.env,
    );
    await pushBranch(wt, branch, deps.env);
    const bodyFile = join(run.dir, "lecciones-pr.md");
    writeFileSync(
      bodyFile,
      `Lecciones de ${feature.clave}, escritas a partir de las correcciones de ${githubUser}.\n\n${added}`,
    );
    const lessonsPr =
      (await findPr(wt, branch, deps.env)) ??
      (await createPr(
        wt,
        { branch, base: config.base_branch, title: `lecciones: ${feature.clave}`, bodyFile },
        deps.env,
      ));
    const touched = (
      await git(wt, ["diff", "--name-only", `origin/${config.base_branch}..HEAD`], deps.env)
    )
      .split("\n")
      .filter((f) => f !== "");
    const auto = autoMergeAllowed(touched, consolidated);
    if (auto) await enableAutoMerge(wt, lessonsPr.number, deps.env);
    else {
      deps.notify(
        "flowrunner",
        `${feature.clave}: la PR de lecciones necesita tu revisión${consolidated ? ": se consolidó lecciones.md" : ": toca más que lecciones.md"}.`,
      );
    }
    emit({
      tipo: "lecciones",
      url: lessonsPr.url,
      numero: lessonsPr.number,
      cantidad: result.output.lecciones.length,
      auto_merge: auto,
    });
    await removeWorktree(state.repo, wt, deps.env);
    return { tipo: "ok" };
  } finally {
    soltarTurno(turno, intento.dueño);
  }
};
