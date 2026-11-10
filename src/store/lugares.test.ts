import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  lockViejo,
  lugarDe,
  lugaresDir,
  ocupados,
  soltarLugar,
  tomarLugar,
  type Reglas,
} from "./lugares.ts";

const homeIn = () => mkdtempSync(join(tmpdir(), "fr-lugares-"));
const deadPid = () => spawnSync("true").pid;
const enCurso = (max: number, waiting: readonly string[] = []): Reglas => ({
  max,
  ocupa: (id) => !waiting.includes(id),
});

describe("tomarLugar", () => {
  // Si regresiona, un repo corre más runs de los que la persona puso en max_runs.
  test("con tope 2, el tercero no consigue lugar y se entera de quiénes corren", () => {
    const home = homeIn();
    expect(tomarLugar(home, "acme", "RUN-A", process.pid, enCurso(2))).toEqual({ ok: true });
    expect(tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(2))).toEqual({ ok: true });
    expect(tomarLugar(home, "acme", "RUN-C", process.pid, enCurso(2))).toEqual({
      ok: false,
      corriendo: ["RUN-A", "RUN-B"],
    });
  });

  test("un run que ya tenía lugar lo conserva con el pid nuevo aunque el repo esté lleno", () => {
    const home = homeIn();
    tomarLugar(home, "acme", "RUN-A", process.pid, enCurso(1));
    expect(tomarLugar(home, "acme", "RUN-A", 4242, enCurso(1))).toEqual({ ok: true });
    expect(lugarDe(home, "acme", "RUN-A")?.pid).toBe(4242);
  });

  // Si regresiona, un run que murió con lugar (kill -9, corte de luz) ocupa el repo para siempre.
  test("el lugar de un proceso muerto se libera", () => {
    const home = homeIn();
    tomarLugar(home, "acme", "RUN-A", deadPid(), enCurso(1));
    expect(tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(1))).toEqual({ ok: true });
    expect(lugarDe(home, "acme", "RUN-A")).toBeUndefined();
  });

  // Si regresiona, un plan que espera tu aprobación le traba el repo a los demás, como antes del
  // ADR 0019, aunque su proceso se haya cortado justo antes de soltar el lugar.
  test("el lugar de un run que no está en curso se libera aunque su pid viva", () => {
    const home = homeIn();
    tomarLugar(home, "acme", "RUN-A", process.pid, enCurso(1));
    expect(tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(1, ["RUN-A"]))).toEqual({
      ok: true,
    });
  });

  test("los lugares de otro proyecto no cuentan", () => {
    const home = homeIn();
    tomarLugar(home, "otro", "RUN-A", process.pid, enCurso(1));
    expect(tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(1))).toEqual({ ok: true });
  });

  // Si regresiona, al actualizar flowrunner un run que corría pierde su lugar y otro entra encima.
  test("el lock de un run por repo de antes se convierte en un lugar", () => {
    const home = homeIn();
    const viejo = lockViejo(home, "acme");
    mkdirSync(dirname(viejo), { recursive: true });
    writeFileSync(viejo, JSON.stringify({ run_id: "RUN-A", pid: process.pid }));
    expect(tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(1))).toEqual({
      ok: false,
      corriendo: ["RUN-A"],
    });
    expect(existsSync(viejo)).toBe(false);
  });
});

describe("ocupados y soltarLugar", () => {
  test("ocupados cuenta sin borrar; soltar saca solo el lugar del run", () => {
    const home = homeIn();
    tomarLugar(home, "acme", "RUN-A", process.pid, enCurso(2));
    tomarLugar(home, "acme", "RUN-B", process.pid, enCurso(2));
    expect(ocupados(home, "acme", enCurso(2, ["RUN-B"]))).toEqual(["RUN-A"]);
    expect(readdirSync(lugaresDir(home, "acme")).sort()).toEqual(["RUN-A.json", "RUN-B.json"]);
    soltarLugar(home, "acme", "RUN-A");
    expect(readdirSync(lugaresDir(home, "acme"))).toEqual(["RUN-B.json"]);
  });
});
