import { describe, expect, test } from "vitest";
import type { NewEvent, Outcome, Phase, RunEvent } from "../store/events.ts";
import { MAX_ATTEMPTS, nextAction, stateOf, type RunState } from "./engine.ts";

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
