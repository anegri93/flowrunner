// `flowrunner brain audit` y `brain apply` con el SDK simulado, el gh falso y un repo con remote: la
// auditoría queda guardada con sus decisiones revisadas, y aplicar abre una PR solo con las elegidas,
// solo sobre `.flowrunner/` y solo si lo que tocan no cambió desde la auditoría (ADR 0040).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./helpers/cli.ts";
import { git } from "./helpers/git.ts";
import type { SimScript } from "./helpers/sim-sdk.ts";
import { simWorld } from "./helpers/sim-world.ts";

const LECCION = "- L1: las fechas se formatean con `src/viejo.ts`.";

const AUDITORIA: SimScript = {
  match: "Sos el que audita el cerebro",
  calls: [{ tool: "Read", input: { file_path: ".flowrunner/lecciones.md" } }],
  output: {
    resumen: "L1 nombra un archivo que ya no existe.",
    hallazgos: [
      {
        id: "H1",
        tipo: "obsoleta",
        archivo: ".flowrunner/lecciones.md",
        que: "L1 nombra src/viejo.ts, que no existe",
        evidencia: "Glob src/viejo.ts no encuentra nada",
      },
    ],
    decisiones: [
      {
        id: "D1",
        titulo: "Borrar L1",
        por_que: "H1: el archivo no existe",
        reduce: "no reduce detenciones: ordena el cerebro",
        hallazgos: ["H1"],
        ediciones: [
          { archivo: ".flowrunner/lecciones.md", buscar: `${LECCION}\n`, reemplazar: "" },
        ],
      },
      {
        id: "D2",
        titulo: "Arreglar el código",
        por_que: "no va",
        reduce: "nada",
        hallazgos: [],
        ediciones: [{ archivo: "README.md", buscar: "# proyecto", reemplazar: "# otro" }],
      },
      {
        id: "D3",
        titulo: "Una vuelta automática",
        por_que: "la persona eligió siempre el primer arreglo",
        reduce: "las detenciones de verificar",
        hallazgos: [],
        ediciones: [
          {
            archivo: ".flowrunner/config.yaml",
            buscar: 'setup: "true"',
            reemplazar: 'setup: "true"\nvueltas: 1',
          },
        ],
      },
    ],
  },
};

function world() {
  const w = simWorld({ real: [], scripts: [AUDITORIA], feature: "" });
  writeFileSync(join(w.work, ".flowrunner", "lecciones.md"), `# Lecciones\n\n${LECCION}\n`);
  git(w.work, "commit", "-qam", "lección");
  git(w.work, "push", "-q", "origin", "main");
  return w;
}

interface Auditado {
  ok: boolean;
  id: string;
  proyecto: string;
  aplicables: number;
}

function audit(w: ReturnType<typeof world>): Auditado {
  const out = runCli(["brain", "audit", w.work, "--json"], w.env);
  expect(out.status, out.stdout + out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Auditado;
}

const prs = (w: ReturnType<typeof world>) =>
  (
    JSON.parse(readFileSync(join(w.env.HOME ?? "", "gh-state.json"), "utf8")) as {
      prs: { headRefName: string; body: string; title: string }[];
    }
  ).prs;

describe("brain audit", () => {
  // Si regresiona, la auditoría ofrece decisiones que tocan código o que no se pueden aplicar, o no ve
  // la historia de los runs.
  test("guarda la auditoría con cada decisión revisada y la última se lee con su informe", () => {
    const w = world();
    const done = audit(w);
    expect(done).toMatchObject({ ok: true, proyecto: "acme-api", aplicables: 2 });
    // La sesión vio el cerebro y la historia.
    expect(w.prompts()).toContain("(este repo todavía no tiene runs)");
    expect(w.prompts()).toContain("`.flowrunner/lecciones.md`");

    const ultima = runCli(["brain", "audit", w.work, "--ultima", "--json"], w.env);
    expect(ultima.status, ultima.stderr).toBe(0);
    const leida = JSON.parse(ultima.stdout) as {
      auditoria: {
        id: string;
        decisiones: { id: string; aplicable: boolean; motivo: string | null }[];
      };
      informe: string;
    };
    expect(leida.auditoria.id).toBe(done.id);
    expect(leida.auditoria.decisiones.map((d) => [d.id, d.aplicable])).toEqual([
      ["D1", true],
      ["D2", false],
      ["D3", true],
    ]);
    expect(leida.informe).toContain("# Auditoría del cerebro de acme-api");
    expect(leida.informe).toContain(`flowrunner brain apply acme-api/${done.id} --decision D1`);
    // Auditar no abre nada: aplicar es de la persona.
    expect(() => prs(w)).toThrow();
  }, 120_000);

  // Si regresiona, auditar desde el panel se corta a los 20 s del worker, o el panel no ve que terminó.
  test("con --fondo corre aparte y deja en tareas en qué quedó", async () => {
    const w = world();
    const started = runCli(["brain", "audit", w.work, "--fondo", "--json"], w.env);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ tarea: "auditar-acme-api" });
    const hasta = Date.now() + 60_000;
    let tarea: { estado: string; mensaje: string } | undefined;
    while (tarea === undefined || tarea.estado === "corriendo") {
      if (Date.now() > hasta) throw new Error("la auditoría de fondo no terminó");
      await new Promise((r) => setTimeout(r, 300));
      const out = runCli(["tareas", "--json"], w.env);
      tarea = (
        JSON.parse(out.stdout) as { tareas: { nombre: string; estado: string; mensaje: string }[] }
      ).tareas.find((t) => t.nombre === "auditar-acme-api");
    }
    expect(tarea).toMatchObject({ estado: "ok" });
    expect(tarea.mensaje).toContain("auditoría acme-api/");
  }, 120_000);

  test("una ruta que no es de un proyecto de flowrunner lo dice", () => {
    const w = world();
    const out = runCli(["brain", "audit", "/tmp", "--json"], w.env);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("no es un proyecto de flowrunner");
  });
});

describe("brain apply", () => {
  // Si regresiona, aplicar pisa un cambio que la persona hizo después de auditar, mete decisiones que
  // no eligió, o toca algo fuera de `.flowrunner/`.
  test("abre una PR solo con las elegidas que no cambiaron desde la auditoría, solo en .flowrunner/", () => {
    const w = world();
    const { id } = audit(w);
    // Después de auditar, la persona cambió la config en la base: D3 ya no vale.
    const config = join(w.work, ".flowrunner", "config.yaml");
    writeFileSync(config, `${readFileSync(config, "utf8")}max_runs: 3\n`);
    git(w.work, "commit", "-qam", "max_runs");
    git(w.work, "push", "-q", "origin", "main");

    const out = runCli(
      ["brain", "apply", `acme-api/${id}`, "--decision", "D1", "--decision", "D3", "--json"],
      w.env,
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const applied = JSON.parse(out.stdout) as {
      pr: string;
      aplicadas: string[];
      rechazadas: { id: string; motivo: string }[];
    };
    expect(applied.aplicadas).toEqual(["D1"]);
    expect(applied.rechazadas).toEqual([
      { id: "D3", motivo: ".flowrunner/config.yaml cambió desde la auditoría: volvé a auditar" },
    ]);
    const [pr] = prs(w);
    expect(pr?.headRefName).toBe(`chore/flowrunner-auditoria-${id}-d1`);
    expect(pr?.body).toContain("## D1 · Borrar L1");
    expect(pr?.body).toContain("- D3: .flowrunner/config.yaml cambió desde la auditoría");
    const branch = `chore/flowrunner-auditoria-${id}-d1`;
    expect(git(w.remote, "diff", "--name-only", "main", branch)).toBe(".flowrunner/lecciones.md");
    expect(git(w.remote, "show", `${branch}:.flowrunner/lecciones.md`)).not.toContain("L1");

    // Lo ya aplicado no se vuelve a ofrecer, y una que no se puede aplicar no abre nada.
    const again = runCli(["brain", "apply", `acme-api/${id}`, "--decision", "D1", "--json"], w.env);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain(`ya está en la PR ${applied.pr}`);
    const code = runCli(["brain", "apply", `acme-api/${id}`, "--decision", "D2", "--json"], w.env);
    expect(code.status).toBe(1);
    expect(code.stdout).toContain("README.md no se puede editar");
    expect(prs(w)).toHaveLength(1);

    // Si regresiona, un apply que se cortó después de abrir la PR y antes de anotarla deja esa
    // decisión sin poder aplicarse nunca más: la PR ya existe y `gh pr create` falla.
    const reg = join(w.env.HOME ?? "", ".flowrunner", "auditorias", "acme-api", `${id}.json`);
    writeFileSync(reg, JSON.stringify({ ...JSON.parse(readFileSync(reg, "utf8")), aplicadas: [] }));
    const otra = runCli(["brain", "apply", `acme-api/${id}`, "--decision", "D1", "--json"], w.env);
    expect(otra.status, otra.stdout + otra.stderr).toBe(0);
    expect((JSON.parse(otra.stdout) as { pr: string }).pr).toBe(applied.pr);
    expect(prs(w)).toHaveLength(1);

    // Y si falta el informe escrito, --ultima lo vuelve a armar en vez de fallar.
    rmSync(reg.replace(/\.json$/, ".md"));
    const ultima = runCli(["brain", "audit", w.work, "--ultima", "--json"], w.env);
    expect(ultima.status, ultima.stdout + ultima.stderr).toBe(0);
    expect((JSON.parse(ultima.stdout) as { informe: string }).informe).toContain("# Auditoría");
  }, 120_000);

  // Si regresiona, elegir dos decisiones sobre el mismo archivo, como dos lecciones de lecciones.md,
  // rechaza la segunda como si el archivo hubiera cambiado: volver a auditar no lo arregla.
  test("dos decisiones elegidas sobre el mismo archivo entran juntas", () => {
    const dos: SimScript = {
      ...AUDITORIA,
      output: {
        resumen: "dos arreglos en lecciones.md",
        hallazgos: [],
        decisiones: [
          {
            id: "D1",
            titulo: "Borrar L1",
            por_que: "no existe",
            reduce: "nada",
            hallazgos: [],
            ediciones: [
              { archivo: ".flowrunner/lecciones.md", buscar: `${LECCION}\n`, reemplazar: "" },
            ],
          },
          {
            id: "D2",
            titulo: "Renombrar el título",
            por_que: "más claro",
            reduce: "nada",
            hallazgos: [],
            ediciones: [
              {
                archivo: ".flowrunner/lecciones.md",
                buscar: "# Lecciones",
                reemplazar: "# Lecciones del repo",
              },
            ],
          },
        ],
      },
    };
    const w = simWorld({ real: [], scripts: [dos], feature: "" });
    writeFileSync(join(w.work, ".flowrunner", "lecciones.md"), `# Lecciones\n\n${LECCION}\n`);
    git(w.work, "commit", "-qam", "lección");
    git(w.work, "push", "-q", "origin", "main");
    const out0 = runCli(["brain", "audit", w.work, "--json"], w.env);
    expect(out0.status, out0.stdout + out0.stderr).toBe(0);
    const { id } = JSON.parse(out0.stdout) as Auditado;
    const out = runCli(
      ["brain", "apply", `acme-api/${id}`, "--decision", "D1", "--decision", "D2", "--json"],
      w.env,
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect((JSON.parse(out.stdout) as { aplicadas: string[] }).aplicadas).toEqual(["D1", "D2"]);
    const branch = `chore/flowrunner-auditoria-${id}-d1-d2`;
    expect(git(w.remote, "show", `${branch}:.flowrunner/lecciones.md`)).toBe(
      "# Lecciones del repo",
    );
  }, 120_000);

  test("una auditoría con otro formato se rechaza antes de tocar el disco", () => {
    const w = world();
    const out = runCli(["brain", "apply", "../../etc", "--decision", "D1", "--json"], w.env);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("auditoría inválida");
  });
});
