// El Node que pide el repo en `.nvmrc` o `.node-version`. flowrunner corre desde launchd con el Node
// del PATH de la persona, que puede no ser el del repo: en mango-portal-colaborador el job usaba 25 y
// el repo fija 22 porque en 24 sus e2e crashean a veces, y verify daba rojos que no eran del código.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { runProc } from "./proc.ts";

export type RepoNode =
  /** El entorno a usar: el mismo si el repo no pide nada o el PATH ya trae el que pide. */
  | { readonly tipo: "ok"; readonly env: NodeJS.ProcessEnv }
  | { readonly tipo: "falta"; readonly env: NodeJS.ProcessEnv; readonly motivo: string };

const FILES = [".nvmrc", ".node-version"] as const;

/**
 * La versión que pide el repo, como `22` o `22.13.1`, y de qué archivo salió. Undefined si no pide
 * ninguna o pide un alias (`lts/*`, `node`). ponytail: los alias no se resuelven; resolverlos pide
 * saber qué es LTS hoy, y ningún repo de los que corren lo usa.
 */
export function nodeSpec(
  repo: string,
): { readonly version: string; readonly file: string } | undefined {
  for (const file of FILES) {
    const path = join(repo, file);
    if (!existsSync(path)) continue;
    const version = readFileSync(path, "utf8").trim().replace(/^v/, "");
    return /^\d+(\.\d+){0,2}$/.test(version) ? { version, file } : undefined;
  }
  return undefined;
}

/** Si `version` (`22.13.1`) cumple lo que pide `spec` (`22`, `22.13` o `22.13.1`). */
export function satisfies(spec: string, version: string): boolean {
  const want = spec.split(".");
  const have = version.replace(/^v/, "").split(".");
  return want.every((part, i) => part === have[i]);
}

const compare = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** Las carpetas `bin` de cada Node que instalaron nvm, fnm y volta, con su versión. */
function installed(env: NodeJS.ProcessEnv): { version: string; bin: string }[] {
  const home = env.HOME ?? homedir();
  const managers: [string, (name: string) => string][] = [
    [join(env.NVM_DIR ?? join(home, ".nvm"), "versions", "node"), (v) => join(v, "bin")],
    [
      join(env.FNM_DIR ?? join(home, "Library", "Application Support", "fnm"), "node-versions"),
      (v) => join(v, "installation", "bin"),
    ],
    [join(home, ".local", "share", "fnm", "node-versions"), (v) => join(v, "installation", "bin")],
    [join(env.VOLTA_HOME ?? join(home, ".volta"), "tools", "image", "node"), (v) => join(v, "bin")],
  ];
  const found: { version: string; bin: string }[] = [];
  for (const [dir, binOf] of managers) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const version = name.replace(/^v/, "");
      const bin = join(dir, binOf(name));
      if (/^\d+\.\d+\.\d+$/.test(version) && existsSync(join(bin, "node")))
        found.push({ version, bin });
    }
  }
  return found;
}

async function versionOf(env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const out = await runProc("node", ["-v"], { cwd, env, timeoutMs: 10_000 });
  return out.code === 0 ? out.stdout.trim().replace(/^v/, "") : undefined;
}

/**
 * El entorno con el Node que pide el repo primero en el PATH: el más nuevo instalado que cumpla.
 * Si no hay ninguno, devuelve el mismo entorno y el motivo, para que verify no corra con otro.
 */
export async function repoNode(repo: string, env: NodeJS.ProcessEnv): Promise<RepoNode> {
  const spec = nodeSpec(repo);
  if (spec === undefined) return { tipo: "ok", env };
  const current = await versionOf(env, repo);
  if (current !== undefined && satisfies(spec.version, current)) return { tipo: "ok", env };
  const candidates = [
    ...installed(env),
    // Homebrew instala `node@22` sin la versión completa en la ruta: se le pregunta.
    ...(await Promise.all(
      (env.HOMEBREW_PREFIX === undefined
        ? ["/opt/homebrew", "/usr/local"]
        : [env.HOMEBREW_PREFIX]
      ).map(async (prefix) => {
        const bin = join(prefix, "opt", `node@${spec.version.split(".")[0] ?? ""}`, "bin");
        if (!existsSync(join(bin, "node"))) return undefined;
        const version = await versionOf(
          { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ""}` },
          repo,
        );
        return version === undefined ? undefined : { version, bin };
      }),
    )),
  ].filter((c): c is { version: string; bin: string } => c !== undefined);
  const best = candidates
    .filter((c) => satisfies(spec.version, c.version))
    .sort((a, b) => compare(b.version, a.version))[0];
  if (best === undefined) {
    return {
      tipo: "falta",
      env,
      motivo: `el repo pide Node ${spec.version} en ${spec.file} y no está instalado (el PATH trae ${current ?? "ninguno"}): instalalo, por ejemplo con \`nvm install ${spec.version}\``,
    };
  }
  return { tipo: "ok", env: { ...env, PATH: `${best.bin}${delimiter}${env.PATH ?? ""}` } };
}
