// El worker con un flowrunner falso en vez del real: lo que lee y cómo informa un error.
import { fileURLToPath } from "node:url";
import { assert, mockHost, mountWorker, test } from "orca/testing";
import * as main from "./worker";

const FAKE = fileURLToPath(new URL("../test/fake-flowrunner.sh", import.meta.url));

// Si regresiona, el panel no recibe los runs de flowrunner.
test("lee los runs con el comando de la config y los pasos de una sesión", async () => {
  const worker = await mountWorker(main, { host: mockHost({ settings: { comando: FAKE } }) });
  const snap = await worker.request("flowrunner.runs");
  assert.equal(snap.error, undefined);
  assert.deepEqual(
    snap.runs.map((r) => r.clave),
    ["VF-2"],
  );
  const steps = await worker.request("flowrunner.pasos", {
    run: "VF-2-20261109-001527",
    sesion: "implementar-ST-2-1",
  });
  assert.deepEqual(steps, { sesion: "implementar-ST-2-1", texto: "Edit src/precio.ts\nlisto" });
  assert.deepEqual(worker.refusals, []);
  await worker.deactivate();
});

// Si regresiona, un flowrunner que no está en el PATH deja el panel cargando para siempre.
test("si flowrunner falla, devuelve el error y ningún run", async () => {
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { comando: "/no/existe/flowrunner" } }),
  });
  const snap = await worker.request("flowrunner.runs");
  assert.deepEqual(snap.runs, []);
  assert.match(snap.error ?? "", /no such file|not found/i);
  await worker.deactivate();
});
