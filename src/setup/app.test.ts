import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { procesosVivos } from "./app.ts";

const tarea = (nombre: string) => ({
  nombre,
  estado: "corriendo",
  pid: process.pid,
  inicio: new Date().toISOString(),
  fin: null,
  mensaje: "trabajando",
  siguiente: null,
});

// Si regresiona, self-update reinstala la app mientras una auditoría de fondo corre con su código,
// y le cambia el SDK a mitad de la sesión (revisión de la PR).
test("una tarea de fondo que corre impide actualizar; el propio self-update no", () => {
  const home = mkdtempSync(join(tmpdir(), "fr-app-"));
  mkdirSync(join(home, "tareas"));
  writeFileSync(join(home, "tareas", "auditar-acme.json"), JSON.stringify(tarea("auditar-acme")));
  writeFileSync(join(home, "tareas", "self-update.json"), JSON.stringify(tarea("self-update")));
  expect(procesosVivos(home)).toEqual([`tarea auditar-acme (pid ${String(process.pid)})`]);
});
