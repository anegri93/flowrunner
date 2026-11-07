// Lo que recibe una fase y lo que necesita el runner del mundo exterior, inyectado.
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Action, RunState } from "../engine/engine.ts";
import type { NewEvent, Outcome, Phase, RunEvent } from "../store/events.ts";

export type QueryFn = (params: {
  prompt: string;
  options?: import("@anthropic-ai/claude-agent-sdk").Options;
}) => Query;

export interface Deps {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly notify: (title: string, body: string) => void;
  readonly query: QueryFn;
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
