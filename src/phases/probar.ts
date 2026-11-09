// Probar: con el entorno de desarrollo levantado desde la feature, una sesión usa lo implementado como
// lo haría una persona, por la API y por el navegador, y deja la evidencia en el run: el log de cada
// pedido y el video de cada navegación. Una falla devuelve su sub-task a implementar; un criterio sin
// probar detiene el run hasta que la persona decide. Ver ADR 0016 y 0017.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runSession } from "../agent/session.ts";
import { loadRepoConfig } from "../config/load.ts";
import { decisionSchema } from "../gates/plan.ts";
import { levantarEntorno } from "../probar/entorno.ts";
import {
  BROWSER_TOOLS,
  FALLA_TOOLS,
  fallasServer,
  HTTP_TOOL,
  httpServer,
  startBrowser,
  type Navegador,
} from "../probar/herramientas.ts";
import { featureText, render } from "../prompts/render.ts";
import type { PhaseFn, RunPaths } from "../runner/types.ts";
import { tripwireHook } from "../tripwires/hook.ts";
import { featureWorktree, runFeature } from "./inputs.ts";
import { readPlan, sessionName } from "./planificar.ts";
import { reviewSchema } from "./revisar.ts";

export const pruebaSchema = z.object({
  criterio: z.string(),
  que: z.string().min(1),
  pasos: z.array(z.string().min(1)),
  resultado: z.enum(["ok", "falla", "no_probado"]),
  evidencia: z.string(),
  subtarea: z.string(),
});
export const probarSchema = z.object({
  pruebas: z.array(pruebaSchema),
  decisiones: z.array(decisionSchema),
});
export type Pruebas = z.infer<typeof probarSchema>;

export const PROBAR_TIMEOUT_MS = 40 * 60_000;
/** Cada entrada a probar deja su evidencia en su propia carpeta: `pruebas/probar-<n>`. */
export const PRUEBAS_DIR = "pruebas";

/** La carpeta de la última vez que corrió probar, o undefined si nunca corrió. */
export function lastTestDir(run: RunPaths): string | undefined {
  const root = join(run.dir, PRUEBAS_DIR);
  if (!existsSync(root)) return undefined;
  const last = readdirSync(root)
    .filter((d) => /^probar-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
    .at(-1);
  return last === undefined ? undefined : join(root, last);
}

/** Lo que dejó una corrida de probar: las pruebas, si llegó a devolverlas, y sus videos. */
export function readTests(dir: string): { pruebas: Pruebas | undefined; videos: string[] } {
  const file = join(dir, "pruebas.json");
  const parsed = existsSync(file)
    ? probarSchema.safeParse(JSON.parse(readFileSync(file, "utf8")))
    : undefined;
  const videoDir = join(dir, "video");
  const videos = existsSync(videoDir)
    ? readdirSync(videoDir)
        .filter((f) => f.endsWith(".webm"))
        .map((f) => join(videoDir, f))
    : [];
  return { pruebas: parsed?.success === true ? parsed.data : undefined, videos };
}

function reviewSteps(run: RunPaths): string {
  const file = join(run.dir, "review.json");
  if (!existsSync(file)) return "La revisión no dejó un paso a paso.";
  const review = reviewSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  const steps = review.success ? review.data.como_probar : [];
  return steps.length === 0
    ? "La revisión no dejó un paso a paso."
    : steps.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
}

export const probar: PhaseFn = async (ctx) => {
  const { run, deps, emit, action, state } = ctx;
  const worktree = featureWorktree(run);
  const config = loadRepoConfig(worktree);
  if (config.probar === undefined) {
    emit({
      tipo: "aviso",
      fase: "probar",
      texto:
        "probar se salteó: el repo no dice cómo levantar el entorno (`probar` en .flowrunner/config.yaml)",
    });
    return { tipo: "ok" };
  }
  const nombre = sessionName(run, "probar");
  const dir = join(run.dir, PRUEBAS_DIR, nombre);
  const up = await levantarEntorno({
    worktree,
    repo: state.repo,
    probar: config.probar,
    log: join(dir, "entorno.log"),
    env: deps.env,
  });
  if (up.tipo === "falla") return { tipo: "falla", clase: "entorno", motivo: up.motivo };
  const urls = [...Object.entries(config.probar.urls), ...Object.entries(config.probar.servicios)];
  const origins = [...new Set(urls.map(([, u]) => new URL(u).origin))];
  const plan = readPlan(run);
  const ids = plan.subtareas.map((t) => t.id);
  const declaradas = config.probar.fallas;
  const hayFallas = Object.keys(declaradas).length > 0;
  const fallas = fallasServer(declaradas, {
    cwd: worktree,
    env: deps.env,
    log: join(dir, "fallas.md"),
  });
  let browser: Navegador | undefined;
  try {
    try {
      browser = await startBrowser(dir, origins, deps.env, {
        visible: config.probar.navegador_visible,
      });
    } catch (error) {
      return {
        tipo: "falla",
        clase: "infra",
        motivo: error instanceof Error ? error.message : String(error),
      };
    }
    const result = await runSession(
      {
        fase: "probar",
        nombre,
        prompt: render("probar", {
          urls: urls.map(([name, url]) => `- ${name}: ${url}`).join("\n"),
          notas: config.probar.notas,
          fallas: hayFallas
            ? Object.entries(declaradas)
                .map(([n, f]) => `- \`${n}\`: ${f.que}`)
                .join("\n")
            : "El repo no declaró fallas: un criterio que pide provocar una no se puede probar acá.",
          subtareas: ids.join(", "),
          instruccion:
            action.instruccion === undefined
              ? ""
              : `# Atención: nuevo intento\n\n${action.instruccion}`,
          feature: featureText(runFeature(run)),
          plan: plan.plan,
          como_probar: reviewSteps(run),
        }),
        cwd: worktree,
        model: config.models.probar,
        tools: ["Read", "Grep", "Glob"],
        hook: tripwireHook(
          {
            scope: {
              root: realpathSync(worktree),
              owner: "probar",
              writable: [],
              writeGlobs: [],
              locked: [],
              harness: [],
              lockfiles: [],
              manifests: [],
              depsDeclared: false,
              testGlobs: config.tests_globs,
              bash: [],
              unreadable: config.probar.env_files,
            },
            fase: "probar",
            write: false,
            bash: false,
            agents: false,
            graft: false,
            mcp: [...BROWSER_TOOLS, HTTP_TOOL, ...(hayFallas ? FALLA_TOOLS : [])],
          },
          emit,
        ),
        schema: probarSchema,
        mcpServers: {
          navegador: browser.config,
          http: httpServer(origins, join(dir, "http.md")),
          ...(hayFallas ? { fallas: fallas.config } : {}),
        },
        timeoutMs: PROBAR_TIMEOUT_MS,
      },
      { run, deps, emit },
    );
    if (result.tipo !== "ok") {
      return result.tipo === "limite"
        ? result
        : { tipo: "falla", clase: result.clase, motivo: result.motivo };
    }
    const tests = result.output;
    const unknown = tests.pruebas.filter(
      (p) => p.resultado === "falla" && !ids.includes(p.subtarea),
    );
    if (unknown.length > 0) {
      return {
        tipo: "falla",
        clase: "gate",
        motivo: `una prueba en falla nombra una sub-task que no existe: ${[...new Set(unknown.map((p) => p.subtarea))].join(", ")}; las válidas son ${ids.join(", ")}`,
      };
    }
    writeFileSync(join(dir, "pruebas.json"), `${JSON.stringify(tests, null, 2)}\n`);
    for (const d of tests.decisiones)
      emit({ tipo: "decision", fase: "probar", que: d.que, por_que: d.por_que });
    const etiqueta = (p: Pruebas["pruebas"][number]) =>
      p.criterio === "" ? p.que : `${p.criterio} (${p.que})`;
    const untested = tests.pruebas.filter((x) => x.resultado === "no_probado");
    for (const p of untested) {
      emit({
        tipo: "aviso",
        fase: "probar",
        texto: `no se pudo probar ${etiqueta(p)}: ${p.evidencia}`,
      });
    }
    const failed = tests.pruebas.filter((p) => p.resultado === "falla");
    // Una falla del código va primero a implementar; lo que no se pudo probar se mira cuando probar
    // vuelva a correr. Sin fallas, un criterio sin probar detiene: entregarlo así lo decide la persona.
    if (failed.length === 0 && untested.length > 0) {
      return {
        tipo: "falla",
        clase: "sin_probar",
        motivo: `${String(untested.length)} de ${String(tests.pruebas.length)} criterios quedaron sin probar:\n${untested
          .map((p) => `- ${etiqueta(p)}: ${p.evidencia}`)
          .join("\n")}\nLa evidencia de lo que sí se probó está en ${dir}`,
      };
    }
    if (failed.length === 0) return { tipo: "ok" };
    return {
      tipo: "vuelve",
      unidades: [...new Set(failed.map((p) => p.subtarea))],
      motivo: `la prueba en el entorno falló:\n${failed
        .map((p) => `- ${p.subtarea} · ${p.criterio} ${p.que}: ${p.evidencia}`)
        .join("\n")}\nLa evidencia, con el log de la API y el video, está en ${dir}`,
    };
  } finally {
    // Antes de bajar el entorno: una falla puesta, como LocalStack pausado, no puede quedar viva.
    for (const texto of await fallas.restaurarTodas()) {
      emit({ tipo: "aviso", fase: "probar", texto: `una falla quedó puesta: ${texto}` });
    }
    await browser?.stop();
    const alive = await up.entorno.bajar();
    if (alive.length > 0) {
      emit({
        tipo: "aviso",
        fase: "probar",
        texto: `después de bajar el entorno sigue respondiendo ${alive.join(", ")}: \`bajar\` en la config de probar no lo baja todo`,
      });
    }
  }
};
