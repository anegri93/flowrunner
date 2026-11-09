// Las herramientas con las que la fase probar usa la feature: un navegador que graba video, un
// cliente HTTP para las APIs y las fallas que el repo declaró que se pueden provocar. Navegador y HTTP
// solo llegan a las URLs del entorno, y todo lo que hacen las tres queda en la carpeta de pruebas del
// run para que la persona lo revise.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { descendants, killAll } from "../agent/procesos.ts";
import { cleanEnv, runShell, tail } from "../proc/proc.ts";
import type { ProbarConfig } from "./entorno.ts";
import { GUION_DEL_VIDEO } from "./guion-del-video.ts";

/** Las del navegador que la sesión puede usar. Afuera: correr código en el host y subir archivos. */
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_wait_for",
  "browser_take_screenshot",
  "browser_tabs",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_handle_dialog",
  "browser_resize",
  "browser_find",
  "browser_evaluate",
  "browser_close",
].map((name) => `mcp__navegador__${name}`);
export const HTTP_TOOL = "mcp__http__request";
export const FALLA_TOOLS = ["mcp__fallas__simular", "mcp__fallas__restaurar"];

const FALLA_TIMEOUT_MS = 60_000;

export interface Fallas {
  readonly config: McpServerConfig;
  readonly simular: (nombre: string) => Promise<{ ok: boolean; text: string }>;
  readonly restaurar: (nombre: string) => Promise<{ ok: boolean; text: string }>;
  /** Restaura las que quedaron puestas. Devuelve las que no se pudieron restaurar, con el motivo. */
  readonly restaurarTodas: () => Promise<string[]>;
}

/**
 * Las fallas que declaró el repo, como herramientas: el agente elige el nombre, nunca el comando, así
 * que sigue sin poder correr nada que el repo no haya escrito (ADR 0016). Cada una queda en `log`.
 */
export function fallasServer(
  fallas: ProbarConfig["fallas"],
  opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly log: string },
): Fallas {
  const puestas = new Set<string>();
  const nombres = Object.keys(fallas);
  const correr = async (nombre: string, que: "simular" | "restaurar") => {
    const falla = fallas[nombre];
    if (falla === undefined) {
      return {
        ok: false,
        text: `no hay una falla "${nombre}": las que declaró el repo son ${nombres.length === 0 ? "ninguna" : nombres.join(", ")}`,
      };
    }
    const result = await runShell(falla[que], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: FALLA_TIMEOUT_MS,
    });
    const ok = result.code === 0 && !result.timedOut;
    mkdirSync(dirname(opts.log), { recursive: true });
    appendFileSync(
      opts.log,
      `## ${que} ${nombre}\n\n\`${falla[que]}\` → ${ok ? "ok" : `salió ${String(result.code)}`}\n\n`,
    );
    if (ok && que === "simular") puestas.add(nombre);
    if (ok && que === "restaurar") puestas.delete(nombre);
    return {
      ok,
      text: ok
        ? `${que === "simular" ? "puesta" : "restaurada"}: ${nombre} (${falla.que})`
        : `no se pudo ${que} ${nombre}:\n${tail(result, 10)}`,
    };
  };
  const lista = nombres.map((n) => `- ${n}: ${fallas[n]?.que ?? ""}`).join("\n");
  const nombre = z.string().describe("El nombre de la falla, uno de los declarados");
  const config = createSdkMcpServer({
    name: "fallas",
    tools: [
      tool(
        "simular",
        `Provoca una falla que el repo declaró, para probar el camino de error de un criterio. Las que hay:\n${lista}`,
        { nombre },
        async ({ nombre: n }) => {
          const out = await correr(n, "simular");
          return { content: [{ type: "text", text: out.text }], isError: !out.ok };
        },
      ),
      tool(
        "restaurar",
        "Saca una falla que pusiste con simular. Restaurala apenas terminás de probar ese criterio.",
        { nombre },
        async ({ nombre: n }) => {
          const out = await correr(n, "restaurar");
          return { content: [{ type: "text", text: out.text }], isError: !out.ok };
        },
      ),
    ],
  });
  return {
    config,
    simular: (n) => correr(n, "simular"),
    restaurar: (n) => correr(n, "restaurar"),
    restaurarTodas: async () => {
      const fallidas: string[] = [];
      for (const n of [...puestas]) {
        const out = await correr(n, "restaurar");
        if (!out.ok) fallidas.push(out.text);
      }
      return fallidas;
    },
  };
}

const MAX_BODY_CHARS = 20_000;
const HTTP_TIMEOUT_MS = 30_000;
/** Las cabeceras cuyo valor no se escribe en el log. */
const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

const shown = (headers: Iterable<[string, string]>) =>
  [...headers].map(([k, v]) => `${k}: ${SECRET_HEADERS.test(k) ? "***" : v}`).join("\n");

/**
 * Un pedido HTTP a una de las URLs del entorno. Cada pedido y su respuesta se agregan a `log`, con
 * las cabeceras secretas tapadas.
 */
export async function httpRequest(
  args: {
    readonly method: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | undefined;
  },
  allowed: readonly string[],
  log: string,
): Promise<{ readonly ok: boolean; readonly text: string }> {
  const target = origin(args.url);
  if (target === undefined || !allowed.includes(target)) {
    return {
      ok: false,
      text: `${args.url} está fuera del entorno: solo se puede pedir a ${allowed.join(", ")}`,
    };
  }
  const method = args.method.toUpperCase();
  mkdirSync(dirname(log), { recursive: true });
  const entry = [
    `## ${method} ${args.url}`,
    "",
    ...(args.headers === undefined ? [] : ["```", shown(Object.entries(args.headers)), "```", ""]),
    ...(args.body === undefined ? [] : ["```", args.body, "```", ""]),
  ];
  let text: string;
  try {
    const res = await fetch(args.url, {
      method,
      ...(args.headers === undefined ? {} : { headers: args.headers }),
      ...(args.body === undefined ? {} : { body: args.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const raw = await res.text();
    const body = raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS)}\n… (cortado)` : raw;
    text = `${String(res.status)} ${res.statusText}\n${shown(res.headers.entries())}\n\n${body}`;
  } catch (error) {
    text = `sin respuesta: ${error instanceof Error ? error.message : String(error)}`;
  }
  appendFileSync(log, [...entry, "→", "", "```", text, "```", "", ""].join("\n"));
  return { ok: true, text };
}

/** El servidor MCP en proceso con `request`, para la sesión. */
export function httpServer(allowed: readonly string[], log: string): McpServerConfig {
  return createSdkMcpServer({
    name: "http",
    tools: [
      tool(
        "request",
        `Hace un pedido HTTP a la API del entorno (${allowed.join(", ")}) y devuelve el estado, las cabeceras y el cuerpo. Queda registrado como evidencia.`,
        {
          method: z.string().describe("GET, POST, PUT, PATCH, DELETE"),
          url: z.string().describe("La URL completa"),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional().describe("El cuerpo, por ejemplo un JSON"),
        },
        async (args) => {
          const out = await httpRequest(args, allowed, log);
          return { content: [{ type: "text", text: out.text }], isError: !out.ok };
        },
      ),
    ],
  });
}

export interface Navegador {
  readonly config: McpServerConfig;
  readonly stop: () => Promise<void>;
}

/** Un puerto libre de la máquina. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const PLAYWRIGHT_CLI = join(
  dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")),
  "cli.js",
);
const START_TIMEOUT_MS = 30_000;

/**
 * Playwright MCP por HTTP, con Chrome, que solo llega a `allowed` y graba en video cada página en
 * `dir/video`. Sin ventana salvo `visible`. Cada página carga el guion del video: cursor, scroll
 * centrado y las placas que pone el agente. Lo lanza y lo baja flowrunner, no el CLI de Claude: así el
 * navegador termina de escribir el video aunque la sesión se corte.
 */
export async function startBrowser(
  dir: string,
  allowed: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { readonly visible?: boolean } = {},
): Promise<Navegador> {
  mkdirSync(join(dir, "video"), { recursive: true });
  const guion = join(dir, "guion-del-video.js");
  writeFileSync(guion, GUION_DEL_VIDEO);
  const configFile = join(dir, "navegador.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      browser: {
        browserName: "chromium",
        // ponytail: el Chrome instalado; si hace falta otro, que sea un campo de `probar`.
        // slowMo: cada acción espera un poco, para que en el video se vea qué se tocó antes del cambio.
        launchOptions: { channel: "chrome", headless: opts.visible !== true, slowMo: 600 },
        initScript: [guion],
        isolated: true,
        contextOptions: {
          recordVideo: { dir: join(dir, "video"), size: { width: 1280, height: 720 } },
          viewport: { width: 1280, height: 720 },
        },
      },
      outputDir: dir,
      network: { allowedOrigins: [...allowed] },
    }),
  );
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [PLAYWRIGHT_CLI, "--config", configFile, "--port", String(port)],
    { cwd: dir, env: cleanEnv(env), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const listening = new Promise<boolean>((resolve) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.includes("Listening on")) resolve(true);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", () => resolve(false));
  });
  const ready = await Promise.race([listening, sleep(START_TIMEOUT_MS).then(() => false)]);
  let gone = false;
  const exited = new Promise<void>((r) =>
    child.once("exit", () => {
      gone = true;
      r();
    }),
  );
  const stop = async () => {
    if (gone) return;
    // Los de Chrome, antes de que el servidor salga y dejen de colgar de él.
    const browser = child.pid === undefined ? [] : descendants(child.pid).map((p) => p.pid);
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
    child.kill("SIGKILL"); // si ya salió, no hace nada
    killAll(browser);
  };
  if (!ready) {
    await stop();
    throw new Error(`el navegador no arrancó:\n${output.trim().split("\n").slice(-10).join("\n")}`);
  }
  return { config: { type: "http", url: `http://localhost:${String(port)}/mcp` }, stop };
}
