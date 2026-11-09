// Cuando algo falla en verificar y reintentar a ciegas no lo arregla. Primero lo barato y sin modelo:
// una señal de entorno en la salida se resuelve reinstalando y repitiendo. Si el ciclo no converge,
// porque la sub-task devuelta no encontró nada que cambiar o el mismo criterio falló dos vueltas
// seguidas, una sesión de solo lectura dice de qué lado está el problema: el código de alguna sub-task,
// el entorno, un test bloqueado que hay que reparar, o el plan. Todo con tope: verificar sigue contando
// sus vueltas.
import { realpathSync } from "node:fs";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import type { RepoConfig } from "../config/schemas.ts";
import type { Plan } from "../gates/plan.ts";
import { featureText, render } from "../prompts/render.ts";
import type { Outcome } from "../store/events.ts";
import type { PhaseContext } from "../runner/types.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { runFeature } from "./inputs.ts";
import { sessionName } from "./planificar.ts";

/** Líneas que delatan un problema del entorno, no del código. */
const ENVIRONMENT = [
  /Cannot find (package|module) ['"]/,
  /ERR_MODULE_NOT_FOUND/,
  /command not found/,
  /ECONNREFUSED/,
  /EADDRINUSE/,
  /ENOENT[^\n]*spawn/,
];

/** La línea de la salida que delata un problema de entorno, si hay una. */
export function environmentHint(output: string): string | undefined {
  return output
    .split("\n")
    .find((line) => ENVIRONMENT.some((re) => re.test(line)))
    ?.trim();
}

export const diagnosisSchema = z.object({
  causa: z.enum(["codigo", "entorno", "test", "plan"]),
  subtarea: z.string(),
  /** Con `test`, la ruta del test bloqueado que hay que reparar. */
  archivo: z.string().default(""),
  instruccion: z.string(),
  explicacion: z.string().min(1),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const DIAGNOSTICAR_BUDGET_USD = 3;
export const DIAGNOSTICAR_TIMEOUT_MS = 15 * 60_000;

export interface Failing {
  readonly id: string;
  readonly comando: string;
  readonly subtarea: string;
  readonly detalle: string;
}

/** Un test bloqueado que hay que reparar: lo hace verificar, con sus controles. */
export interface RepairRequest {
  readonly tipo: "reparar";
  readonly archivo: string;
  readonly instruccion: string;
  readonly explicacion: string;
}

/**
 * Qué hacer con lo que sigue en rojo, según el diagnóstico. Si la sesión no responde algo usable,
 * undefined: verificar devuelve el trabajo como siempre, que el tope de vueltas acota.
 */
export async function diagnose(
  ctx: PhaseContext,
  input: {
    worktree: string;
    config: RepoConfig;
    plan: Pick<Plan, "plan" | "subtareas">;
    /** Los tests bloqueados del plan: los únicos que el diagnóstico puede mandar a reparar. */
    locked: readonly string[];
    failing: readonly Failing[];
    historia: string;
  },
): Promise<Outcome | RepairRequest | undefined> {
  const { run, deps, emit } = ctx;
  const { worktree, config, plan, failing } = input;
  const ids = plan.subtareas.map((t) => t.id);
  const commands = [
    ...failing.map((f) => f.comando),
    "git status",
    "git diff",
    "git log --oneline -10",
  ];
  const result = await runSession(
    {
      fase: "verificar",
      nombre: sessionName(run, "verificar-diagnostico"),
      prompt: render("diagnosticar", {
        comandos: commands.map((c) => `\`${c}\``).join(", "),
        subtareas: ids.join(", "),
        feature: featureText(runFeature(run)),
        plan: plan.plan,
        tareas: plan.subtareas
          .map(
            (t) => `- ${t.id} · ${t.titulo}: ${t.descripcion} (alcance: ${t.alcance.join(", ")})`,
          )
          .join("\n"),
        falla: failing
          .map((f) => `## ${f.id} · cubierto por ${f.subtarea}\n\n${f.detalle}`)
          .join("\n\n"),
        historia: input.historia,
        bloqueados: input.locked.length === 0 ? "(ninguno)" : input.locked.join(", "),
      }),
      cwd: worktree,
      model: config.models.revisar,
      tools: ["Read", "Grep", "Glob", "Bash"],
      hook: tripwireHook(
        {
          scope: {
            root: realpathSync(worktree),
            owner: "verificar",
            writable: [],
            writeGlobs: [],
            locked: [],
            harness: [],
            lockfiles: [],
            manifests: [],
            depsDeclared: false,
            testGlobs: config.tests_globs,
            bash: commands,
          },
          fase: "verificar",
          write: false,
          bash: true,
          agents: false,
          graft: false,
        },
        emit,
      ),
      schema: diagnosisSchema,
      maxBudgetUsd: DIAGNOSTICAR_BUDGET_USD,
      timeoutMs: DIAGNOSTICAR_TIMEOUT_MS,
    },
    { run, deps, emit },
  );
  if (result.tipo === "limite") return result;
  if (result.tipo !== "ok") {
    emit({ tipo: "aviso", fase: "verificar", texto: `no se pudo diagnosticar: ${result.motivo}` });
    return undefined;
  }
  const d = result.output;
  const target =
    d.causa === "codigo" ? ` en ${d.subtarea}` : d.causa === "test" ? ` en ${d.archivo}` : "";
  emit({
    tipo: "decision",
    fase: "verificar",
    que: `diagnóstico: ${d.causa}${target}`,
    por_que: d.explicacion,
  });
  if (d.causa === "codigo") {
    if (!ids.includes(d.subtarea)) {
      emit({
        tipo: "aviso",
        fase: "verificar",
        texto: `el diagnóstico nombró una sub-task que no existe: ${d.subtarea}`,
      });
      return undefined;
    }
    return {
      tipo: "vuelve",
      unidades: [d.subtarea],
      motivo: `Diagnóstico: ${d.explicacion}\n\n${d.instruccion}`,
    };
  }
  if (d.causa === "test") {
    if (!input.locked.includes(d.archivo)) {
      emit({
        tipo: "aviso",
        fase: "verificar",
        texto: `el diagnóstico pidió reparar un archivo que no es un test bloqueado: ${d.archivo}`,
      });
      return undefined;
    }
    return {
      tipo: "reparar",
      archivo: d.archivo,
      instruccion: d.instruccion,
      explicacion: d.explicacion,
    };
  }
  if (d.causa === "entorno") {
    return {
      tipo: "falla",
      clase: "entorno",
      motivo: `el código parece estar bien pero falta algo para correrlo: ${d.explicacion}. Arreglalo y seguí con flowrunner resume ${run.id}`,
    };
  }
  return {
    tipo: "falla",
    clase: "entorno",
    motivo: `el plan no se puede cumplir como está: ${d.explicacion}. Para replanificar: flowrunner rerun ${run.id} --desde planificar`,
  };
}
