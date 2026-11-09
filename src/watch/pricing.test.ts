import { describe, expect, test } from "vitest";
import { contextWindow, estimateCost } from "./pricing.ts";

const M = 1_000_000;

describe("estimateCost", () => {
  // Si regresiona, watch muestra un costo en vivo que no coincide con lo que cobra la API.
  test("aplica el precio de cada tipo de token según el modelo", () => {
    expect(estimateCost("claude-opus-5-5", { input_tokens: M })).toBeCloseTo(4);
    expect(estimateCost("claude-opus-5-5", { cache_read_input_tokens: M })).toBeCloseTo(0.2);
    expect(estimateCost("claude-opus-5-5", { output_tokens: M })).toBeCloseTo(20);
    expect(estimateCost("claude-sonnet-5-5", { input_tokens: M, output_tokens: M })).toBeCloseTo(
      12,
    );
  });

  test("separa las escrituras de caché de 5 minutos y de 1 hora; sin desglose, cuenta las de 5 minutos", () => {
    const usage = {
      cache_creation_input_tokens: 2 * M,
      cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
    };
    expect(estimateCost("claude-opus-5-5", usage)).toBeCloseTo(5 + 8);
    expect(estimateCost("claude-opus-5-5", { cache_creation_input_tokens: M })).toBeCloseTo(5);
  });

  test("Haiku cobra más cuando el prompt pasa los 100.000 tokens", () => {
    expect(
      estimateCost("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: M }),
    ).toBeCloseTo(0.005 + 0.5);
    expect(estimateCost("claude-haiku-5-5", { cache_read_input_tokens: 200_000 })).toBeCloseTo(
      0.01,
    );
  });

  test("un modelo sin precio conocido no se estima", () => {
    expect(estimateCost("otro-modelo", { input_tokens: M })).toBeUndefined();
  });
});

test("contextWindow: 1M en Opus y Sonnet 5.5; desconocida en el resto", () => {
  expect(contextWindow("claude-opus-5-5")).toBe(M);
  expect(contextWindow("claude-sonnet-5-5")).toBe(M);
  expect(contextWindow("claude-haiku-5-5")).toBeUndefined();
});
