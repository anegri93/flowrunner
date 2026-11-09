// El entorno de desarrollo donde la fase probar usa la feature: se levanta desde el worktree de la
// feature con el comando del repo y se baja al terminar. Ver ADR 0016.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { descendants, killAll } from "../agent/procesos.ts";
import type { RepoConfig } from "../config/schemas.ts";
import { repoNode } from "../proc/node.ts";
import { copyEnvFiles } from "../phases/env-files.ts";
import { cleanEnv, runProc } from "../proc/proc.ts";

export type ProbarConfig = NonNullable<RepoConfig["probar"]>;

export interface Entorno {
  /** Baja lo levantado. Devuelve las URLs que siguen respondiendo después de bajarlo. */
  readonly bajar: () => Promise<string[]>;
}

export type Levantado =
  | { readonly tipo: "ok"; readonly entorno: Entorno }
  | { readonly tipo: "falla"; readonly motivo: string };

const BAJAR_TIMEOUT_MS = 120_000;

/** Responde algo, el código que sea: hay un servidor escuchando. */
export async function responds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

const logTail = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-30).join("\n") : "";

/**
 * Copia los archivos de fuera de git, levanta el entorno y espera a que esté listo: que `levantar`
 * termine bien, o que siga corriendo si la config dice `sigue_corriendo`, y que respondan todas sus
 * URLs. Si una URL ya responde antes de levantar, es otro entorno, por ejemplo el de la persona:
 * probar contra él daría verde con un código que no es el de la feature.
 */
export async function levantarEntorno(opts: {
  readonly worktree: string;
  readonly repo: string;
  readonly probar: ProbarConfig;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<Levantado> {
  const { worktree, repo, probar, log } = opts;
  const urls = Object.values(probar.urls);
  const busy = [];
  for (const url of urls) if (await responds(url)) busy.push(url);
  if (busy.length > 0) {
    return {
      tipo: "falla",
      motivo: `ya hay algo respondiendo en ${busy.join(", ")}, antes de levantar el entorno de la feature: probar contra eso no probaría la feature. Bajalo y seguí con el comando de abajo`,
    };
  }
  // Los secretos copiados no quedan en el worktree después de probar: revisar y las sub-tasks leen ahí.
  const copies = copyEnvFiles(repo, worktree, probar.env_files);
  if (!copies.ok) return { tipo: "falla", motivo: copies.motivo };
  const removeCopies = copies.remove;
  const node = await repoNode(worktree, opts.env);
  if (node.tipo === "falta") {
    removeCopies();
    return { tipo: "falla", motivo: node.motivo };
  }
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  // En su propio grupo: al bajar, el grupo entero cae aunque `levantar` no termine.
  const child = spawn("sh", ["-c", probar.levantar], {
    cwd: worktree,
    env: cleanEnv(node.env),
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  let exit: number | null | undefined;
  child.on("exit", (code) => (exit = code));
  child.on("error", () => (exit = -1));
  const env = node.env;
  const entorno: Entorno = {
    bajar: async () => {
      if (probar.bajar !== undefined) {
        await runProc("sh", ["-c", probar.bajar], {
          cwd: worktree,
          env,
          timeoutMs: BAJAR_TIMEOUT_MS,
        });
      }
      if (child.pid !== undefined) {
        killAll(descendants(child.pid).map((p) => p.pid));
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // el grupo ya no existe
        }
      }
      removeCopies();
      const alive = [];
      for (const url of urls) if (await responds(url)) alive.push(url);
      return alive;
    },
  };
  const deadline = Date.now() + probar.espera_segundos * 1_000;
  let up: boolean[] = [];
  while (Date.now() < deadline) {
    if (exit !== undefined && exit !== 0) {
      await entorno.bajar();
      return {
        tipo: "falla",
        motivo: `\`${probar.levantar}\` salió ${String(exit)}:\n${logTail(log)}`,
      };
    }
    up = await Promise.all(urls.map(responds));
    if (up.every(Boolean) && (exit === 0 || probar.sigue_corriendo)) return { tipo: "ok", entorno };
    await sleep(1_000);
  }
  await entorno.bajar();
  const down = urls.filter((_, i) => up[i] !== true);
  const motivo =
    down.length > 0
      ? `el entorno no respondió en ${String(probar.espera_segundos)} s (${down.join(", ")})`
      : `\`${probar.levantar}\` no terminó en ${String(probar.espera_segundos)} s; si queda corriendo, como un \`pnpm dev\`, poné \`sigue_corriendo: true\` en la config de probar`;
  return { tipo: "falla", motivo: `${motivo}:\n${logTail(log)}` };
}
