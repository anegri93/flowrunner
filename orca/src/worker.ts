// El worker del plugin: corre el CLI de flowrunner y le contesta al panel. Orca lo transpila al
// cargarlo, sin paso de build. No guarda estado: cada pedido lee los runs de nuevo.
import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { OrcaWorkerApi } from "orca/worker";
import type { Openable, Outcome, Snapshot } from "./protocol";
import {
  isClosed,
  parseWatch,
  PHASES,
  planMarkdown,
  SESSION_NAME,
  stepsMarkdown,
  type Decision,
} from "./runs";

const TIMEOUT_MS = 20_000;
/** El CLI de Orca, que abre un archivo como pestaña: ningún método del host abre un archivo de afuera. */
const orcaCli = () => process.env.ORCA_CLI ?? "/Applications/Orca.app/Contents/Resources/bin/orca";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNIT_ID = /^ST-\d+$/;
const MAX_MOTIVO = 2_000;

/**
 * El comando de flowrunner, de la config del plugin. Corre en un shell de login para tener el PATH
 * de la persona: Orca no lanza el worker desde una terminal, y `flowrunner` vive en ~/.local/bin.
 */
async function command(orca: OrcaWorkerApi): Promise<string> {
  const settings = await orca.settings.get();
  const value = settings.comando;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "flowrunner";
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Variables que Orca le pone a su host de plugins y que no tienen que llegar a flowrunner. */
const ORCA_ONLY = ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"];

/**
 * El entorno de los comandos que corre el worker. Orca lanza su host de plugins solo con HOME, PATH y
 * TMPDIR: sin USER, Claude Code no encuentra la sesión del Keychain, y un run aprobado desde el panel
 * fallaba con «Claude rechazó la credencial de la sesión». Se completa con el usuario y su shell, y
 * se sacan las variables propias de Orca.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const user = userInfo();
  const out: NodeJS.ProcessEnv = {
    ...env,
    USER: env.USER ?? user.username,
    LOGNAME: env.LOGNAME ?? user.username,
    SHELL: env.SHELL ?? user.shell ?? "/bin/zsh",
  };
  for (const name of ORCA_ONLY) Reflect.deleteProperty(out, name);
  return out;
}

interface Proc {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(script: string): Promise<Proc> {
  const env = childEnv(process.env);
  return new Promise((resolve) => {
    execFile(
      env.SHELL ?? "/bin/zsh",
      ["-lc", script],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });
}

const lastLines = (text: string) => text.trim().split("\n").slice(-3).join("\n");

async function ok(script: string): Promise<string> {
  const proc = await run(script);
  if (proc.code !== 0) throw new Error(lastLines(proc.stderr || proc.stdout));
  return proc.stdout;
}

/** El id tiene que ser el de un run, nunca algo que el shell interprete. */
function runId(id: unknown): string {
  if (typeof id !== "string" || !RUN_ID.test(id))
    throw new Error(`id de run inválido: ${String(id)}`);
  return id;
}

/** La decisión como argumentos de un comando fijo de flowrunner; nada del panel llega sin validar. */
export function decisionArgs(id: string, decision: Decision): string {
  switch (decision.accion) {
    case "aprobar":
      return decision.aceptoCambios === true
        ? `approve ${quote(id)} --acepto-cambios`
        : `approve ${quote(id)}`;
    case "cambios": {
      const motivo = typeof decision.motivo === "string" ? decision.motivo.trim() : "";
      if (motivo === "") throw new Error("falta el motivo de los cambios");
      if (motivo.length > MAX_MOTIVO) throw new Error("el motivo es demasiado largo");
      return `changes ${quote(id)} ${quote(motivo)}`;
    }
    case "reanudar":
      return `resume ${quote(id)}`;
    case "rehacer":
      if (!PHASES.includes(decision.desde))
        throw new Error(`fase inválida: ${String(decision.desde)}`);
      return `rerun ${quote(id)} --desde ${decision.desde}`;
    case "aprender":
      return `learn ${quote(id)}`;
    case "abortar":
      return `abort ${quote(id)}`;
    default:
      throw new Error("decisión desconocida");
  }
}

/** Lo que contestó flowrunner a una decisión, con `--json`: lo que hizo, o el error y cómo seguir. */
function outcomeOf(proc: Proc): Outcome {
  try {
    const data = JSON.parse(proc.stdout) as {
      ok?: boolean;
      accion?: string;
      /** Lo que contesta `learn`: «la PR sigue abierta», «quedó cerrado». */
      resultado?: string;
      error?: { message?: string; next?: string };
    };
    if (data.ok === true) return { ok: true, mensaje: data.accion ?? data.resultado ?? "hecho" };
    const next = data.error?.next === undefined ? "" : `\nPara seguir: ${data.error.next}`;
    return { ok: false, mensaje: `${data.error?.message ?? "flowrunner no pudo"}${next}` };
  } catch {
    return {
      ok: false,
      mensaje: lastLines(proc.stderr || proc.stdout) || "flowrunner no contestó",
    };
  }
}

/** El `.git` común de un repo o de cualquiera de sus worktrees: lo que los hace el mismo proyecto. */
async function gitCommonDir(path: string): Promise<string | undefined> {
  const proc = await exec("git", [
    "-C",
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (proc.code !== 0) return undefined;
  try {
    return realpathSync(proc.stdout.trim());
  } catch {
    return undefined;
  }
}

const branchName = (ref: string | null) => (ref ?? "").replace(/^refs\/heads\//, "");

/**
 * La ruta del workspace enfocado en Orca. `readContext` no la da: se saca de sus terminales, porque el
 * CLI de Orca dice en qué worktree está cada una. Sin terminales, por su nombre y su rama, si un solo
 * workspace coincide.
 */
async function focusedPath(orca: OrcaWorkerApi): Promise<string | undefined> {
  const context = await orca.host.call("workspace.readContext");
  if (context === null) return undefined;
  if (context.terminals.length > 0) {
    const proc = await exec(orcaCli(), ["terminal", "list", "--json"]);
    try {
      const list = (
        JSON.parse(proc.stdout) as {
          result?: { terminals?: { handle?: unknown; ptyId?: unknown; worktreePath?: unknown }[] };
        }
      ).result?.terminals;
      const ids = new Set(context.terminals.map((t) => t.id));
      const mine = list?.find(
        (t) =>
          typeof t.worktreePath === "string" &&
          ((typeof t.handle === "string" && ids.has(t.handle)) ||
            (typeof t.ptyId === "string" && ids.has(t.ptyId))),
      );
      if (typeof mine?.worktreePath === "string") return mine.worktreePath;
    } catch {
      // el CLI no contestó JSON: queda buscar por nombre
    }
  }
  const { workspaces } = await orca.host.call("workspace.list");
  const same = workspaces.filter(
    (w) => w.name === context.displayName && branchName(w.branch) === branchName(context.branch),
  );
  return same.length === 1 ? same[0]?.path : undefined;
}

/**
 * El proyecto del workspace enfocado en Orca, como lo siguen el explorador y los agentes. Sin uno
 * enfocado, sin el permiso `workspace:read` o si Orca no contesta, ninguno: el panel muestra todos.
 */
async function activeProject(
  orca: OrcaWorkerApi,
): Promise<{ commonDir: string; nombre: string } | undefined> {
  let path: string | undefined;
  try {
    path = await focusedPath(orca);
  } catch {
    return undefined;
  }
  if (path === undefined) return undefined;
  const commonDir = await gitCommonDir(path);
  if (commonDir === undefined) return undefined;
  // `.../mango-portal-colaborador/.git` se llama como su repo.
  const nombre =
    basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(commonDir);
  return { commonDir, nombre };
}

function exec(file: string, args: readonly string[]): Promise<Proc> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, env: childEnv(process.env) },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });
}

/**
 * Dónde guardar lo que se abre: en el `.git` del repo del run, que git no versiona, para que Orca lo
 * abra como pestaña en el mismo proyecto sin ensuciar el repo. Orca solo abre archivos de un proyecto
 * suyo.
 */
async function viewDir(repo: string, id: string): Promise<string> {
  const proc = await exec("git", ["-C", repo, "rev-parse", "--absolute-git-dir"]);
  const gitDir = proc.stdout.trim();
  // git devuelve la ruta real (en macOS, /var es un link a /private/var); el archivo va con la ruta
  // del repo como la conoce Orca, o no lo reconoce como parte del proyecto.
  const inside = relative(realpathSync(repo), gitDir);
  if (proc.code !== 0 || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`no encontré el .git de ${repo} dentro del repo`);
  }
  return join(repo, inside, "flowrunner", id);
}

export default function activate(orca: OrcaWorkerApi): void {
  const watch = async () => parseWatch(await ok(`${await command(orca)} watch --json --cerrados`));

  orca.panels.handle("flowrunner.runs", async (): Promise<Snapshot> => {
    const at = Date.now();
    try {
      const all = await watch();
      const active = await activeProject(orca);
      const mine: typeof all = [];
      if (active === undefined) mine.push(...all);
      else for (const r of all) if ((await gitCommonDir(r.repo)) === active.commonDir) mine.push(r);
      const runs = mine.filter((r) => !isClosed(r));
      const cerrados = mine.filter(isClosed);
      if (active === undefined) return { runs, cerrados, at };
      const otros = all.filter((r) => !isClosed(r)).length - runs.length;
      return { runs, cerrados, at, proyecto: active.nombre, otros };
    } catch (error) {
      return { runs: [], error: error instanceof Error ? error.message : String(error), at };
    }
  });

  orca.panels.handle("flowrunner.abrir", async ({ run: id, que }): Promise<Outcome> => {
    try {
      const runIdOk = runId(id);
      const what: Openable = que;
      if (what.tipo === "pasos" && !SESSION_NAME.test(what.sesion)) {
        throw new Error(`sesión inválida: ${String(what.sesion)}`);
      }
      if (what.tipo === "unidad" && !UNIT_ID.test(what.unidad)) {
        throw new Error(`sub-task inválida: ${String(what.unidad)}`);
      }
      if (what.tipo === "etapa" && !PHASES.some((p) => p === what.fase)) {
        throw new Error(`etapa inválida: ${String(what.fase)}`);
      }
      const flowrunner = await command(orca);
      // `status` sirve también para un run ya cerrado, que `watch` no lista.
      const status = JSON.parse(await ok(`${flowrunner} status ${quote(runIdOk)} --json`)) as {
        run?: { id?: unknown; clave?: unknown; repo?: unknown };
      };
      const { id: foundId, clave, repo } = status.run ?? {};
      if (typeof foundId !== "string" || typeof clave !== "string" || typeof repo !== "string") {
        throw new Error(`flowrunner no devolvió el repo del run ${runIdOk}`);
      }
      const run = { id: foundId, clave, repo };
      const dir = await viewDir(run.repo, run.id);
      mkdirSync(dir, { recursive: true });
      let file: string;
      if (what.tipo === "pasos") {
        const data = JSON.parse(
          await ok(`${flowrunner} report ${quote(run.id)} --sesion ${quote(what.sesion)} --json`),
        ) as { texto?: unknown };
        file = join(dir, `${what.sesion}.md`);
        writeFileSync(
          file,
          stepsMarkdown(run.clave, what.sesion, typeof data.texto === "string" ? data.texto : ""),
        );
      } else if (what.tipo === "unidad") {
        // flowrunner arma el markdown: qué tenía que hacer, qué dice que hizo y el diff.
        const data = JSON.parse(
          await ok(`${flowrunner} report ${quote(run.id)} --unidad ${quote(what.unidad)} --json`),
        ) as { texto?: unknown };
        file = join(dir, `${what.unidad}.md`);
        writeFileSync(file, typeof data.texto === "string" ? data.texto : "");
      } else if (what.tipo === "etapa") {
        const data = JSON.parse(
          await ok(`${flowrunner} report ${quote(run.id)} --fase ${what.fase} --json`),
        ) as { texto?: unknown };
        file = join(dir, `etapa-${what.fase}.md`);
        writeFileSync(file, typeof data.texto === "string" ? data.texto : "");
      } else if (what.tipo === "informe") {
        const data = JSON.parse(await ok(`${flowrunner} report ${quote(run.id)} --json`)) as {
          informe?: unknown;
        };
        file = join(dir, "informe.md");
        writeFileSync(file, typeof data.informe === "string" ? data.informe : "");
      } else {
        const data: unknown = JSON.parse(await ok(`${flowrunner} plan ${quote(run.id)} --json`));
        file = join(dir, "plan.md");
        writeFileSync(file, planMarkdown(run.clave, data));
      }
      const opened = await exec(orcaCli(), [
        "file",
        "open",
        file,
        "--worktree",
        `path:${run.repo}`,
        "--focus",
      ]);
      if (opened.code !== 0)
        throw new Error(`Orca no abrió el archivo: ${lastLines(opened.stderr)}`);
      return { ok: true, mensaje: "abierto" };
    } catch (error) {
      return { ok: false, mensaje: error instanceof Error ? error.message : String(error) };
    }
  });

  orca.panels.handle("flowrunner.decidir", async ({ run: id, decision }) => {
    let args: string;
    try {
      args = decisionArgs(runId(id), decision);
    } catch (error) {
      return { ok: false, mensaje: error instanceof Error ? error.message : String(error) };
    }
    orca.log(`decisión: ${args}`);
    return outcomeOf(await run(`${await command(orca)} ${args} --json`));
  });
}
