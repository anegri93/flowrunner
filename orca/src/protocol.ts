// El contrato entre el panel y el worker, declarado una vez: lo leen src/panel.tsx y src/worker.ts.
import type { Run } from "./runs";

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

declare module "orca" {
  interface PluginRequests {
    /** Los runs activos, leídos ahora. */
    "flowrunner.runs": { output: Snapshot };
    /** Los pasos de una sesión: `flowrunner report <run> --sesion <sesion>`. */
    "flowrunner.pasos": { input: { run: string; sesion: string }; output: Steps };
  }
}
