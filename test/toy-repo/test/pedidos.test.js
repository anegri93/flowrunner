import { test } from "node:test";
import assert from "node:assert/strict";
import { pedidos, total } from "../src/pedidos.js";

test("total suma los montos", () => {
  assert.equal(total(pedidos), 1640.49);
});
