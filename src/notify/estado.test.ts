import { describe, expect, test } from "vitest";
import { initialState, type RunState } from "../engine/engine.ts";
import type { RunEvent } from "../store/events.ts";
import { avisoDeEstado, type Contexto } from "./estado.ts";

const at = "2026-11-09T10:00:00.000Z";
const run = (extra: Partial<RunState>): RunState => ({
  ...initialState(),
  runId: "SHOP-1-x",
  clave: "SHOP-1",
  ...extra,
});
const ctx = (extra: Partial<Contexto> = {}): Contexto => ({
  events: [],
  cambiosExistentes: () => 0,
  hora: () => "15:40",
  ...extra,
});
const body = (antes: RunState["status"], despues: RunState, c = ctx()) =>
  avisoDeEstado(antes, despues, c)?.body;

describe("avisoDeEstado", () => {
  // Si regresiona, flowrunner avisa de nuevo cosas que no cambiaron, y los avisos se ignoran.
  test("sin cambio de estado no hay aviso", () => {
    expect(avisoDeEstado("en_curso", run({ status: "en_curso" }), ctx())).toBeUndefined();
  });

  // Si regresiona, un plan que cambia lo existente avisa como uno que no, y se aprueba sin leer.
  test("el plan que espera dice si cambia lo que ya existe, o que no se pudo saber", () => {
    const waiting = run({ status: "esperando_aprobacion" });
    expect(body("en_curso", waiting)).toBe(
      "SHOP-1: el plan espera tu aprobación. Pedile a Claude que te lo muestre.",
    );
    expect(body("en_curso", waiting, ctx({ cambiosExistentes: () => 3 }))).toBe(
      "⚠ SHOP-1: el plan cambia 3 cosas que ya existen. Pedile a Claude que te lo muestre antes de aprobar.",
    );
    expect(body("en_curso", waiting, ctx({ cambiosExistentes: () => undefined }))).toMatch(
      /^⚠ SHOP-1: .*no pude leer si cambia lo que ya existe/,
    );
  });

  test("detenido lleva el motivo; PR abierta, las vueltas; pausa, la hora en que sigue", () => {
    expect(
      avisoDeEstado(
        "en_curso",
        run({ status: "detenido", halt: { motivo: "base roja", siguiente: "x" } }),
        ctx(),
      ),
    ).toEqual({ title: "SHOP-1: el run se detuvo", body: "base roja" });
    expect(
      body(
        "en_curso",
        run({ status: "entregado", vueltas: { verificar: 1, revisar: 1, probar: 0 } }),
      ),
    ).toBe("SHOP-1: PR abierta, 2 vueltas. Pedile a Claude que te explique el informe.");
    expect(body("en_curso", run({ status: "pausado_por_limite", pausaHasta: 1 }))).toBe(
      "SHOP-1: en pausa por el límite de la suscripción; sigue solo a las 15:40",
    );
  });

  // Si regresiona, un run en cola arranca solo y nadie se entera hasta que el plan espera.
  test("salir de la cola y volver de una pausa dicen en qué fase sigue", () => {
    const running = run({ status: "en_curso", fase: "implementar" });
    expect(body("en_cola", running)).toBe("SHOP-1: salió de la cola y arrancó en implementar");
    expect(body("pausado_por_limite", running)).toBe(
      "SHOP-1: retomado en implementar después del límite",
    );
    expect(body("en_curso", run({ status: "en_cola" }))).toBe(
      "SHOP-1: en cola, esperando un lugar del repo",
    );
  });

  test("cerrado dice si hubo merge y cuántas lecciones dejó", () => {
    const closed = run({ status: "cerrado" });
    const merged: RunEvent[] = [{ tipo: "pr_cerrada", at, mergeada: true }];
    expect(
      body("entregado", closed, ctx({ events: [{ tipo: "pr_cerrada", at, mergeada: false }] })),
    ).toBe("SHOP-1: cerrado; la PR se cerró sin merge");
    expect(body("entregado", closed, ctx({ events: merged }))).toBe(
      "SHOP-1: cerrado después del merge, sin lecciones",
    );
    expect(
      body(
        "entregado",
        closed,
        ctx({
          events: [
            ...merged,
            { tipo: "lecciones", at, url: "u", numero: 2, cantidad: 1, auto_merge: true },
          ],
        }),
      ),
    ).toBe("SHOP-1: cerrado después del merge, con 1 lección");
  });
});
