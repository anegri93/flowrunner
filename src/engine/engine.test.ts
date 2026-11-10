import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  eventSchema,
  type NewEvent,
  type Outcome,
  type Phase,
  type RunEvent,
} from "../store/events.ts";
import { MAX_ATTEMPTS, nextAction, stateOf, type RunState } from "./engine.ts";
import { TOKEN_REJECTED } from "./motivos.ts";

const AT = "2026-11-07T10:00:00.000Z";
const created: RunEvent = {
  tipo: "run_creado",
  at: AT,
  run_id: "R1",
  clave: "SHOP-1",
  proyecto: "acme",
  repo: "/r",
  budget_usd: 10,
};

const ev = (event: NewEvent): RunEvent => ({ ...event, at: AT });
const done = (fase: Phase, resultado: Outcome): RunEvent[] => [
  ev({ tipo: "accion_iniciada", fase }),
  ev({ tipo: "accion_terminada", fase, resultado }),
];
const ok = (fase: Phase) => done(fase, { tipo: "ok" });
const gate = (fase: Phase, motivo: string) => done(fase, { tipo: "falla", clase: "gate", motivo });
const upTo = (...phases: Phase[]) => phases.flatMap(ok);
const state = (...events: RunEvent[][]) => stateOf([created, ...events.flat()]);

describe("transiciones", () => {
  // Si regresiona, flowrunner gasta tokens reintentando algo que reintentar no arregla.
  test("una falla de entorno detiene sin reintentar", () => {
    const s = state(done("preparar", { tipo: "falla", clase: "entorno", motivo: "base roja" }));
    expect(s.status).toBe("detenido");
    expect(s.halt?.motivo).toMatch(/base roja/);
  });

  test("una falla de gate reintenta con el motivo hasta el tope y después detiene", () => {
    const after2 = state(ok("preparar"), gate("planificar", "a"), gate("planificar", "b"));
    expect(after2.status).toBe("en_curso");
    expect(nextAction(after2)).toMatchObject({ fase: "planificar", intento: 3, instruccion: "b" });
    const after3 = state(
      ok("preparar"),
      gate("planificar", "a"),
      gate("planificar", "b"),
      gate("planificar", "c"),
    );
    expect(after3.status).toBe("detenido");
    expect(after3.intentos).toBe(MAX_ATTEMPTS.planificar);
  });

  // Si regresiona, un fallo que el modelo no sabe arreglar consume todos los intentos.
  test("el mismo motivo dos veces seguidas detiene antes del tope", () => {
    const s = state(ok("preparar"), gate("planificar", "a"), gate("planificar", "a"));
    expect(s.status).toBe("detenido");
    expect(s.halt?.motivo).toMatch(/dos veces seguidas/);
    expect(s.halt?.siguiente).toBe("flowrunner rerun R1 --desde planificar");
  });

  test("la tercera vuelta de revisar detiene", () => {
    const back = done("revisar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "bloqueante" });
    const round = [...back, ...ok("implementar"), ...ok("verificar")];
    const base = [upTo("preparar", "planificar"), ok("aprobar"), upTo("implementar", "verificar")];
    const two = state(...base, round, round);
    expect(two.status).toBe("en_curso");
    expect(nextAction(two)).toMatchObject({ fase: "revisar" });
    const three = state(...base, round, round, back);
    expect(three.status).toBe("detenido");
    expect(three.halt?.motivo).toMatch(/revisar devolvió trabajo 3 veces/);
  });

  // Si regresiona, la PR se abre sin que nadie haya usado la feature, o una falla en el entorno se pierde.
  test("revisar sigue a probar; probar en verde entrega y en falla devuelve su sub-task", () => {
    const reviewed = [
      upTo("preparar", "planificar"),
      ok("aprobar"),
      upTo("implementar", "verificar", "revisar"),
    ];
    expect(nextAction(state(...reviewed))).toMatchObject({ fase: "probar" });
    expect(nextAction(state(...reviewed, ok("probar")))).toMatchObject({ fase: "entregar" });
    const back = state(
      ...reviewed,
      done("probar", { tipo: "vuelve", unidades: ["ST-3"], motivo: "POST /cuentas da 500" }),
    );
    expect(nextAction(back)).toMatchObject({
      fase: "implementar",
      unidades: ["ST-3"],
      instruccion: "POST /cuentas da 500",
    });
    expect(back.vueltas.probar).toBe(1);
  });

  test("verificar devuelve a implementar solo las sub-tasks que nombra, con el motivo", () => {
    const s = state(
      upTo("preparar", "planificar", "aprobar", "implementar"),
      done("verificar", { tipo: "vuelve", unidades: ["ST-2"], motivo: "AC-2 rojo" }),
    );
    expect(nextAction(s)).toMatchObject({
      fase: "implementar",
      unidades: ["ST-2"],
      instruccion: "AC-2 rojo",
    });
  });

  describe("probar con criterios sin probar", () => {
    const hasta = [
      upTo("preparar", "planificar"),
      ok("aprobar"),
      upTo("implementar", "verificar", "revisar"),
    ];
    const sinProbar = done("probar", {
      tipo: "falla",
      clase: "sin_probar",
      motivo: "AC-1 sin probar: no hay forma de simular KMS caído",
    });

    // Si regresiona, la PR se abre con criterios que nadie probó y nadie decidió dejar así (KMS-1).
    test("detiene sin reintentar y ofrece rehacer probar", () => {
      const s = state(...hasta, sinProbar);
      expect(s.status).toBe("detenido");
      expect(s.fase).toBe("probar");
      expect(s.halt?.motivo).toContain("AC-1 sin probar");
      expect(s.halt?.motivo).toContain('flowrunner accept-untested R1 "<por qué>"');
      expect(s.halt?.siguiente).toBe("flowrunner rerun R1 --desde probar");
      expect(nextAction(s).tipo).toBe("fin");
    });

    test("aceptarlo sigue a entregar sin volver a probar", () => {
      const s = stateOf([
        created,
        ...hasta.flat(),
        ...sinProbar,
        ev({ tipo: "sin_probar_aceptado", motivo: "el criterio es de solo backend" }),
      ]);
      expect(s.status).toBe("en_curso");
      expect(nextAction(s)).toMatchObject({ fase: "entregar", intento: 1 });
    });

    test("retomarlo vuelve a probar", () => {
      const s = stateOf([created, ...hasta.flat(), ...sinProbar, ev({ tipo: "reanudado" })]);
      expect(nextAction(s)).toMatchObject({ fase: "probar", intento: 1 });
    });

    // Si regresiona, un evento suelto saltea fases: entregar un run que se detuvo por otra cosa.
    test("aceptar no hace nada si el run no está detenido por criterios sin probar", () => {
      const porEntorno = stateOf([
        created,
        ...hasta.flat(),
        ...done("probar", { tipo: "falla", clase: "entorno", motivo: "el puerto está ocupado" }),
        ev({ tipo: "sin_probar_aceptado", motivo: "x" }),
      ]);
      expect(porEntorno.status).toBe("detenido");
      expect(porEntorno.fase).toBe("probar");
      const despuesDeRetomar = stateOf([
        created,
        ...hasta.flat(),
        ...sinProbar,
        ev({ tipo: "reanudado" }),
        ev({ tipo: "sin_probar_aceptado", motivo: "x" }),
      ]);
      expect(nextAction(despuesDeRetomar)).toMatchObject({ fase: "probar" });
    });
  });

  test("aprobar espera sin proceso; aprobado sigue a implementar", () => {
    const waiting = state(upTo("preparar", "planificar"), done("aprobar", { tipo: "espera" }));
    expect(waiting.status).toBe("esperando_aprobacion");
    expect(nextAction(waiting).tipo).toBe("fin");
    const approved = stateOf([
      created,
      ...upTo("preparar", "planificar"),
      ...done("aprobar", { tipo: "espera" }),
      ev({ tipo: "aprobado" }),
    ]);
    expect(nextAction(approved)).toMatchObject({ fase: "implementar", intento: 1 });
  });

  // Si regresiona, pedir cambios al plan te deja sin intentos para el plan corregido.
  test("cambios_pedidos vuelve a planificar con la instrucción y sin gastar intentos", () => {
    const s = stateOf([
      created,
      ...ok("preparar"),
      ...gate("planificar", "a"),
      ...gate("planificar", "b"),
      ...ok("planificar"),
      ...done("aprobar", { tipo: "espera" }),
      ev({ tipo: "cambios_pedidos", motivo: "separá la validación" }),
    ]);
    expect(nextAction(s)).toMatchObject({
      fase: "planificar",
      intento: 1,
      instruccion: "separá la validación",
    });
  });

  // Si regresiona, un run sigue gastando después de pasar su tope de presupuesto.
  test("el uso que pasa el tope detiene con el motivo, y el fin de la fase no lo revive", () => {
    const uso = ev({
      tipo: "uso",
      fase: "planificar",
      sesion: "s1",
      modelo: "claude-opus-5-5",
      costo_usd: 11,
      tokens_entrada: 1,
      tokens_salida: 1,
      duracion_ms: 1,
    });
    const s = stateOf([
      created,
      ...ok("preparar"),
      ev({ tipo: "accion_iniciada", fase: "planificar" }),
      uso,
      ev({ tipo: "accion_terminada", fase: "planificar", resultado: { tipo: "ok" } }),
    ]);
    expect(s.status).toBe("detenido");
    expect(s.halt?.motivo).toMatch(/USD 11.00.*USD 10.00/);
  });

  // Si regresiona, un run sin tope configurado se corta por un límite que nadie pidió.
  test("sin tope configurado, ningún gasto detiene el run", () => {
    const { budget_usd: _sinTope, ...sinTope } = created;
    const s = stateOf([
      sinTope,
      ...ok("preparar"),
      ev({ tipo: "accion_iniciada", fase: "planificar" }),
      ev({
        tipo: "uso",
        fase: "planificar",
        sesion: "s1",
        modelo: "claude-opus-5-5",
        costo_usd: 500,
        tokens_entrada: 1,
        tokens_salida: 1,
        duracion_ms: 1,
      }),
      ev({ tipo: "accion_terminada", fase: "planificar", resultado: { tipo: "ok" } }),
    ]);
    expect(s).toMatchObject({ status: "en_curso", fase: "aprobar", costoUsd: 500 });
  });

  test("infraestructura reintenta dos veces y a la tercera detiene", () => {
    const infra = done("entregar", { tipo: "falla", clase: "infra", motivo: "gh 502" });
    const base = [upTo("preparar", "planificar", "aprobar", "implementar", "verificar", "revisar")];
    expect(state(...base, infra, infra).status).toBe("en_curso");
    expect(state(...base, infra, infra, infra).status).toBe("detenido");
  });

  describe("reintentos de red y credenciales", () => {
    const R = "R1";
    const VF6 =
      "git fetch --quiet origin falló: fatal: unable to access 'https://github.com/anegri93/videoFactory.git/': Could not resolve host: github.com";
    const commands = (s: RunState) => s.halt?.opciones.map((o) => o.comando);
    const cut = done("preparar", { tipo: "falla", clase: "infra", motivo: VF6 });
    /** Un run creado con esta versión: congela sus reintentos de red al crearse. */
    const fresh = (...events: RunEvent[][]) =>
      stateOf([{ ...created, reintentos_red: 3 }, ...events.flat()]);

    // Si regresiona, un corte de red de menos de 7 minutos vuelve a matar el run (primer VF-6).
    test("un corte de red se reintenta tres veces y a la cuarta detiene, con resume", () => {
      const three = fresh(cut, cut, cut);
      expect(three.status).toBe("en_curso");
      expect(three.infra).toBe(3);
      const four = fresh(cut, cut, cut, cut);
      expect(four.status).toBe("detenido");
      expect(four.halt?.motivo).toContain("sin conexión después de 3 reintentos");
      expect(four.halt?.opciones[0]?.comando).toBe(`flowrunner resume ${R}`);
    });

    // Si regresiona, cualquier falla de infraestructura espera 7,5 minutos antes de detenerse.
    test("una falla de infraestructura que no es de red sigue deteniendo a la tercera", () => {
      const motivo = "la sesión planificar-1 terminó sin resultado";
      const fail = done("preparar", { tipo: "falla", clase: "infra", motivo });
      expect(fresh(fail, fail)).toMatchObject({ status: "en_curso", infra: 2 });
      const three = fresh(fail, fail, fail);
      expect(three.status).toBe("detenido");
      expect(three.halt?.motivo).toBe(`preparar: falla de infraestructura repetida: ${motivo}`);
    });

    // Si regresiona, un run detenido por la red antes de esta versión revive como en curso, sin proceso,
    // motivo ni opciones: el log viejo se tiene que seguir leyendo igual (C8).
    test("un log viejo detenido por tres cortes de red se sigue leyendo detenido", () => {
      const s = state(cut, cut, cut);
      expect(s.status).toBe("detenido");
      expect(s.halt?.motivo).toBe(`preparar: falla de infraestructura repetida: ${VF6}`);
    });

    // Si regresiona, el run detenido ofrece `resume`, que vuelve a fallar sin arreglar la credencial.
    test("una credencial rechazada detiene enseguida, con flowrunner doctor primero", () => {
      const s = state(
        ok("preparar"),
        done("planificar", { tipo: "falla", clase: "entorno", motivo: TOKEN_REJECTED }),
      );
      expect(s.status).toBe("detenido");
      expect(s.infra).toBe(0);
      expect(s.halt?.siguiente).toBe("flowrunner doctor");
      expect(commands(s)).toEqual([
        "flowrunner doctor",
        `flowrunner resume ${R}`,
        `flowrunner abort ${R}`,
      ]);
      expect(s.halt?.opciones[0]?.que).toBe("revisá la credencial; después retomá el run");
    });
  });

  test("entregar deja el run entregado y solo tick corre aprender", () => {
    const s = state(upTo("preparar", "planificar", "aprobar", "implementar", "verificar"), [
      ...ok("revisar"),
      ...ok("entregar"),
    ]);
    expect(s.status).toBe("entregado");
    expect(nextAction(s).tipo).toBe("fin");
    expect(nextAction(s, { tick: true })).toMatchObject({ fase: "aprender" });
  });

  test("reanudado retoma la fase detenida con intentos frescos; abortado es definitivo", () => {
    const halted = [created, ...done("preparar", { tipo: "falla", clase: "entorno", motivo: "x" })];
    expect(nextAction(stateOf([...halted, ev({ tipo: "reanudado" })]))).toMatchObject({
      fase: "preparar",
      intento: 1,
    });
    expect(stateOf([...halted, ev({ tipo: "abortado" }), ev({ tipo: "reanudado" })]).status).toBe(
      "abortado",
    );
  });

  // Si regresiona, un run que sale de la cola pierde la instrucción o los intentos que llevaba, o un
  // run en cola arranca sin lugar.
  test("encolado deja el run en cola sin proceso; reanudado lo devuelve como estaba", () => {
    const before = state(ok("preparar"), gate("planificar", "falta un test"));
    const queued = state(ok("preparar"), gate("planificar", "falta un test"), [
      ev({ tipo: "encolado" }),
    ]);
    expect(queued.status).toBe("en_cola");
    expect(nextAction(queued)).toEqual({ tipo: "fin", status: "en_cola" });
    const back = state(ok("preparar"), gate("planificar", "falta un test"), [
      ev({ tipo: "encolado" }),
      ev({ tipo: "reanudado" }),
    ]);
    expect(back).toEqual(before);
  });

  test("encolado no cambia un run que no está en curso", () => {
    const waiting = state(upTo("preparar", "planificar"), done("aprobar", { tipo: "espera" }));
    expect(
      state(upTo("preparar", "planificar"), done("aprobar", { tipo: "espera" }), [
        ev({ tipo: "encolado" }),
      ]),
    ).toEqual(waiting);
  });

  test("rehacer desde una fase la reinicia con vueltas en cero", () => {
    const s = stateOf([
      created,
      ...upTo("preparar", "planificar", "aprobar", "implementar"),
      ...done("verificar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "rojo" }),
      ev({ tipo: "rehacer", desde: "planificar" }),
    ]);
    expect(nextAction(s)).toMatchObject({ fase: "planificar", unidades: undefined });
    expect(s.vueltas.verificar).toBe(0);
  });
});

/**
 * Un "mundo" de respuestas: lo que contesta cada fase la n-ésima vez que corre, y lo que hace la
 * persona cuando el run la espera. Es lo que repite un run retomado.
 */
interface Script {
  readonly answers: Partial<Record<Phase, Outcome[]>>;
  readonly onWait: NewEvent[];
}

function drive(start: RunEvent[], script: Script): RunEvent[] {
  const log = [...start];
  const seen = (fase: Phase) =>
    log.filter((e) => e.tipo === "accion_terminada" && e.fase === fase).length;
  let waits = log.filter((e) => e.tipo === "aprobado" || e.tipo === "cambios_pedidos").length;
  for (let guard = 0; guard < 200; guard++) {
    const s: RunState = stateOf(log);
    const action = nextAction(s);
    if (action.tipo === "fin") {
      const external = script.onWait[waits];
      if (s.status !== "esperando_aprobacion" || external === undefined) return log;
      waits++;
      log.push(ev(external));
      continue;
    }
    const outcome = script.answers[action.fase]?.[seen(action.fase)] ?? { tipo: "ok" };
    if (!s.interrumpida) log.push(ev({ tipo: "accion_iniciada", fase: action.fase }));
    log.push(ev({ tipo: "accion_terminada", fase: action.fase, resultado: outcome }));
  }
  throw new Error("el run no terminó en 200 pasos");
}

const SCRIPTS: Record<string, Script> = {
  "camino feliz": { answers: { aprobar: [{ tipo: "espera" }] }, onWait: [{ tipo: "aprobado" }] },
  "con reintentos, cambios y vueltas": {
    answers: {
      planificar: [{ tipo: "falla", clase: "gate", motivo: "AC-2 no falla" }, { tipo: "ok" }],
      aprobar: [{ tipo: "espera" }, { tipo: "espera" }],
      verificar: [{ tipo: "vuelve", unidades: ["ST-1"], motivo: "AC-1 rojo" }, { tipo: "ok" }],
      revisar: [{ tipo: "vuelve", unidades: ["ST-2"], motivo: "bloqueante" }, { tipo: "ok" }],
      entregar: [{ tipo: "falla", clase: "infra", motivo: "gh 502" }, { tipo: "ok" }],
    },
    onWait: [{ tipo: "cambios_pedidos", motivo: "más chico" }, { tipo: "aprobado" }],
  },
};

describe("reanudación", () => {
  // Si regresiona, retomar un run cortado repite trabajo hecho o saltea trabajo pendiente.
  test.each(Object.entries(SCRIPTS))(
    "cada prefijo del log de '%s', retomado, llega al mismo estado final",
    (_name, script) => {
      const full = drive([created], script);
      const expected = stateOf(full);
      expect(expected.status).toBe("entregado");
      for (let cut = 1; cut <= full.length; cut++) {
        const resumed = drive(full.slice(0, cut), script);
        // El log retomado tiene que ser el mismo: mismas fases, mismas respuestas, mismo orden.
        expect(resumed, `cortado en el evento ${cut}`).toEqual(full);
        expect(stateOf(resumed)).toEqual(expected);
      }
    },
  );
});

describe("detenerse y preguntar (ADR 0023)", () => {
  const R = "R1";
  const withRounds = (vueltas: number): RunEvent => ({ ...created, vueltas });
  const implemented = [...upTo("preparar", "planificar"), ...ok("aprobar"), ...ok("implementar")];
  const back = (unidades: string[], motivo = "AC-1 sigue en rojo") =>
    done("verificar", { tipo: "vuelve", unidades, motivo });
  const commands = (s: RunState) => s.halt?.opciones.map((o) => o.comando);
  const verifyQuestion = [withRounds(0), ...implemented, ...back(["ST-2"])];

  // Si regresiona, el primer rojo dispara otra sesión de implementar sin que nadie la pida (VF-6).
  test("con 0 vueltas, el primer rojo de verificar detiene con una pregunta", () => {
    const s = stateOf(verifyQuestion);
    expect(s.status).toBe("detenido");
    expect(s.fase).toBe("verificar");
    expect(s.halt?.unidades).toEqual(["ST-2"]);
    expect(s.vueltas.verificar).toBe(1);
    expect(s.halt?.motivo).toBe("verificar: AC-1 sigue en rojo");
    expect(nextAction(s).tipo).toBe("fin");
  });

  // Si regresiona, las respuestas que ve la persona no son las que el CLI acepta.
  test("las opciones de una pregunta de verificar salen en orden", () => {
    const s = stateOf(verifyQuestion);
    expect(commands(s)).toEqual([
      `flowrunner fix ${R} --unidad ST-2 "<qué cambiar>"`,
      `flowrunner fix ${R} --yo`,
      `flowrunner accept ${R} "<por qué>"`,
      `flowrunner rerun ${R} --desde planificar`,
      `flowrunner abort ${R}`,
    ]);
    expect(s.halt?.siguiente).toBe(s.halt?.opciones[0]?.comando);
    for (const o of s.halt?.opciones ?? []) expect(o.que).not.toBe("");
  });

  // Si regresiona, un run que ya corría cambia de comportamiento a mitad de camino.
  test("un run viejo sin vueltas en run_creado sigue con dos vueltas", () => {
    const old = [created, ...implemented];
    const round = [...back(["ST-1"]), ...ok("implementar")];
    const one = stateOf([...old, ...back(["ST-1"])]);
    expect(one.vueltasMax).toBe(2);
    expect(nextAction(one)).toMatchObject({ fase: "implementar", unidades: ["ST-1"] });
    const two = stateOf([...old, ...round, ...back(["ST-1"])]);
    expect(nextAction(two)).toMatchObject({ fase: "implementar", unidades: ["ST-1"] });
    const three = stateOf([...old, ...round, ...round, ...back(["ST-1"])]);
    expect(three.status).toBe("detenido");
    expect(three.halt?.motivo).toMatch(/verificar devolvió trabajo 3 veces; el máximo es 2/);
    expect(commands(three)?.[0]).toBe(`flowrunner fix ${R} --unidad ST-1 "<qué cambiar>"`);
  });

  // Si regresiona, arreglar lo que pidió la persona le gasta una vuelta, o pierde su instrucción.
  test("arreglo_pedido vuelve a implementar con las sub-tasks y la instrucción, sin sumar vueltas", () => {
    const s = stateOf([
      ...verifyQuestion,
      ev({
        tipo: "arreglo_pedido",
        unidades: ["ST-2"],
        instruccion: "el CSV lleva BOM",
        origen: "terminal",
      }),
    ]);
    expect(s.status).toBe("en_curso");
    expect(nextAction(s)).toMatchObject({
      fase: "implementar",
      unidades: ["ST-2"],
      instruccion: "el CSV lleva BOM",
    });
    expect(s.vueltas.verificar).toBe(1);
    expect(s.halt).toBeUndefined();
  });

  // Si regresiona, la persona puede entregar una sub-task sin hacer, o no puede pedir que se arregle.
  test("una pregunta de implementar detiene sin accept y con fix por cada sub-task", () => {
    const s = state(
      upTo("preparar", "planificar"),
      ok("aprobar"),
      done("implementar", { tipo: "pregunta", motivo: "x", unidades: ["ST-1", "ST-2"] }),
    );
    expect(s.status).toBe("detenido");
    expect(s.halt?.unidades).toEqual(["ST-1", "ST-2"]);
    expect(commands(s)).toEqual([
      `flowrunner fix ${R} --unidad ST-1 "<qué cambiar>"`,
      `flowrunner fix ${R} --unidad ST-2 "<qué cambiar>"`,
      `flowrunner fix ${R} --yo`,
      `flowrunner rerun ${R} --desde planificar`,
      `flowrunner abort ${R}`,
    ]);
    expect(commands(s)?.some((c) => c.includes("accept"))).toBe(false);
    expect(s.intentos).toBe(0);
  });

  // Si regresiona, una sub-task bloqueada por la que se arregla no arranca nunca.
  test("arreglo_pedido sobre una pregunta de implementar incluye las bloqueadas", () => {
    const asked = [
      withRounds(0),
      ...upTo("preparar", "planificar"),
      ...ok("aprobar"),
      ...done("implementar", {
        tipo: "pregunta",
        motivo: "ST-2 no cambió ningún archivo",
        unidades: ["ST-2", "ST-3"],
      }),
    ];
    const halted = stateOf(asked);
    expect(halted.status).toBe("detenido");
    expect(commands(halted)).toEqual([
      `flowrunner fix ${R} --unidad ST-2 "<qué cambiar>"`,
      `flowrunner fix ${R} --unidad ST-3 "<qué cambiar>"`,
      `flowrunner fix ${R} --yo`,
      `flowrunner rerun ${R} --desde planificar`,
      `flowrunner abort ${R}`,
    ]);
    const s = stateOf([
      ...asked,
      ev({ tipo: "arreglo_pedido", unidades: ["ST-2"], instruccion: "usá jsqr", origen: "orca" }),
    ]);
    expect(nextAction(s)).toMatchObject({
      fase: "implementar",
      unidades: ["ST-2", "ST-3"],
      instruccion: "Para ST-2: usá jsqr",
    });
  });

  // Si regresiona, un evento suelto manda a implementar un run que se detuvo por otra cosa.
  test("arreglo_pedido que el halt no ofrece no cambia nada", () => {
    const porEntorno = [
      withRounds(0),
      ...done("preparar", { tipo: "falla", clase: "entorno", motivo: "base roja" }),
    ];
    const fix = ev({
      tipo: "arreglo_pedido",
      unidades: ["ST-1"],
      instruccion: "x",
      origen: "terminal",
    });
    expect(stateOf([...porEntorno, fix])).toEqual(stateOf(porEntorno));
    const running = [withRounds(0), ...ok("preparar")];
    expect(stateOf([...running, fix])).toEqual(stateOf(running));
  });

  // Si regresiona, un arreglo a mano se pierde: el run sigue sin él o nunca vuelve a verificar.
  test("fix a mano: espera tu resume y después vuelve a verificar", () => {
    const waiting = stateOf([
      ...verifyQuestion,
      ev({ tipo: "arreglo_manual_iniciado", origen: "claude", base: "abc1234" }),
    ]);
    expect(waiting).toMatchObject({ status: "detenido", aMano: true, fase: "verificar" });
    expect(waiting.halt?.motivo).toMatch(/arreglo a mano/);
    expect(commands(waiting)).toEqual([`flowrunner resume ${R}`, `flowrunner abort ${R}`]);
    expect(waiting.halt?.siguiente).toBe(`flowrunner resume ${R}`);
    const after = stateOf([
      ...verifyQuestion,
      ev({ tipo: "arreglo_manual_iniciado", origen: "claude", base: "abc1234" }),
      ev({ tipo: "arreglo_manual", sha: "abc1234" }),
    ]);
    expect(after).toMatchObject({ status: "en_curso", fase: "verificar", aMano: false });
    expect(after.vueltas.verificar).toBe(1);
    // Sin la espera a mano, el evento no hace nada.
    expect(stateOf([...verifyQuestion, ev({ tipo: "arreglo_manual", sha: null })])).toEqual(
      stateOf(verifyQuestion),
    );
  });

  // Si regresiona, se entrega una sub-task sin hacer, o se saltea una fase que no se aceptó.
  test("aceptado en verificar sigue a revisar; en implementar no hace nada", () => {
    const accepted = stateOf([
      ...verifyQuestion,
      ev({ tipo: "aceptado", fase: "verificar", motivo: "AC-1 es flaky", origen: "terminal" }),
    ]);
    expect(nextAction(accepted)).toMatchObject({ fase: "revisar", intento: 1 });
    const implementQuestion = [
      withRounds(0),
      ...upTo("preparar", "planificar"),
      ...ok("aprobar"),
      ...done("implementar", { tipo: "pregunta", motivo: "trabada", unidades: ["ST-1"] }),
    ];
    const inImplement = stateOf([
      ...implementQuestion,
      ev({ tipo: "aceptado", fase: "implementar", motivo: "x", origen: "terminal" }),
    ]);
    expect(inImplement).toEqual(stateOf(implementQuestion));
    // Una fase que no es la del halt tampoco.
    const otherPhase = stateOf([
      ...verifyQuestion,
      ev({ tipo: "aceptado", fase: "revisar", motivo: "x", origen: "terminal" }),
    ]);
    expect(otherPhase).toEqual(stateOf(verifyQuestion));
  });

  // Si regresiona, accept-untested deja de llevar a entregar, o su detención no dice cómo seguir.
  test("sin_probar_aceptado sigue como antes, y su detención ofrece rerun, accept, fix --yo y abort", () => {
    const hasta = [
      withRounds(0),
      ...upTo("preparar", "planificar"),
      ...ok("aprobar"),
      ...upTo("implementar", "verificar", "revisar"),
      ...done("probar", { tipo: "falla", clase: "sin_probar", motivo: "AC-1 sin probar" }),
    ];
    const halted = stateOf(hasta);
    expect(halted.sinProbar).toBe(true);
    expect(commands(halted)).toEqual([
      `flowrunner rerun ${R} --desde probar`,
      `flowrunner accept ${R} "<por qué>"`,
      `flowrunner fix ${R} --yo`,
      `flowrunner abort ${R}`,
    ]);
    expect(halted.halt?.siguiente).toBe(`flowrunner rerun ${R} --desde probar`);
    expect(halted.halt?.motivo).toContain(`flowrunner accept-untested ${R} "<por qué>"`);
    const legacy = stateOf([...hasta, ev({ tipo: "sin_probar_aceptado", motivo: "backend" })]);
    expect(nextAction(legacy)).toMatchObject({ fase: "entregar", intento: 1 });
    const viaAccept = stateOf([
      ...hasta,
      ev({ tipo: "aceptado", fase: "probar", motivo: "backend", origen: "claude" }),
    ]);
    expect(nextAction(viaAccept)).toMatchObject({ fase: "entregar", intento: 1 });
  });

  // Si regresiona, alguna detención deja a la persona sin saber qué comando correr.
  test("toda detención tiene opciones, y siguiente es la primera", () => {
    const uso = (costo: number) =>
      ev({
        tipo: "uso",
        fase: "planificar",
        sesion: "s1",
        modelo: "m",
        costo_usd: costo,
        tokens_entrada: 1,
        tokens_salida: 1,
        duracion_ms: 1,
      });
    const infra = done("entregar", { tipo: "falla", clase: "infra", motivo: "gh 502" });
    const hastaRevisar = [
      ...upTo("preparar", "planificar"),
      ...ok("aprobar"),
      ...upTo("implementar", "verificar", "revisar"),
    ];
    const cases: Record<string, RunEvent[]> = {
      entorno: [created, ...done("preparar", { tipo: "falla", clase: "entorno", motivo: "x" })],
      invariante: [
        created,
        ...done("preparar", { tipo: "falla", clase: "invariante", motivo: "x" }),
      ],
      "infra agotada": [created, ...hastaRevisar, ...ok("probar"), ...infra, ...infra, ...infra],
      presupuesto: [
        created,
        ...ok("preparar"),
        ev({ tipo: "accion_iniciada", fase: "planificar" }),
        uso(11),
      ],
      "el mismo fallo dos veces": [
        created,
        ...ok("preparar"),
        ...gate("planificar", "a"),
        ...gate("planificar", "a"),
      ],
      sinProbar: [
        created,
        ...hastaRevisar,
        ...done("probar", { tipo: "falla", clase: "sin_probar", motivo: "x" }),
      ],
      "vuelta agotada": [
        withRounds(1),
        ...implemented,
        ...back(["ST-1"]),
        ...ok("implementar"),
        ...back(["ST-1"]),
      ],
      pregunta: [
        created,
        ...ok("preparar"),
        ...done("planificar", { tipo: "pregunta", motivo: "falta un dato" }),
      ],
      "vuelve desde una fase que no puede": [
        created,
        ...ok("preparar"),
        ...done("planificar", { tipo: "vuelve", unidades: ["ST-1"], motivo: "x" }),
      ],
    };
    for (const [name, events] of Object.entries(cases)) {
      const s = stateOf(events);
      expect(s.status, name).toBe("detenido");
      expect(s.halt?.opciones.length, name).toBeGreaterThan(0);
      expect(s.halt?.siguiente, name).toBe(s.halt?.opciones[0]?.comando);
      expect(s.halt?.opciones.at(-1)?.comando, name).toBe(`flowrunner abort ${R}`);
    }
    expect(commands(stateOf(cases.entorno ?? []))).toEqual([
      `flowrunner resume ${R}`,
      `flowrunner abort ${R}`,
    ]);
    expect(commands(stateOf(cases["el mismo fallo dos veces"] ?? []))).toEqual([
      `flowrunner rerun ${R} --desde planificar`,
      `flowrunner abort ${R}`,
    ]);
  });

  // Si regresiona, VF-6 vuelve a dar nueve vueltas y 70 minutos por una traba de cinco.
  test("la secuencia de VF-6 se detiene en la primera vuelta de verificar", () => {
    const motivo = readFileSync(
      join(import.meta.dirname, "fixtures", "vf6-verificar-ac12.txt"),
      "utf8",
    );
    const s = stateOf([
      withRounds(0),
      ...ok("preparar"),
      ...ok("planificar"),
      ...done("aprobar", { tipo: "espera" }),
      ev({ tipo: "aprobado" }),
      ...ok("implementar"),
      ...done("verificar", { tipo: "vuelve", unidades: ["ST-6"], motivo }),
    ]);
    expect(s.status).toBe("detenido");
    expect(s.fase).toBe("verificar");
    expect(s.halt?.opciones[0]?.comando).toBe(`flowrunner fix ${R} --unidad ST-6 "<qué cambiar>"`);
    expect(s.halt?.motivo).toBe(`verificar: ${motivo}`);
    expect(nextAction(s)).toEqual({ tipo: "fin", status: "detenido" });
  });

  // Si regresiona, un run de antes de esta versión no se puede leer, o cambia de estado al actualizar.
  test("un log viejo, sin vueltas ni opciones, se lee y se reduce igual, y calcula sus opciones", () => {
    const old = [
      '{"tipo":"run_creado","at":"2026-11-09T10:00:00.000Z","run_id":"R1","clave":"SHOP-1","proyecto":"acme","repo":"/r"}',
      ...["preparar", "planificar", "aprobar", "implementar"].flatMap((fase) => [
        `{"tipo":"accion_iniciada","at":"2026-11-09T10:00:00.000Z","fase":"${fase}"}`,
        `{"tipo":"accion_terminada","at":"2026-11-09T10:00:00.000Z","fase":"${fase}","resultado":{"tipo":"ok"}}`,
      ]),
      '{"tipo":"accion_iniciada","at":"2026-11-09T10:00:00.000Z","fase":"verificar"}',
      '{"tipo":"accion_terminada","at":"2026-11-09T10:00:00.000Z","fase":"verificar","resultado":{"tipo":"falla","clase":"entorno","motivo":"falta jsqr"}}',
      '{"tipo":"aprobado","at":"2026-11-09T10:00:00.000Z"}',
    ].map((line) => eventSchema.parse(JSON.parse(line)));
    const s = stateOf(old);
    expect(s).toMatchObject({ status: "detenido", fase: "verificar", vueltasMax: 2, aMano: false });
    expect(s.halt?.motivo).toBe("verificar: falta jsqr");
    expect(commands(s)).toEqual([`flowrunner resume ${R}`, `flowrunner abort ${R}`]);
    expect(s.halt?.siguiente).toBe(`flowrunner resume ${R}`);
  });

  // Regresión de la revisión: el reductor aceptaba respuestas que el halt no ofrecía, y una carrera
  // de dos comandos o un accept-untested durante un arreglo a mano salteaban fases o lo perdían.
  test("una respuesta que el halt no ofrece no cambia nada, tampoco durante un arreglo a mano", () => {
    const same = (before: RunEvent[], event: NewEvent) =>
      expect(stateOf([...before, ev(event)])).toEqual(stateOf(before));
    const porEntorno = [
      withRounds(0),
      ...implemented,
      ...done("verificar", { tipo: "falla", clase: "entorno", motivo: "falta jsqr" }),
    ];
    same(porEntorno, { tipo: "aceptado", fase: "verificar", motivo: "x", origen: "terminal" });
    same(porEntorno, { tipo: "arreglo_manual_iniciado", origen: "terminal", base: "abc1234" });
    // Una sub-task que el halt no nombra, aunque ofrezca otras.
    same(verifyQuestion, {
      tipo: "arreglo_pedido",
      unidades: ["ST-99"],
      instruccion: "x",
      origen: "terminal",
    });
    same(verifyQuestion, {
      tipo: "arreglo_pedido",
      unidades: ["ST-2", "ST-99"],
      instruccion: "x",
      origen: "terminal",
    });
    const byHand = [
      ...verifyQuestion,
      ev({ tipo: "arreglo_manual_iniciado", origen: "terminal", base: "abc1234" }),
    ];
    same(byHand, { tipo: "aceptado", fase: "verificar", motivo: "x", origen: "terminal" });
    same(byHand, { tipo: "arreglo_pedido", unidades: ["ST-2"], instruccion: "x", origen: "orca" });
    const untestedByHand = [
      withRounds(0),
      ...upTo("preparar", "planificar"),
      ...ok("aprobar"),
      ...upTo("implementar", "verificar", "revisar"),
      ...done("probar", { tipo: "falla", clase: "sin_probar", motivo: "AC-1 sin probar" }),
      ev({ tipo: "arreglo_manual_iniciado", origen: "terminal", base: "abc1234" }),
    ];
    same(untestedByHand, { tipo: "sin_probar_aceptado", motivo: "x" });
    same(untestedByHand, { tipo: "aceptado", fase: "probar", motivo: "x", origen: "terminal" });
  });
});
