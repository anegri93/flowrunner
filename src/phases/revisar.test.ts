import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps, writeFiles } from "../../test/helpers/project.ts";
import { simQuery } from "../../test/helpers/sim-sdk.ts";
import type { Plan } from "../gates/plan.ts";
import { commitAll } from "../git/git.ts";
import { readLog } from "../store/run-log.ts";
import { z } from "zod";
import {
  rejectedWritesText,
  revisar,
  revisionesAnteriores,
  reviewSchema,
  verifyText,
  type Review,
} from "./revisar.ts";
import type { RunEvent } from "../store/events.ts";

const plan: Plan = {
  plan: "dos sub-tasks",
  subtareas: ["ST-1", "ST-2"].map((id) => ({
    id,
    titulo: id,
    descripcion: id,
    alcance: [`src/${id}/`],
    dependencias: [],
    depende_de: [],
  })),
  criterios: [{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "ST-1" }],
  tests: ["tests/ac1.mjs"],
  decisiones: [],
  cambia_lo_existente: [],
};

const finding = (extra: Partial<Review["hallazgos"][number]>): Review["hallazgos"][number] => ({
  severidad: "bloqueante",
  archivo: "src/ST-2/x.js",
  linea: 1,
  afirmacion: "usa var",
  regla: "no var",
  subtarea: "ST-2",
  ...extra,
});

async function reviewWith(output: Review) {
  const sim = simQuery([{ output }]);
  const deps = testDeps({ query: sim.query });
  const { run, featureWt } = await plannedRun(
    plan,
    { "tests/ac1.mjs": "process.exit(0);\n" },
    deps,
    {
      files: { "src/base.js": "export function base() { return 1; }\n" },
    },
  );
  writeFiles(featureWt, {
    "src/ST-2/x.js": 'import { base } from "../base.js";\nvar x = base();\n',
  });
  await commitAll(featureWt, "feat: ST-2", {}, deps.env);
  const outcome = await revisar(contextFor(run, "revisar", deps));
  return { outcome, sim, run };
}

describe("revisar", () => {
  // Si regresiona, un bloqueante llega a la PR, o revisar rehace sub-tasks que no tocó.
  test("un bloqueante en ST-2 vuelve solo ST-2 con el hallazgo y la regla en el motivo", async () => {
    const { outcome, sim } = await reviewWith({ hallazgos: [finding({})], decisiones: [] });
    expect(outcome).toEqual({
      tipo: "vuelve",
      unidades: ["ST-2"],
      motivo:
        "la revisión encontró bloqueantes:\n- ST-2 · src/ST-2/x.js:1: usa var (regla: no var)",
    });
    const prompt = sim.records[0]?.prompt ?? "";
    expect(prompt).toContain("+var x = base();");
    expect(sim.records[0]?.options?.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  // Si regresiona, la persona tiene que escribir a mano el arreglo que el revisor ya sabía (PIZ-3).
  test("los arreglos de cada bloqueante viajan en el outcome: en una línea, sin repetir y hasta 3", async () => {
    const { outcome, sim } = await reviewWith({
      hallazgos: [
        finding({
          arreglos: [
            "Cambiá `var` por `const`\n en src/ST-2/x.js",
            "Cambiá `var` por `const` en src/ST-2/x.js",
            "Usá let",
            "  ",
            "Borrá la variable",
            "Un cuarto que no entra",
          ],
        }),
        finding({ severidad: "aviso", subtarea: "ST-1", arreglos: ["no es bloqueante"] }),
      ],
      decisiones: [],
    });
    expect(outcome).toMatchObject({
      tipo: "vuelve",
      unidades: ["ST-2"],
      arreglos: [
        { unidad: "ST-2", instruccion: "Cambiá `var` por `const` en src/ST-2/x.js" },
        { unidad: "ST-2", instruccion: "Usá let" },
      ],
    });
    // Sin arreglos, el outcome es el de antes.
    const plain = await reviewWith({ hallazgos: [finding({ arreglos: [] })], decisiones: [] });
    expect(plain.outcome).not.toHaveProperty("arreglos");
    expect(sim.records[0]?.prompt ?? "").toContain("`arreglos`");
  });

  test("solo avisos: avanza, los avisos quedan como eventos y review.json en el run", async () => {
    const { outcome, run } = await reviewWith({
      hallazgos: [finding({ severidad: "aviso" })],
      decisiones: [],
    });
    expect(outcome).toEqual({ tipo: "ok" });
    expect(readLog(run.dir).events.filter((e) => e.tipo === "aviso")).toEqual([
      expect.objectContaining({ texto: "src/ST-2/x.js:1: usa var" }),
    ]);
    expect(existsSync(join(run.dir, "review.json"))).toBe(true);
  });

  test("un hallazgo que nombra una sub-task inexistente es falla de gate", async () => {
    const { outcome } = await reviewWith({
      hallazgos: [finding({ subtarea: "ST-9" })],
      decisiones: [],
    });
    expect(outcome).toMatchObject({ tipo: "falla", clase: "gate" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/ST-9.*las válidas son ST-1, ST-2/);
  });

  test("el prompt recibe el radio de impacto de graft sobre el diff real", async () => {
    const { sim } = await reviewWith({ hallazgos: [], decisiones: [] });
    const prompt = sim.records[0]?.prompt ?? "";
    const blast = prompt.slice(
      prompt.indexOf("# Radio de impacto según graft"),
      prompt.indexOf("# El cerebro del repo"),
    );
    expect(blast).not.toMatch(/no pudo calcular/);
    expect(blast).toMatch(/x\.js|base/);
  });
});

// Si regresiona, el modelo puede omitir el paso a paso: el default solo existe para leer review.json viejos.
test("el schema que recibe el revisor exige como_probar", () => {
  expect(z.toJSONSchema(reviewSchema, { target: "draft-7" }).required).toContain("como_probar");
});

// Si regresiona, el modelo puede omitir los arreglos y la detención vuelve a pedir el texto a mano.
test("el schema que recibe el revisor exige arreglos en cada hallazgo", () => {
  const schema = z.toJSONSchema(reviewSchema, { target: "draft-7" }) as unknown as {
    properties: { hallazgos: { items: { required: string[] } } };
  };
  expect(schema.properties.hallazgos.items.required).toContain("arreglos");
});

// Regresión de VF-6: el bloqueo rechazó el script de package.json, ST-5 siguió sin decirlo y revisar
// no se enteró: la PR documentaba `npm run mac` sin que existiera.
test("revisar recibe las escrituras rechazadas desde la última aprobación, sin repetir ni comandos", () => {
  const at = "2026-11-09T10:00:00.000Z";
  const rechazo = (unidad: string, herramienta: string, motivo: string): RunEvent => ({
    tipo: "rechazo",
    at,
    fase: "implementar",
    unidad,
    herramienta,
    motivo,
  });
  const events: RunEvent[] = [
    rechazo("ST-1", "Write", "de un plan anterior"),
    { tipo: "aprobado", at },
    rechazo("ST-5", "Edit", "package.json solo se toca si ST-5 declaró dependencias"),
    rechazo("ST-5", "Edit", "package.json solo se toca si ST-5 declaró dependencias"),
    rechazo("ST-3", "Bash", "`prettier --write` no está en la lista"),
  ];
  expect(rejectedWritesText(events)).toBe(
    "- ST-5: package.json solo se toca si ST-5 declaró dependencias",
  );
  expect(rejectedWritesText([])).toBe("Ninguna.");
});

describe("lo que revisar sabe de antes (ADR 0030)", () => {
  const at = "2026-11-12T18:00:00.000Z";
  type Terminada = Extract<RunEvent, { tipo: "accion_terminada" }>;
  const terminada = (fase: Terminada["fase"], resultado: Terminada["resultado"]): RunEvent => ({
    tipo: "accion_terminada",
    at,
    fase,
    resultado,
  });
  const unidad = (
    u: string,
    estado: "integrada" | "sin_cambios",
    extra: { sha?: string; motivo?: string },
  ): RunEvent => ({
    tipo: "unidad",
    at,
    fase: "implementar",
    unidad: u,
    estado,
    ...extra,
  });

  // Si regresiona, revisar repite un bloqueante que la sub-task ya contestó, sin enterarse de la
  // respuesta: en PIZ-15 frenó tres veces por un formato que verify daba por bueno.
  test("cada vuelta anterior con lo que hizo cada sub-task, desde la última aprobación", () => {
    const events: RunEvent[] = [
      terminada("revisar", { tipo: "vuelve", unidades: ["ST-9"], motivo: "de un plan anterior" }),
      { tipo: "aprobado", at },
      terminada("revisar", {
        tipo: "vuelve",
        unidades: ["ST-1", "ST-2"],
        motivo:
          "la revisión encontró bloqueantes:\n- ST-2 · api.ts:1439: Prettier lo deja en una línea",
      }),
      unidad("ST-1", "integrada", { sha: "5cef593aa" }),
      unidad("ST-2", "sin_cambios", {
        motivo: "prettier --check da verde: no hay nada que cambiar",
      }),
      // Lo que se hace por un rojo de verificar no es una respuesta a la revisión.
      terminada("verificar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "lint rojo" }),
      unidad("ST-1", "integrada", { sha: "9999999aa" }),
      terminada("verificar", { tipo: "ok" }),
    ];
    expect(revisionesAnteriores(events)).toBe(
      [
        "## Vuelta 1",
        "",
        "la revisión encontró bloqueantes:\n- ST-2 · api.ts:1439: Prettier lo deja en una línea",
        "",
        "Lo que hicieron las sub-tasks:",
        "- ST-1 cambió su código (5cef593).",
        "- ST-2 no cambió nada. Dijo: «prettier --check da verde: no hay nada que cambiar»",
      ].join("\n"),
    );
    expect(revisionesAnteriores([{ tipo: "aprobado", at }])).toBe(
      "Es la primera revisión de este plan.",
    );
  });

  // Si regresiona, la revisión ve vueltas de un intento descartado, cree que nadie trabajó un
  // bloqueante que la persona arregló a mano, o una respuesta en varias líneas rompe la lista
  // (hallazgos de /code-review en la PR #109).
  test("las vueltas arrancan en el último rerun, cuentan el arreglo a mano y la respuesta va en una línea", () => {
    const vuelve = (motivo: string) =>
      terminada("revisar", { tipo: "vuelve", unidades: ["ST-2"], motivo });
    const events: RunEvent[] = [
      { tipo: "aprobado", at },
      vuelve("de un intento que se rehízo"),
      { tipo: "rehacer", at, desde: "implementar" },
      vuelve("primera del intento nuevo"),
      { tipo: "arreglo_manual", at, sha: "abcdef123" },
      vuelve("segunda"),
      unidad("ST-2", "sin_cambios", { motivo: "Revisé.\n\n## No hace falta\n- ST-3 cambió" }),
    ];
    const text = revisionesAnteriores(events);
    expect(text).not.toContain("de un intento que se rehízo");
    expect(text).toContain(
      "## Vuelta 1\n\nprimera del intento nuevo\n\nLo que hicieron las sub-tasks:\n- La persona lo arregló a mano en el worktree (abcdef1).",
    );
    expect(text).toContain("- ST-2 no cambió nada. Dijo: «Revisé. ## No hace falta - ST-3 cambió»");
  });

  // Si regresiona, revisar no sabe qué comprobó verify y frena por formato, lint o tipos.
  test("verify: si pasó o si la persona aceptó el rojo, con lo que corre el script", () => {
    const script = "#!/bin/sh\nnpm run check\n";
    expect(
      verifyText([terminada("verificar", { tipo: "ok" })], ".flowrunner/verify.sh", script),
    ).toBe(
      "verify (`.flowrunner/verify.sh`) pasó sobre esta rama. Corre:\n\n```sh\n#!/bin/sh\nnpm run check\n```",
    );
    const aceptado: RunEvent[] = [
      terminada("verificar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "lint rojo" }),
      { tipo: "aceptado", at, fase: "verificar", motivo: "es un falso positivo", origen: "orca" },
    ];
    expect(verifyText(aceptado, ".flowrunner/verify.sh", script)).toContain(
      "quedó en rojo y la persona lo aceptó: «es un falso positivo»",
    );
  });

  // Si regresiona, el prompt pierde las secciones y la regla que frena los bloqueantes de formato.
  test("el prompt lleva verify, las vueltas anteriores y la regla de formato", async () => {
    const { sim } = await reviewWith({ hallazgos: [], decisiones: [] });
    const prompt = sim.records[0]?.prompt ?? "";
    expect(prompt).toContain("# Lo que ya comprobó verify");
    expect(prompt).toContain("```sh\n#!/bin/sh\nexit 0\n```");
    expect(prompt).toContain("# Las revisiones anteriores");
    expect(prompt).toContain("Es la primera revisión de este plan.");
    expect(prompt).toContain("Lo que corre el script de verify (abajo) no es hallazgo");
  });
});
