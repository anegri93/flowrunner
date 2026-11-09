// El contrato entre el panel y el worker, declarado una vez: lo leen src/panel.tsx y src/worker.ts.
import type { Decision, PlanView, Run } from "./runs";

export interface Snapshot {
  readonly runs: Run[];
  /** Por qué falló la última lectura, si falló. */
  readonly error?: string;
  /** Cuándo se leyó, en ms desde el epoch. */
  readonly at: number;
}

export interface Steps {
  readonly sesion: string;
  readonly texto: string;
}

export interface Outcome {
  readonly ok: boolean;
  /** Lo que dijo flowrunner: qué hizo, o por qué no y cómo seguir. */
  readonly mensaje: string;
}

declare module "orca" {
  interface PluginRequests {
    /** Los runs activos, leídos ahora. */
    "flowrunner.runs": { output: Snapshot };
    /** Los pasos de una sesión: `flowrunner report <run> --sesion <sesion>`. */
    "flowrunner.pasos": { input: { run: string; sesion: string }; output: Steps };
    /** El plan que espera aprobación: `flowrunner plan <run>`. */
    "flowrunner.plan": { input: { run: string }; output: PlanView };
    /** Abre la pestaña del plan con el plan de este run. */
    "flowrunner.verPlan": { input: { run: string }; output: Outcome };
    /** El run que muestra la pestaña del plan, y su plan: el pedido, o el más reciente que espera. */
    "flowrunner.planActual": { output: { run?: Run; plan?: PlanView; error?: string } };
    /** Una decisión de la persona: aprobar, pedir cambios, reanudar o rehacer desde una fase. */
    "flowrunner.decidir": { input: { run: string; decision: Decision }; output: Outcome };
  }
}
