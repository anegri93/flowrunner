// `flowrunner orca install`: carga en Orca el plugin de orca/ de este flowrunner, esté donde esté
// clonado. Si el repo se muda, volver a correrlo apunta Orca a la carpeta nueva.
import { join } from "node:path";
import { runProc } from "../proc/proc.ts";
import { UserError } from "./output.ts";

export const ORCA_PLUGIN_DIR = join(import.meta.dirname, "..", "..", "orca");
/** El CLI que trae Orca. `ORCA` lo cambia, como en `pnpm orca:test`. */
const ORCA_CLI = "/Applications/Orca.app/Contents/Resources/bin/orca";

/** Orca decide si hace falta aprobarlo e imprime el fingerprint: flowrunner nunca aprueba solo. */
export async function installOrcaPlugin(env: NodeJS.ProcessEnv, approve: string | undefined) {
  const orca = env.ORCA ?? ORCA_CLI;
  const args = ["plugin", "dev", "load", ORCA_PLUGIN_DIR];
  if (approve !== undefined) args.push("--approve", approve);
  const result = await runProc(orca, args, { cwd: ORCA_PLUGIN_DIR, env, timeoutMs: 60_000 });
  if (result.code === 127) {
    throw new UserError(
      `no encontré el CLI de Orca en ${orca}: instalá Orca, o pasá su ruta en ORCA`,
    );
  }
  return {
    ok: result.code === 0,
    plugin: ORCA_PLUGIN_DIR,
    salida: `${result.stdout}${result.stderr}`.trim(),
  };
}
