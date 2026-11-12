import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { allSessions, at, build, owned, piz9, start } from "./piz9.fixture.ts";
import type { Paso } from "./recorrido.ts";

/** Un paso en una línea, para comparar el recorrido de un vistazo. */
const brief = (p: Paso): string => {
  const v = p.tipo === "pendiente" || p.vuelta === undefined ? "" : ` v${String(p.vuelta)}`;
  switch (p.tipo) {
    case "etapa":
      return `${p.fase} ${p.resultado}${v}`;
    case "tuyo":
      return `tú: ${p.que}${v}`;
    case "auto":
      return `auto: ${p.que}${v}`;
    case "pendiente":
      return `pendiente: ${p.fases.join(", ")}`;
  }
};

describe("recorridoOf", () => {
  // Si regresiona, el recorrido pierde las vueltas o las ordena mal, y vuelve a ser una foto.
  test("cuenta lo que pasó en orden, con las vueltas agrupadas hasta que su etapa queda en verde", () => {
    const { recorrido } = build(piz9, "entregado");
    expect(recorrido.map(brief)).toEqual([
      "preparar ok",
      "planificar ok",
      "tú: aprobaste",
      "implementar ok",
      "verificar vuelve v1",
      "auto: autofix v1",
      "verificar vuelve v1",
      "implementar pregunta v1",
      "tú: arreglaste a mano v1",
      "verificar ok",
      "revisar vuelve v2",
      "auto: autofix v2",
      "verificar ok v2",
      "revisar ok",
      "probar falla v3",
      "tú: aceptaste v3",
      "entregar ok",
      "pendiente: aprender",
    ]);
  });

  // Si regresiona, el costo o el tiempo de una corrida se suma a otra de la misma fase.
  test("cada corrida tiene su hora, su duración, su costo y sus sub-tasks", () => {
    const { recorrido } = build(piz9, "entregado");
    const runs = recorrido.filter(
      (p): p is Extract<Paso, { tipo: "etapa" }> => p.tipo === "etapa" && p.fase === "implementar",
    );
    expect(runs.map((p) => [p.inicio, p.segundos, Number(p.costoUsd.toFixed(2))])).toEqual([
      [at(749), 404, 1.57],
      [at(1177), 145, 0.4],
    ]);
    expect(runs[0]?.subtareas.map((u) => [u.id, u.estado, u.sesiones.length])).toEqual([
      ["ST-1", "integrada", 2],
      ["ST-2", "integrada", 1],
      ["ST-3", "integrada", 1],
    ]);
    // La segunda corrida solo rehízo ST-1, con sus dos sesiones nuevas.
    expect(
      runs[1]?.subtareas.map((u) => [u.id, u.estado, u.sesiones.map((s) => s.nombre)]),
    ).toEqual([["ST-1", "fallida", ["implementar-ST-1-3", "implementar-ST-1-4"]]]);
    const revisar = recorrido.filter((p) => p.tipo === "etapa" && p.fase === "revisar");
    expect(revisar.map((p) => p.tipo === "etapa" && p.sesiones.map((s) => s.nombre))).toEqual([
      ["revisar-1"],
      ["revisar-2"],
    ]);
  });

  // Si regresiona, la tarjeta pierde el motivo de la vuelta o la PR.
  test("una vuelta dice a quién devolvió y por qué, y la PR va en entregar", () => {
    const { recorrido, vueltas } = build(piz9, "entregado");
    const first = recorrido.find((p) => p.tipo === "etapa" && p.resultado === "vuelve");
    expect(first).toMatchObject({ unidades: ["ST-1"], motivo: "AC-9 sigue en rojo" });
    expect(recorrido.find((p) => p.tipo === "etapa" && p.fase === "entregar")).toMatchObject({
      pr: 12,
    });
    expect(
      vueltas.map((v) => [v.numero, v.fase, v.resultado, v.veces, v.unidades, v.pasos]),
    ).toEqual([
      [1, "verificar", "vuelve", 2, ["ST-1"], 5],
      [2, "revisar", "vuelve", 1, ["ST-3"], 3],
      [3, "probar", "falla", 1, [], 2],
    ]);
    expect(vueltas.every((v) => !v.abierta && !v.abierto)).toBe(true);
  });

  // Si regresiona, un plan que espera tu aprobación no se ve, o se ve como una etapa terminada.
  test("aprobar espera mientras no respondés, y tu respuesta lo reemplaza", () => {
    const waiting = piz9.slice(
      0,
      piz9.findIndex((e) => e.tipo === "aprobado"),
    );
    expect(build(waiting, "esperando_aprobacion").recorrido.map(brief).slice(-2)).toEqual([
      "aprobar espera",
      "pendiente: implementar, verificar, revisar, probar, entregar, aprender",
    ]);
    const changes: RunEvent[] = [
      ...waiting,
      { tipo: "cambios_pedidos", at: at(760), motivo: "sin el SDK" },
    ];
    const r = build(changes, "en_curso").recorrido;
    expect(r.map(brief).slice(2, 3)).toEqual(["tú: pediste cambios"]);
    expect(r[2]).toMatchObject({ detalle: "sin el SDK" });
  });

  // Si regresiona, la tarjeta en vivo abre todo lo terminado o esconde lo que corre.
  test("en curso, lo vivo arranca abierto y lo terminado plegado", () => {
    const live = piz9.slice(
      0,
      piz9.findIndex((e) => e.tipo === "unidad" && e.at === at(1276)),
    );
    // ST-1-3 es la sesión que corre; las de después todavía no existen.
    const later = ["implementar-ST-1-4", "revisar-1", "revisar-2", "probar-1"];
    const sessions = allSessions
      .filter((s) => !later.includes(s.node.nombre))
      .map((s) => (s.node.nombre === "implementar-ST-1-3" ? owned(s.node.nombre, true) : s));
    const { recorrido, vueltas } = build(live, "en_curso", sessions);
    const etapas = recorrido.filter(
      (p): p is Extract<Paso, { tipo: "etapa" }> => p.tipo === "etapa",
    );
    expect(etapas.map((p) => [p.fase, p.resultado, p.abierto])).toEqual([
      ["preparar", "ok", false],
      ["planificar", "ok", false],
      ["implementar", "ok", false],
      ["verificar", "vuelve", false],
      ["verificar", "vuelve", false],
      ["implementar", "corriendo", true],
    ]);
    expect(etapas.at(-1)?.subtareas.map((u) => [u.id, u.estado])).toEqual([["ST-1", "corriendo"]]);
    expect(vueltas.map((v) => [v.numero, v.abierta, v.abierto])).toEqual([[1, true, true]]);
    expect(recorrido.at(-1)).toMatchObject({
      tipo: "pendiente",
      fases: ["verificar", "revisar", "probar", "entregar", "aprender"],
    });
  });

  // Si regresiona, un run abortado sigue «trabajando» en la tarjeta, con el reloj corriendo.
  test("abortado a mitad de una etapa: el paso queda cortado, sin pendientes ni nada abierto", () => {
    const cut = piz9.slice(
      0,
      piz9.findIndex((e) => e.tipo === "unidad" && e.at === at(1276)),
    );
    const { recorrido, vueltas } = build([...cut, { tipo: "abortado", at: at(1300) }], "abortado");
    expect(recorrido.map(brief).slice(-2)).toEqual(["implementar cortada v1", "tú: abortaste v1"]);
    expect(recorrido.some((p) => p.tipo === "pendiente")).toBe(false);
    expect(vueltas[0]?.abierto).toBe(false);
  });

  // Si regresiona, rehacer desde planificar deja todo lo que sigue adentro de una vuelta vieja.
  test("rehacer cierra la vuelta abierta", () => {
    const upTo = piz9.slice(
      0,
      piz9.findIndex((e) => e.tipo === "arreglo_manual"),
    );
    const redo: RunEvent[] = [
      ...upTo,
      { tipo: "rehacer", at: at(1400), desde: "planificar" },
      start(1401, "planificar"),
    ];
    expect(build(redo, "en_curso").recorrido.map(brief).slice(-3)).toEqual([
      "tú: rehiciste v1",
      "planificar corriendo",
      "pendiente: aprobar, implementar, verificar, revisar, probar, entregar, aprender",
    ]);
  });

  // Si regresiona, un nodo que abriste se cierra solo en el refresco siguiente.
  test("las claves no cambian cuando el run agrega eventos", () => {
    const short = piz9.slice(
      0,
      piz9.findIndex((e) => e.tipo === "autofix"),
    );
    const keys = (r: readonly Paso[]) =>
      r.filter((p) => p.tipo !== "pendiente").map((p) => p.clave);
    const before = keys(build(short, "en_curso").recorrido);
    expect(keys(build(piz9, "entregado").recorrido).slice(0, before.length)).toEqual(before);
  });
});
