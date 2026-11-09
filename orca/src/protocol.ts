// El contrato entre el panel y el worker, declarado una vez: lo leen src/panel.tsx y src/worker.ts.
import type { Decision, Run } from "./runs";

export interface Snapshot {
  readonly runs: Run[];
  /** Por qué falló la última lectura, si falló. */
  readonly error?: string;
  /** Cuándo se leyó, en ms desde el epoch. */
  readonly at: number;
}

export interface Outcome {
  readonly ok: boolean;
  /** Lo que dijo flowrunner: qué hizo, o por qué no y cómo seguir. */
  readonly mensaje: string;
}

/**
 * Lo que se abre en una pestaña de Orca: los pasos de una sesión, una sub-task con su diff, el
 * detalle de una etapa, el plan o el informe del run.
 */
export type Openable =
  | { readonly tipo: "pasos"; readonly sesion: string }
  | { readonly tipo: "unidad"; readonly unidad: string }
  | { readonly tipo: "etapa"; readonly fase: string }
  | { readonly tipo: "plan" }
  | { readonly tipo: "informe" };

declare module "orca" {
  interface PluginRequests {
    /** Los runs activos, leídos ahora. */
    "flowrunner.runs": { output: Snapshot };
    /** Abre los pasos de una sesión o el plan en una pestaña de Orca, en el proyecto del run. */
    "flowrunner.abrir": { input: { run: string; que: Openable }; output: Outcome };
    /** Una decisión de la persona: aprobar, pedir cambios, reanudar o rehacer desde una fase. */
    "flowrunner.decidir": { input: { run: string; decision: Decision }; output: Outcome };
  }
}
