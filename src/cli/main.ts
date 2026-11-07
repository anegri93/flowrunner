// Punto de entrada del CLI. Cada comando acepta --json; la salida JSON es lo que lee la skill.
import { parseArgs } from "node:util";
import { checkFeature, describeCheckedFeature } from "./feature-check.ts";
import { processIo, reportError, UserError, type Io } from "./output.ts";

const USAGE = `uso: flowrunner <comando> [--json]

  feature check <archivo>   valida una feature, su proyecto y la config del repo`;

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = processIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: { json: { type: "boolean", default: false } },
  });
  const json = values.json === true;
  try {
    const [command, sub, ...rest] = positionals;
    if (command === "feature" && sub === "check") {
      const [file] = rest;
      if (file === undefined) throw new UserError("falta el archivo de la feature", USAGE);
      const checked = checkFeature(file, env);
      io.out(json ? JSON.stringify({ ok: true, ...checked }) : describeCheckedFeature(checked));
      return 0;
    }
    throw new UserError(
      command === undefined ? "falta el comando" : `comando desconocido: ${positionals.join(" ")}`,
      USAGE,
    );
  } catch (error) {
    return Promise.resolve(reportError(error, json, io));
  }
}
