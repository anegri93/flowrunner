// Ayudas para los tests que lanzan runs con el CLI real y fases falsas.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateOf, type RunState } from "../../src/engine/engine.ts";
import { lugarDe, lugaresDir, type Lugar } from "../../src/store/lugares.ts";
import { readLog } from "../../src/store/run-log.ts";
import { homeWith, runCli } from "./cli.ts";
import { repoWith, tempDir } from "./git.ts";

export const FAKE_PHASES = join(import.meta.dirname, "..", "hooks", "fake-phases.ts");

export const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Un administrador descarga los pedidos como CSV.

## Criterios
- AC-1: GET /pedidos.csv devuelve text/csv.
`;

export interface World {
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly feature: string;
}

export function world(
  extraEnv: Record<string, string> = {},
  files: Record<string, string> = {},
): World {
  const repo = repoWith({
    ".flowrunner/config.yaml": 'setup: "true"\ntests_globs: [tests/**]\n',
    "src/index.ts": "export {};\n",
    ...files,
  });
  const env: NodeJS.ProcessEnv = {
    ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${repo} }\n`),
    FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
    ...extraEnv,
  };
  const feature = join(tempDir(), "SHOP-214.md");
  writeFileSync(feature, FEATURE);
  return { repo, env, home: join(env.HOME ?? "", ".flowrunner"), feature };
}

export function launch(w: World): string {
  const result = runCli(["run", w.feature, "--json"], w.env);
  if (result.status !== 0) throw new Error(`run falló: ${result.stdout}${result.stderr}`);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

export function runDir(w: Pick<World, "home">, id: string): string {
  return join(w.home, "runs", id);
}

export function stateNow(w: World, id: string): RunState {
  return stateOf(readLog(runDir(w, id)).events);
}

export function executions(w: Pick<World, "home">, id: string): string[] {
  try {
    return readFileSync(join(runDir(w, id), "ejecuciones.txt"), "utf8")
      .trim()
      .split("\n");
  } catch {
    return [];
  }
}

/** El lugar de un run del proyecto, o el de cualquiera si no se dice cuál. */
export function slotOf(w: Pick<World, "home">, id?: string): Lugar | undefined {
  if (id !== undefined) return lugarDe(w.home, "acme-api", id);
  const dir = lugaresDir(w.home, "acme-api");
  if (!existsSync(dir)) return undefined;
  const first = readdirSync(dir).find((e) => e.endsWith(".json"));
  return first === undefined ? undefined : lugarDe(w.home, "acme-api", first.slice(0, -5));
}

/** El pid del proceso que tiene el lugar: el del run, o el de cualquiera. */
export function lockPid(w: Pick<World, "home">, id?: string): number | undefined {
  return slotOf(w, id)?.pid;
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  ms = 30_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error(`timeout esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
