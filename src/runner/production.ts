// Las dependencias reales del proceso de un run, y la única costura de test: FLOWRUNNER_TEST_HOOKS.
//
// FLOWRUNNER_TEST_HOOKS es la ruta absoluta de un módulo que puede exportar `phases`, `query` y
// `notify`. Solo lo usan los tests de integración, que corren el CLI real como proceso hijo; en
// producción la variable no existe.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { pathToFileURL } from "node:url";
import { PHASES, type Phase } from "../store/events.ts";
import type { Deps, PhaseFn, PhaseRegistry, QueryFn } from "./types.ts";

interface TestHooks {
  readonly phases?: Partial<PhaseRegistry>;
  readonly query?: QueryFn;
  readonly notify?: (title: string, body: string) => void;
}

async function testHooks(env: NodeJS.ProcessEnv): Promise<TestHooks> {
  const file = env.FLOWRUNNER_TEST_HOOKS;
  if (file === undefined || file === "") return {};
  return (await import(pathToFileURL(file).href)) as TestHooks;
}

const notImplemented =
  (fase: Phase): PhaseFn =>
  () =>
    Promise.reject(new Error(`la fase ${fase} todavía no está implementada`));

/** Las fases reales; cada una se suma acá cuando existe. */
export function realPhases(): Partial<PhaseRegistry> {
  return {};
}

export async function productionRuntime(
  env: NodeJS.ProcessEnv,
  notify: (title: string, body: string) => void,
): Promise<{ deps: Deps; phases: PhaseRegistry }> {
  const hooks = await testHooks(env);
  const real = realPhases();
  const phases = Object.fromEntries(
    PHASES.map((fase) => [fase, hooks.phases?.[fase] ?? real[fase] ?? notImplemented(fase)]),
  ) as PhaseRegistry;
  return {
    phases,
    deps: {
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      notify: hooks.notify ?? notify,
      query: hooks.query ?? sdkQuery,
      env,
    },
  };
}
