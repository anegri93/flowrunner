// Schemas de la config global (~/.flowrunner/config.yaml) y de la config de cada repo
// (.flowrunner/config.yaml). Los defaults viven acá y en ningún otro lado.
import { z } from "zod";

export const MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const AGENT_PHASES = [
  "planificar",
  "explorar",
  "implementar",
  "revisar",
  "aprender",
] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

const modelChoice = z.strictObject({ model: z.enum(MODEL_IDS), effort: z.enum(EFFORTS) });
export type ModelChoice = z.infer<typeof modelChoice>;

export const DEFAULT_MODELS: Record<AgentPhase, ModelChoice> = {
  planificar: { model: "claude-opus-5-5", effort: "high" },
  explorar: { model: "claude-haiku-5-5", effort: "low" },
  implementar: { model: "claude-sonnet-5-5", effort: "high" },
  revisar: { model: "claude-opus-5-5", effort: "high" },
  aprender: { model: "claude-sonnet-5-5", effort: "medium" },
};

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "tiene que ser una ruta relativa al repo, sin '..'",
  });

export const repoConfigSchema = z
  .strictObject({
    base_branch: z.string().min(1).default("main"),
    setup: z.string().min(1),
    verify: relativePath.default(".flowrunner/verify.sh"),
    tests_globs: z.array(z.string().min(1)).min(1),
    /** El lint en modo arreglar, al que flowrunner le agrega las rutas: `npx eslint --fix`. */
    lint_fix: z.string().min(1).optional(),
    /** El formateador, al que flowrunner le agrega las rutas: `npx prettier --write`. */
    format: z.string().min(1).optional(),
    harness_files: z.array(relativePath).default([]),
    lockfiles: z.array(relativePath).default([]),
    manifests: z.array(relativePath).default([]),
    max_parallel: z.int().min(1).max(16).default(3),
    /** Tope opcional en USD por run. Sin él, el run no se corta por gasto. */
    budget: z.strictObject({ run_usd: z.number().positive() }).optional(),
    models: z.partialRecord(z.enum(AGENT_PHASES), modelChoice).default({}),
  })
  .transform((config) => ({ ...config, models: { ...DEFAULT_MODELS, ...config.models } }));
export type RepoConfig = z.output<typeof repoConfigSchema>;

const projectName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "solo minúsculas, números y guiones, empezando por letra o número",
  );

export const globalConfigSchema = z
  .strictObject({
    github_user: z.string().min(1),
    /** `token`: el de `claude setup-token` en el Keychain. `login`: la sesión de Claude Code. */
    auth: z.enum(["token", "login"]).default("token"),
    tick_minutes: z.int().min(1).max(1440).default(10),
    projects: z.array(z.strictObject({ name: projectName, path: z.string().min(1) })).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [i, project] of config.projects.entries()) {
      if (seen.has(project.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", i, "name"],
          message: `el proyecto "${project.name}" está repetido`,
        });
      }
      seen.add(project.name);
    }
  });
export type GlobalConfig = z.output<typeof globalConfigSchema>;

/** Un problema de config con su ruta, para listar todos juntos en un solo error. */
export interface Problem {
  readonly where: string;
  readonly message: string;
}

export function problemsFrom(file: string, error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    where: [file, ...issue.path.map(String)].join(" › "),
    message:
      issue.code === "unrecognized_keys"
        ? `campo desconocido: ${issue.keys.join(", ")}`
        : issue.message,
  }));
}

export class ConfigError extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(problems.map((p) => `${p.where}: ${p.message}`).join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}
