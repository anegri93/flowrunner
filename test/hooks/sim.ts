// Hooks para tests de integración con el CLI real y el SDK simulado.
// FAKE_SIM_SCRIPTS: archivo JSON con la lista de guiones; cada sesión, de cualquier proceso, toma el
// siguiente. Los prompts recibidos quedan en $HOME/prompts.log.
// FAKE_KEEP_REAL: fases que corren de verdad; el resto son falsas y solo dejan ejecuciones.txt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryFn } from "../../src/runner/types.ts";
import { simQuery, type SimScript } from "../helpers/sim-sdk.ts";
export { phases } from "./fake-phases.ts";

const scriptsFile = process.env.FAKE_SIM_SCRIPTS ?? "";
const counter = `${scriptsFile}.siguiente`;

function nextScript(): SimScript {
  const scripts = JSON.parse(readFileSync(scriptsFile, "utf8")) as SimScript[];
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  const script = scripts[Math.min(n, scripts.length - 1)];
  if (script === undefined) throw new Error("FAKE_SIM_SCRIPTS sin guiones");
  return script;
}

export const query: QueryFn = (params) => {
  appendFileSync(join(process.env.HOME ?? "/tmp", "prompts.log"), `${params.prompt}\n---\n`);
  return simQuery(() => nextScript()).query(params);
};
