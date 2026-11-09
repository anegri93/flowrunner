// Precios por millón de tokens, para estimar en vivo lo que cuesta una sesión que todavía no terminó.
// Fuente: https://platform.claude.com/docs/en/about-claude/pricing, al 2026-11-08. Al terminar, la
// sesión informa su costo real y ese reemplaza a la estimación.

export interface Usage {
  readonly input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number;
    readonly ephemeral_1h_input_tokens?: number;
  };
}

interface Price {
  readonly input: number;
  readonly write5m: number;
  readonly write1h: number;
  readonly read: number;
  readonly output: number;
}

const OPUS: Price = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 };
const SONNET: Price = { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 };
const HAIKU: Price = { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 };
/** Haiku 5.5 cobra otra tarifa para prompts de más de 100.000 tokens. */
const HAIKU_LONG: Price = { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 };
const HAIKU_LONG_FROM = 100_000;

function priceOf(model: string, promptTokens: number): Price | undefined {
  const id = model.replace(/^claude-/, "");
  if (id.startsWith("opus-5-5")) return OPUS;
  if (id.startsWith("sonnet-5-5")) return SONNET;
  if (id.startsWith("haiku-5-5")) return promptTokens > HAIKU_LONG_FROM ? HAIKU_LONG : HAIKU;
  return undefined;
}

/** El prompt de un pedido: lo que entra, nuevo o desde la caché. */
export const promptTokens = (u: Usage) =>
  (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** El costo de un pedido en USD, o undefined si el modelo no tiene precio conocido. */
export function estimateCost(model: string, u: Usage): number | undefined {
  const price = priceOf(model, promptTokens(u));
  if (price === undefined) return undefined;
  const writes = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    u.cache_creation === undefined ? writes : (u.cache_creation.ephemeral_5m_input_tokens ?? 0);
  const perMillion =
    (u.input_tokens ?? 0) * price.input +
    write5m * price.write5m +
    write1h * price.write1h +
    (u.cache_read_input_tokens ?? 0) * price.read +
    (u.output_tokens ?? 0) * price.output;
  return perMillion / 1_000_000;
}

/** La ventana de contexto del modelo, si se conoce. */
export function contextWindow(model: string): number | undefined {
  const id = model.replace(/^claude-/, "");
  return id.startsWith("opus-5-5") || id.startsWith("sonnet-5-5") ? 1_000_000 : undefined;
}
