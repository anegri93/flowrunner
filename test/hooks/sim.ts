// Hooks para tests de integración con el CLI real y el SDK simulado.
// FAKE_SIM_SCRIPTS: archivo JSON con la lista de guiones; cada sesión, de cualquier proceso, toma el
// primero sin usar que sirva para su prompt: los que tienen `match` solo sirven si el prompt lo contiene. Los prompts recibidos quedan en $HOME/prompts.log.
// FAKE_KEEP_REAL: fases que corren de verdad; el resto son falsas y solo dejan ejecuciones.txt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryFn } from "../../src/runner/types.ts";
import { simQuery, type SimScript } from "../helpers/sim-sdk.ts";
export { phases } from "./fake-phases.ts";

const scriptsFile = process.env.FAKE_SIM_SCRIPTS ?? "";
const counter = `${scriptsFile}.siguiente`;

/** El primer guion sin usar que sirve para este prompt; los usados quedan en un archivo compartido. */
function nextScript(prompt: string): SimScript {
  const scripts = JSON.parse(readFileSync(scriptsFile, "utf8")) as SimScript[];
  const used = existsSync(counter) ? (JSON.parse(readFileSync(counter, "utf8")) as number[]) : [];
  const index = scripts.findIndex(
    (s, i) => !used.includes(i) && (s.match === undefined || prompt.includes(s.match)),
  );
  const pick = index >= 0 ? index : scripts.length - 1;
  writeFileSync(counter, JSON.stringify([...used, pick]));
  const script = scripts[pick];
  if (script === undefined) throw new Error("FAKE_SIM_SCRIPTS sin guiones");
  return script;
}

export const query: QueryFn = (params) => {
  appendFileSync(join(process.env.HOME ?? "/tmp", "prompts.log"), `${params.prompt}\n---\n`);
  return simQuery((prompt) => nextScript(prompt)).query(params);
};
