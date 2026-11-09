import { describe, expect, test } from "vitest";
import { progressLog, type Io } from "./output.ts";

function capture(): { io: Io; err: string[] } {
  const err: string[] = [];
  return { io: { out: () => undefined, err: (text) => err.push(text) }, err };
}

describe("progressLog", () => {
  // Si regresiona, un comando largo no dice nada mientras trabaja, o el avance ensucia el JSON.
  test("escribe cada línea en stderr con minutos y segundos; con --json no escribe nada", () => {
    const text = capture();
    progressLog(text.io, false, Date.now() - 75_000)("Claude lee el código");
    expect(text.err).toEqual(["[1:15] Claude lee el código"]);

    const json = capture();
    progressLog(json.io, true)("Claude lee el código");
    expect(json.err).toEqual([]);
  });
});
