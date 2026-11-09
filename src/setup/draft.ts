// El primer borrador del cerebro que redacta `flowrunner init` leyendo el código del repo: las
// convenciones, el contexto con lo que conviene reusar y qué es una buena PR. Va en una sección
// propia de cada archivo, marcada como inferida, para que la persona sepa qué revisar en la PR.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { BRAIN_FILES, brainDir } from "../brain/brain.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { git } from "../git/git.ts";
import { render } from "../prompts/render.ts";
import type { Deps, RunPaths } from "../runner/types.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import type { Finding } from "./infer.ts";

export const DRAFT_HEADING = "## Borrador de flowrunner init";
export const DRAFT_BUDGET_USD = 3;
export const DRAFT_TIMEOUT_MS = 15 * 60_000;
/** Cada texto, bien por debajo del tope de 16.000 caracteres de su archivo. */
const MAX_TEXT = 4_000;
const MAX_LISTED_FILES = 400;
const MAX_PACKAGE_JSON = 4_000;

const part = z.object({
  texto: z.string().min(1).max(MAX_TEXT),
  fuentes: z.array(z.string().min(1)).min(1).max(40),
});
export const draftSchema = z.object({ convenciones: part, contexto: part, que_es_bien: part });
export type Draft = z.infer<typeof draftSchema>;

const TARGETS: Record<keyof Draft, string> = {
  convenciones: BRAIN_FILES.convenciones.file,
  contexto: BRAIN_FILES.contexto.file,
  que_es_bien: BRAIN_FILES.queEsBien.file,
};

/** Las fuentes que no son un archivo versionado ni una carpeta que tenga alguno. */
export function inventedSources(draft: Draft, files: readonly string[]): string[] {
  const known = (source: string) => {
    const path = source.replace(/^\.\//, "").replace(/\/+$/, "");
    return path !== "" && files.some((f) => f === path || f.startsWith(`${path}/`));
  };
  const sources = Object.values(draft).flatMap((p) => p.fuentes);
  return [...new Set(sources)].filter((s) => !known(s));
}

/** Lo que escribe la persona queda arriba; el borrador, abajo, en una sección que dice de dónde salió. */
export function withDraft(current: string, draft: Draft[keyof Draft], today: string): string {
  return [
    current.trimEnd(),
    "",
    DRAFT_HEADING,
    "",
    `> Lo dedujo \`flowrunner init\` del código el ${today}, sin revisión humana. Corregí o borrá lo`,
    "> que no sea así; lo que escribas vos va arriba de esta sección.",
    "",
    draft.texto.trim(),
    "",
    `Fuentes: ${draft.fuentes.map((f) => `\`${f}\``).join(", ")}`,
    "",
  ].join("\n");
}

export interface DraftInput {
  readonly worktree: string;
  /** `git ls-files` de la base. */
  readonly files: readonly string[];
  readonly hallazgos: readonly Finding[];
  readonly config: RepoConfig;
  /** Dónde queda el stream de la sesión: init no tiene un run propio. */
  readonly session: RunPaths;
  readonly deps: Deps;
}

export type DraftResult =
  | { readonly tipo: "ok"; readonly costoUsd: number }
  | { readonly tipo: "falla"; readonly motivo: string };

function promptVars(input: DraftInput, commits: string): Record<string, string> {
  const listed = input.files.slice(0, MAX_LISTED_FILES);
  const rest = input.files.length - listed.length;
  let packageJson: string;
  try {
    packageJson = readFileSync(join(input.worktree, "package.json"), "utf8");
  } catch {
    packageJson = "(no hay)";
  }
  return {
    hallazgos: input.hallazgos.map((h) => `- ${h.que}: ${h.detalle}`).join("\n"),
    stack:
      packageJson.length > MAX_PACKAGE_JSON
        ? `${packageJson.slice(0, MAX_PACKAGE_JSON)}\n… (cortado)`
        : packageJson,
    commits: commits.trim() === "" ? "(ninguno)" : commits.trim(),
    archivos: [
      ...listed,
      ...(rest > 0 ? [`… y ${String(rest)} más: usá Glob para verlos`] : []),
    ].join("\n"),
  };
}

/**
 * Una sesión de solo lectura sobre el worktree de init redacta el borrador y, si todas sus fuentes
 * existen, lo agrega a los tres archivos. Si falla, las plantillas quedan como estaban.
 */
export async function draftBrain(input: DraftInput): Promise<DraftResult> {
  const { worktree, deps } = input;
  const commits = await git(worktree, ["log", "-n", "20", "--no-merges", "--format=%s"], deps.env);
  const root = realpathSync(worktree);
  // Init no es una fase de un run: la sesión usa la etiqueta y el modelo de planificar, que es la
  // otra que lee el repo para entenderlo antes de actuar.
  const result = await runSession(
    {
      fase: "planificar",
      nombre: "borrador-cerebro",
      prompt: render("borrador-cerebro", promptVars(input, commits)),
      cwd: root,
      model: input.config.models.planificar,
      tools: ["Read", "Grep", "Glob"],
      hook: tripwireHook(
        {
          scope: {
            root,
            owner: "planificar",
            writable: [],
            writeGlobs: [],
            locked: [],
            harness: [],
            lockfiles: [],
            manifests: [],
            depsDeclared: false,
            testGlobs: [],
            bash: [],
          },
          fase: "planificar",
          write: false,
          bash: false,
          agents: false,
          graft: false,
        },
        () => undefined,
      ),
      schema: draftSchema,
      maxBudgetUsd: DRAFT_BUDGET_USD,
      timeoutMs: DRAFT_TIMEOUT_MS,
    },
    { run: input.session, deps, emit: () => undefined },
  );
  if (result.tipo === "limite") {
    return {
      tipo: "falla",
      motivo: `Claude llegó a su límite hasta ${new Date(result.hasta).toLocaleTimeString("es-AR")}`,
    };
  }
  if (result.tipo === "falla") return { tipo: "falla", motivo: result.motivo };
  const invented = inventedSources(result.output, input.files);
  if (invented.length > 0) {
    return {
      tipo: "falla",
      motivo: `cita archivos que no están en el repo: ${invented.join(", ")}`,
    };
  }
  const today = deps.now().toISOString().slice(0, 10);
  for (const [key, file] of Object.entries(TARGETS) as [keyof Draft, string][]) {
    const path = join(brainDir(worktree), file);
    writeFileSync(path, withDraft(readFileSync(path, "utf8"), result.output[key], today));
  }
  return { tipo: "ok", costoUsd: result.costoUsd };
}
