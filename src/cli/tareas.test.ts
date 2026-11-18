import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UserError } from "./output.ts";
import { aprobarPlugin, correrTarea, leerTarea, listarTareas, type Tarea } from "./tareas.ts";

// El aviso de macOS va a un osascript falso: los tests no muestran notificaciones.
const ENV = { PATH: join(import.meta.dirname, "..", "..", "test", "bin") };
const NOW = new Date("2026-11-17T12:00:00Z");

function home(tareas: readonly Tarea[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-tareas-"));
  mkdirSync(join(dir, "tareas"));
  for (const t of tareas) writeFileSync(join(dir, "tareas", `${t.nombre}.json`), JSON.stringify(t));
  return dir;
}

const corriendo = (extra: Partial<Tarea> = {}): Tarea => ({
  nombre: "self-update",
  estado: "corriendo",
  pid: 4242,
  inicio: "2026-11-17T11:59:00Z",
  fin: null,
  mensaje: "actualizando flowrunner a origin/main",
  siguiente: null,
  ...extra,
});

// Si regresiona, un self-update que se cortó (Orca recargó el plugin, un reinicio) queda «corriendo»
// para siempre en el panel, y no se puede volver a lanzar.
test("una tarea que dice correr sin su proceso vivo se ve como cortada, con dónde está el detalle", () => {
  const h = home([corriendo()]);
  expect(leerTarea(h, "self-update", NOW, () => true)?.estado).toBe("corriendo");
  const cortada = leerTarea(h, "self-update", NOW, () => false);
  expect(cortada?.estado).toBe("falla");
  expect(cortada?.mensaje).toContain(join(h, "tareas", "self-update.log"));
});

// Si regresiona, el panel da por muerta una tarea en el instante entre lanzarla y que anote su pid.
test("recién lanzada, sin pid todavía, sigue corriendo un minuto; después, cortada", () => {
  const h = home([corriendo({ pid: null, inicio: "2026-11-17T11:59:30Z" })]);
  expect(leerTarea(h, "self-update", NOW)?.estado).toBe("corriendo");
  expect(leerTarea(h, "self-update", new Date("2026-11-17T12:01:00Z"))?.estado).toBe("falla");
});

test("lista solo las tareas conocidas y saltea un archivo que no se entiende", () => {
  const h = home([corriendo({ estado: "ok", fin: "2026-11-17T12:00:00Z" })]);
  writeFileSync(join(h, "tareas", "orca-install.json"), "{ no es json");
  writeFileSync(join(h, "tareas", "otra-cosa.json"), JSON.stringify(corriendo()));
  expect(listarTareas(h, NOW).map((t) => [t.nombre, t.estado])).toEqual([["self-update", "ok"]]);
});

// Si regresiona, un nombre de tarea con `/` o `..` escribe fuera de ~/.flowrunner/tareas.
test("un nombre de tarea fuera de la lista se rechaza antes de tocar el disco", () => {
  expect(() => leerTarea(home(), "../config", NOW)).toThrow(UserError);
});

// Si regresiona, una tarea que falla deja «corriendo» escrito, o pierde el comando para seguir.
test("al terminar deja en qué quedó: ok con su mensaje, o la falla con el comando para seguir", async () => {
  const h = home();
  const ok = await correrTarea(
    h,
    "orca-install",
    "cargando",
    () => Promise.resolve({ ok: true, mensaje: "cargado" }),
    ENV,
    () => NOW,
  );
  expect(ok.ok).toBe(true);
  expect(leerTarea(h, "orca-install", NOW)).toMatchObject({
    estado: "ok",
    mensaje: "cargado",
    fin: NOW.toISOString(),
  });

  await correrTarea(
    h,
    "self-update",
    "actualizando",
    () =>
      Promise.reject(new UserError("no actualizo con runs corriendo: VF-1", "flowrunner status")),
    ENV,
    () => NOW,
  );
  expect(leerTarea(h, "self-update", NOW)).toMatchObject({
    estado: "falla",
    mensaje: "no actualizo con runs corriendo: VF-1",
    siguiente: "flowrunner status",
  });
});

// Si regresiona, mientras corre el panel dice «trabajando» en vez de qué está haciendo.
test("al arrancar, el proceso conserva el mensaje con que se lanzó la tarea", async () => {
  const h = home([corriendo({ pid: null, inicio: NOW.toISOString() })]);
  let mientras: Tarea | undefined;
  await correrTarea(
    h,
    "self-update",
    "trabajando",
    () => {
      mientras = leerTarea(h, "self-update", NOW);
      return Promise.resolve({ ok: true, mensaje: "listo" });
    },
    ENV,
    () => NOW,
  );
  expect(mientras).toMatchObject({
    estado: "corriendo",
    pid: process.pid,
    mensaje: "actualizando flowrunner a origin/main",
  });
});

// Si regresiona, el panel no puede decir qué correr cuando Orca pide aprobar el plugin.
test("arma el --approve que pidió Orca; sin fingerprint, nada", () => {
  expect(
    aprobarPlugin(
      "local.flowrunner 0.1.0 needs approval. To approve, run: orca plugin dev load /x --approve ap1-test",
    ),
  ).toBe("flowrunner orca install --approve ap1-test");
  expect(aprobarPlugin("Loaded local.flowrunner")).toBeUndefined();
  expect(aprobarPlugin("--approve $(rm -rf ~)")).toBeUndefined();
});
