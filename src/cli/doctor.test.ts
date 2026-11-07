import { describe, expect, test } from "vitest";
import { nodeSupported } from "./doctor.ts";

describe("nodeSupported", () => {
  // Si regresiona, doctor e init rechazan un Node más nuevo que corre flowrunner sin problemas.
  test("acepta Node 24 y cualquier versión más nueva; rechaza las anteriores", () => {
    expect(nodeSupported("24.0.0")).toBe(true);
    expect(nodeSupported("26.6.0")).toBe(true);
    expect(nodeSupported("22.11.0")).toBe(false);
  });
});
