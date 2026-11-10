import { describe, expect, test } from "vitest";
import type { RunEvent } from "../store/events.ts";
import { unitHistory } from "./report.ts";

const AT = "2026-11-07T10:00:00.000Z";
const unit = (estado: "iniciada" | "fallida", corte = false): RunEvent => ({
  tipo: "unidad",
  at: AT,
  fase: "implementar",
  unidad: "ST-1",
  estado,
  ...(corte ? { motivo: "getaddrinfo ENOTFOUND api.anthropic.com", corte_de_red: true } : {}),
});

describe("unitHistory", () => {
  // Si regresiona, `flowrunner etapa` dice «fallida · 4 intentos» de una sub-task que solo esperaba la
  // red, con un máximo de 3.
  test("una sub-task cortada por la red queda pendiente, y sus cortes no son intentos", () => {
    const events = [
      unit("iniciada"),
      unit("fallida", true),
      unit("iniciada"),
      unit("fallida", true),
    ];
    expect(unitHistory(events, "ST-1")).toMatchObject({ estado: "pendiente", intentos: 0 });
  });
});
