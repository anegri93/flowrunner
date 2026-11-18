import { expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import { escribirServicio, leerServicio, type Servicio } from "./servicio.ts";

const inicio = "2026-11-18T10:00:00.000Z";
const arriba: Servicio = { estado: "arriba", pid: 4242, inicio, urls: {}, mensaje: "responde" };

// Si regresiona, un servicio cuyo proceso murió (un reinicio, un kill) se ve arriba para siempre: el
// panel ofrece pararlo y no deja volver a levantarlo.
test("un servicio arriba sin su proceso vivo se lee como falla, con dónde está el detalle", () => {
  const run = { dir: tempDir("fr-servicio-") };
  escribirServicio(run, arriba);
  expect(leerServicio(run, new Date(inicio), () => true)?.estado).toBe("arriba");
  const muerto = leerServicio(run, new Date(inicio), () => false);
  expect(muerto?.estado).toBe("falla");
  expect(muerto?.mensaje).toContain("servicio.log");
});

test("recién lanzado sin pid sigue levantando un rato, y después se da por cortado", () => {
  const run = { dir: tempDir("fr-servicio-") };
  escribirServicio(run, { ...arriba, estado: "levantando", pid: null });
  expect(leerServicio(run, new Date("2026-11-18T10:00:30.000Z"))?.estado).toBe("levantando");
  expect(leerServicio(run, new Date("2026-11-18T10:05:00.000Z"))?.estado).toBe("falla");
});
