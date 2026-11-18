import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { appendEvent } from "../store/run-log.ts";
import { createRun } from "../store/runs.ts";
import {
  aplicarEdiciones,
  archivoPermitido,
  auditoriaSchema,
  historiaDe,
  informe,
  revisarDecisiones,
  type Auditoria,
  type Registro,
} from "./auditar.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-auditar-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const LECCIONES =
  "# Lecciones\n\n- L1: usá `src/viejo.ts` para fechas.\n- L2: los tests van al lado.\n- L2: los tests van al lado.\n";

const decision = (id: string, ediciones: Auditoria["decisiones"][number]["ediciones"]) => ({
  id,
  titulo: `decisión ${id}`,
  por_que: "porque sí",
  reduce: "no reduce detenciones: ordena el cerebro",
  hallazgos: [],
  ediciones,
});

// Si regresiona, una decisión de la auditoría edita código del repo, verify.sh (que corre en cada
// run) o algo fuera del repo.
test("solo se pueden editar los textos del cerebro, sus propuestas y la config", () => {
  expect(archivoPermitido(".flowrunner/lecciones.md")).toBe(".flowrunner/lecciones.md");
  expect(archivoPermitido("./.flowrunner/config.yaml")).toBe(".flowrunner/config.yaml");
  expect(archivoPermitido(".flowrunner/propuestas/VF-1.md")).toBe(".flowrunner/propuestas/VF-1.md");
  for (const bad of [
    ".flowrunner/verify.sh",
    ".flowrunner/ejemplos/pr-1.md",
    ".flowrunner/../src/app.ts",
    "src/app.ts",
    "/etc/passwd",
    ".flowrunner/propuestas/../../x.md",
  ])
    expect(archivoPermitido(bad), bad).toBeUndefined();
});

// Si regresiona, aplicar reemplaza el lugar equivocado o en dos lugares a la vez.
test("cada edición tiene que encontrar su texto una sola vez", () => {
  const textos = new Map([[".flowrunner/lecciones.md", LECCIONES]]);
  const una = aplicarEdiciones(textos, [
    {
      archivo: ".flowrunner/lecciones.md",
      buscar: "`src/viejo.ts`",
      reemplazar: "`src/fechas.ts`",
    },
  ]);
  expect("textos" in una && una.textos.get(".flowrunner/lecciones.md")).toContain(
    "`src/fechas.ts`",
  );
  // El original no cambia: una decisión rechazada no deja nada a medias.
  expect(textos.get(".flowrunner/lecciones.md")).toBe(LECCIONES);
  expect(
    aplicarEdiciones(textos, [
      {
        archivo: ".flowrunner/lecciones.md",
        buscar: "- L2: los tests van al lado.\n",
        reemplazar: "",
      },
    ]),
  ).toEqual({ motivo: "en .flowrunner/lecciones.md el texto a cambiar aparece 2 veces" });
  expect(
    aplicarEdiciones(textos, [
      { archivo: ".flowrunner/lecciones.md", buscar: "no está", reemplazar: "" },
    ]),
  ).toEqual({ motivo: "en .flowrunner/lecciones.md no está el texto a cambiar" });
  // `$&` en el reemplazo va tal cual, no como patrón.
  const dolar = aplicarEdiciones(textos, [
    { archivo: ".flowrunner/lecciones.md", buscar: "para fechas", reemplazar: "para $& y $1" },
  ]);
  expect("textos" in dolar && dolar.textos.get(".flowrunner/lecciones.md")).toContain(
    "para $& y $1",
  );
});

// Si regresiona, el panel ofrece elegir una decisión que después no se puede aplicar.
test("revisa cada decisión contra el cerebro auditado y guarda el hash de lo que toca", () => {
  const root = repo({ ".flowrunner/lecciones.md": LECCIONES, "src/app.ts": "x\n" });
  const auditoria: Auditoria = auditoriaSchema.parse({
    resumen: "dos lecciones repetidas",
    hallazgos: [],
    decisiones: [
      decision("D1", [
        {
          archivo: ".flowrunner/lecciones.md",
          buscar: "- L1: usá `src/viejo.ts` para fechas.\n",
          reemplazar: "",
        },
      ]),
      decision("D2", [{ archivo: "src/app.ts", buscar: "x", reemplazar: "y" }]),
      decision("D3", [{ archivo: ".flowrunner/contexto.md", buscar: "x", reemplazar: "y" }]),
      decision("D1", [{ archivo: ".flowrunner/lecciones.md", buscar: "L1", reemplazar: "L9" }]),
    ],
  });
  const r = revisarDecisiones(root, auditoria);
  expect(r.decisiones.map((d) => [d.id, d.aplicable, d.motivo])).toEqual([
    ["D1", true, null],
    ["D2", false, expect.stringContaining("src/app.ts no se puede editar") as unknown],
    ["D3", false, ".flowrunner/contexto.md no existe"],
    ["D1", false, "D1 está repetida"],
  ]);
  expect(Object.keys(r.archivos)).toEqual([".flowrunner/lecciones.md"]);
});

// Si regresiona, la auditoría no ve dónde se detuvieron los runs ni qué eligió la persona, que es la
// evidencia para proponer más vueltas automáticas.
test("la historia cuenta cada detención con lo que respondió la persona, solo del proyecto", () => {
  const home = mkdtempSync(join(tmpdir(), "fr-historia-"));
  const now = new Date("2026-11-17T10:00:00Z");
  const run = createRun(
    home,
    { clave: "VF-1", proyecto: "acme", repo: "/r", vueltas: 0, featureText: "# VF-1" },
    now,
  );
  const add = (e: Parameters<typeof appendEvent>[1]) => appendEvent(run.dir, e, () => now);
  add({ tipo: "rehacer", desde: "verificar" });
  add({
    tipo: "accion_terminada",
    fase: "verificar",
    resultado: {
      tipo: "vuelve",
      unidades: ["ST-1"],
      motivo: "AC-1 en rojo",
      arreglos: [{ unidad: "ST-1", instruccion: "Usá fechaCorta" }],
    },
  });
  add({
    tipo: "arreglo_pedido",
    unidades: ["ST-1"],
    instruccion: "Usá fechaCorta",
    origen: "orca",
  });
  add({ tipo: "cambios_pedidos", motivo: "sin la tabla nueva" });
  createRun(home, { clave: "OT-1", proyecto: "otro", repo: "/o", featureText: "# OT-1" }, now);

  const historia = historiaDe(home, "acme");
  expect(historia).toContain("1 runs.");
  expect(historia).toContain("- se detuvo en verificar: verificar: AC-1 en rojo");
  expect(historia).toContain("→ la persona eligió el arreglo propuesto 1 de 1");
  expect(historia).toContain("- pidió cambios al plan: sin la tabla nueva");
  expect(historia).not.toContain("OT-1");
  expect(historiaDe(home, "nadie")).toBe("(este repo todavía no tiene runs)");
});

// Si regresiona, un `.flowrunner/<archivo>` que es un link hace que aplicar escriba lo que apunta,
// fuera del cerebro.
test("un archivo del cerebro que es un link no se puede editar", () => {
  const afuera = repo({ "secreto.md": "x\n" });
  const root = repo({ ".flowrunner/lecciones.md": LECCIONES });
  symlinkSync(join(afuera, "secreto.md"), join(root, ".flowrunner", "que-es-bien.md"));
  const r = revisarDecisiones(
    root,
    auditoriaSchema.parse({
      resumen: "r",
      hallazgos: [],
      decisiones: [
        decision("D1", [{ archivo: ".flowrunner/que-es-bien.md", buscar: "x", reemplazar: "y" }]),
      ],
    }),
  );
  expect(r.decisiones[0]?.aplicable).toBe(false);
});

// Si regresiona, `.flowrunner/propuestas` como link a otra carpeta, como `~/.claude`, hace que aplicar
// escriba fuera del cerebro aunque el archivo final no sea un link (revisión de la PR).
test("un archivo dentro de una carpeta del cerebro que es un link tampoco se puede editar", () => {
  const afuera = repo({ "CLAUDE.md": "x\n" });
  const root = repo({ ".flowrunner/lecciones.md": LECCIONES });
  symlinkSync(afuera, join(root, ".flowrunner", "propuestas"));
  const r = revisarDecisiones(
    root,
    auditoriaSchema.parse({
      resumen: "r",
      hallazgos: [],
      decisiones: [
        decision("D1", [
          { archivo: ".flowrunner/propuestas/CLAUDE.md", buscar: "x", reemplazar: "y" },
        ]),
      ],
    }),
  );
  expect(r.decisiones[0]?.aplicable).toBe(false);
  expect(r.archivos).toEqual({});
});

test("el informe dice cómo aplicar cada decisión, o por qué no se puede", () => {
  const registro: Registro = {
    id: "20261117-100000",
    proyecto: "acme",
    repo: "/r",
    base: "main",
    commit: "abc1234def",
    fecha: "2026-11-17T10:00:00.000Z",
    costo_usd: 0.42,
    archivos: {},
    resumen: "Bien en general.",
    hallazgos: [
      {
        id: "H1",
        tipo: "no_alcanzo",
        archivo: ".flowrunner/lecciones.md",
        que: "L1 no alcanzó",
        evidencia: "VF-1 se detuvo igual",
      },
    ],
    decisiones: [
      {
        ...decision("D1", [{ archivo: ".flowrunner/lecciones.md", buscar: "a", reemplazar: "b" }]),
        aplicable: true,
        motivo: null,
      },
      {
        ...decision("D2", [{ archivo: "src/x.ts", buscar: "a", reemplazar: "b" }]),
        aplicable: false,
        motivo: "src/x.ts no se puede editar",
      },
    ],
    aplicadas: [],
  };
  const md = informe(registro);
  expect(md).toContain("**H1 · no alcanzó**");
  expect(md).toContain("`flowrunner brain apply acme/20261117-100000 --decision D1`");
  expect(md).toContain("No se puede aplicar: src/x.ts no se puede editar");
});
