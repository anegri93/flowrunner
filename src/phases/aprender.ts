// Aprender: después del merge, las correcciones de la persona se vuelven lecciones que llegan a la
// base por una PR chica con auto-merge. Solo cuentan los commits y comentarios de `github_user`.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES, proposalsFile } from "../brain/brain.ts";
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
  openPrBranches,
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
const LESSONS_BRANCH = "chore/lecciones-";

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
export const consolidationSchema = z.object({
  lecciones_md: z.string().min(1),
  detalle_md: z.string().min(1).optional(),
});

/**
 * El porqué y los ejemplos de cada lección, con el mismo número, fuera de lecciones.md para no pasar
 * su tope. Es opcional y ningún prompt lo carga: lo lee quien siga el aviso de lecciones.md.
 */
export const DETAIL_FILE = "lecciones-detalle.md";

export const lessonNumbers = (text: string) =>
  [...text.matchAll(/^### L-(\d+)/gm)].map((m) => Number(m[1]));

/** Las entradas del detalle cuya lección ya no está en lecciones.md. */
export function detailOrphans(lessons: string, detail: string): number[] {
  const kept = new Set(lessonNumbers(lessons));
  return lessonNumbers(detail).filter((n) => !kept.has(n));
}

/**
 * El auto-merge solo entra si el diff toca lecciones.md y, como mucho, borra las propuestas que ya
 * revisó la persona en la PR de la feature; y si no hubo consolidación (spec, sección 4).
 */
export function autoMergeAllowed(touched: readonly string[], consolidated: boolean): boolean {
  return (
    !consolidated &&
    touched.length > 0 &&
    touched.every(
      (f) =>
        f === `.flowrunner/${BRAIN_FILES.lecciones.file}` ||
        f.startsWith(".flowrunner/propuestas/"),
    )
  );
}

/** Dónde empieza, en el archivo de propuestas, la lista de lecciones que ya estaban y no alcanzaron. */
export const MISSES_HEADING = "## No alcanzaron";

/** Las lecciones propuestas (`### título`), numeradas desde `first` como entradas de lecciones.md. */
export function numberProposals(text: string, first: number): { added: string; count: number } {
  const cut = text.indexOf(`\n${MISSES_HEADING}`);
  const body = cut === -1 ? text : text.slice(0, cut);
  const at = body.search(/^### /m);
  if (at === -1) return { added: "", count: 0 };
  let n = first;
  const added = `\n${body.slice(at).trimEnd()}\n`.replace(
    /^### /gm,
    () => `### L-${String(n++)} · `,
  );
  return { added, count: n - first };
}

/**
 * Anota debajo de cada lección que no alcanzó (`- L-n · run … · origen · fecha` en las propuestas) una
 * línea `No alcanzó:`. Así se ve qué lecciones no se entienden; una que ya no está se ignora.
 */
export function markMisses(lessons: string, proposals: string): string {
  const cut = proposals.indexOf(`\n${MISSES_HEADING}`);
  if (cut === -1) return lessons;
  let out = lessons;
  for (const m of proposals.slice(cut).matchAll(/^- L-(\d+) · (.+)$/gm)) {
    const start = out.search(new RegExp(`^### L-${m[1] ?? ""} · `, "m"));
    if (start === -1) continue;
    const next = out.slice(start + 1).search(/^### /m);
    const end = next === -1 ? out.length : start + 1 + next;
    out = `${out.slice(0, end).trimEnd()}\n\nNo alcanzó: ${m[2] ?? ""}\n${next === -1 ? "" : "\n"}${out.slice(end)}`;
  }
  return out;
}

export const APRENDER_TIMEOUT_MS = 15 * 60_000;

export const nextLessonNumber = (text: string) => 1 + Math.max(0, ...lessonNumbers(text));

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
  const config = loadRepoConfig(state.repo);
  const feature = runFeature(run);
  const proposalsRel = proposalsFile(feature.clave);
  const hasProposals = async () =>
    (await git(
      state.repo,
      ["ls-tree", "--name-only", `origin/${config.base_branch}`, "--", proposalsRel],
      deps.env,
    ).catch(() => "")) !== "";
  if (found.length === 0 && !(await hasProposals())) return { tipo: "ok" };

  // Dos PRs de lecciones a la vez se pisarían en lecciones.md. Ocupado no se espera: tick reintenta.
  const turno = turnoFile(run.home, state.proyecto, "lecciones");
  const intento = intentarTurno(turno, run.id);
  if (intento.tipo === "ocupado") return { tipo: "espera" };
  try {
    const wt = join(run.worktrees, "lecciones");
    const branch = `${LESSONS_BRANCH}${feature.clave}`;
    // El turno se suelta al abrir la PR, no al mergearla. Mientras la de otro run siga abierta, la base
    // no tiene sus lecciones: esta tomaría los mismos números y las dos chocarían en lecciones.md.
    let abiertas: string[];
    try {
      abiertas = await openPrBranches(state.repo, deps.env);
    } catch (error) {
      if (error instanceof GhError) return { tipo: "falla", clase: "infra", motivo: error.message };
      throw error;
    }
    if (abiertas.some((b) => b.startsWith(LESSONS_BRANCH) && b !== branch))
      return { tipo: "espera" };
    // La de otro run pudo mergearse después del fetch de arriba: la base tiene que traer sus lecciones.
    await fetchOrigin(state.repo, deps.env).catch(() => undefined);
    await addWorktree(state.repo, wt, branch, `origin/${config.base_branch}`, deps.env);
    const lessonsFile = join(wt, ".flowrunner", BRAIN_FILES.lecciones.file);
    const current = readFileSync(lessonsFile, "utf8");
    // Las propuestas ya las revisó la persona en la PR de la feature: entran tal cual, con su número.
    const proposalsAbs = join(wt, proposalsRel);
    const proposals = existsSync(proposalsAbs) ? readFileSync(proposalsAbs, "utf8") : "";
    if (existsSync(proposalsAbs)) rmSync(proposalsAbs);
    const proposed = numberProposals(proposals, nextLessonNumber(current));
    let fromCorrections = "";
    let correctionCount = 0;
    if (found.length > 0) {
      const result = await runSession(
        {
          fase: "aprender",
          nombre: sessionName(run, "aprender"),
          prompt: render("aprender", {
            correcciones: found
              .map((c) => `### ${c.tipo} · ${c.origen}\n\n${c.texto}`)
              .join("\n\n"),
            lecciones: `${current.trimEnd()}\n${proposed.added}`,
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
      let n = nextLessonNumber(current) + proposed.count;
      const today = deps.now().toISOString().slice(0, 10);
      fromCorrections = result.output.lecciones
        .map(
          (l) =>
            `\n### L-${n++} · ${l.titulo}\n\nRegla: ${l.regla}\n\nOrigen: ${l.origen} · ${today}\n`,
        )
        .join("");
      correctionCount = result.output.lecciones.length;
    }
    const added = `${proposed.added}${fromCorrections}`;
    let text = `${markMisses(current, proposals).trimEnd()}\n${added}`;
    let consolidated = false;
    // Al consolidar se unen y sacan lecciones: el detalle tiene que seguirlas o queda con números viejos.
    const detailFile = join(wt, ".flowrunner", DETAIL_FILE);
    const detail = existsSync(detailFile) ? readFileSync(detailFile, "utf8") : undefined;
    if (Array.from(text).length > BRAIN_FILES.lecciones.max) {
      const merged = await runSession(
        {
          fase: "aprender",
          nombre: sessionName(run, "aprender-consolidar"),
          prompt: render("consolidar", {
            lecciones: text,
            maximo: String(BRAIN_FILES.lecciones.max),
            detalle: detail === undefined ? "" : render("consolidar-detalle", { detalle: detail }),
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
      if (detail !== undefined) {
        const newDetail = merged.output.detalle_md;
        if (newDetail === undefined)
          return {
            tipo: "falla",
            clase: "gate",
            motivo: `la consolidación no reescribió ${DETAIL_FILE}`,
          };
        const orphans = detailOrphans(text, newDetail);
        if (orphans.length > 0) {
          return {
            tipo: "falla",
            clase: "gate",
            motivo: `la consolidación dejó en ${DETAIL_FILE} lecciones que ya no están: ${orphans.map((n) => `L-${String(n)}`).join(", ")}`,
          };
        }
        writeFileSync(detailFile, newDetail.endsWith("\n") ? newDetail : `${newDetail}\n`);
      }
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
      `Lecciones de ${feature.clave}: las que se propusieron en su PR y las que salen de las correcciones de ${githubUser}.\n\n${added}`,
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
      cantidad: proposed.count + correctionCount,
      auto_merge: auto,
    });
    await removeWorktree(state.repo, wt, deps.env);
    return { tipo: "ok" };
  } finally {
    soltarTurno(turno, intento.dueño);
  }
};
