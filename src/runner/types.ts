// Lo que recibe una fase y lo que necesita el runner del mundo exterior, inyectado.
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Action, RunState } from "../engine/engine.ts";
import type { NewEvent, Outcome, Phase, RunEvent } from "../store/events.ts";

/** La forma de `query` del SDK que usa flowrunner: un prompt, opciones y un stream de mensajes. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** `deleteSession` del SDK: borra del disco la conversación persistida de una sesión. */
export type DeleteSessionFn = (sessionId: string, options: { dir: string }) => Promise<void>;

export interface Deps {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly notify: (title: string, body: string) => void;
  readonly query: QueryFn;
  readonly deleteSession: DeleteSessionFn;
  readonly env: NodeJS.ProcessEnv;
}

export interface RunPaths {
  readonly id: string;
  /** `~/.flowrunner` */
  readonly home: string;
  /** `~/.flowrunner/runs/<id>` */
  readonly dir: string;
  /** `~/.flowrunner/worktrees/<id>` */
  readonly worktrees: string;
}

export interface PhaseContext {
  readonly run: RunPaths;
  readonly state: RunState;
  readonly action: Extract<Action, { tipo: "fase" }>;
  readonly events: readonly RunEvent[];
  readonly emit: (event: NewEvent) => RunEvent;
  readonly deps: Deps;
}

export type PhaseFn = (ctx: PhaseContext) => Promise<Outcome>;
export type PhaseRegistry = Record<Phase, PhaseFn>;
