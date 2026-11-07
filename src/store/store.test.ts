import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireLock, LockHeldError, readLock, releaseLock, type HolderStatus } from "./lock.ts";
import { appendEvent, CorruptLogError, logFile, readLog } from "./run-log.ts";

const runDir = () => mkdtempSync(join(tmpdir(), "fr-run-"));
const created = {
  tipo: "run_creado",
  run_id: "SHOP-1-x",
  clave: "SHOP-1",
  proyecto: "acme",
  repo: "/r",
  budget_usd: 25,
} as const;

describe("events.jsonl", () => {
  // Si regresiona, un run retomado arranca con un estado distinto al que tenía.
  test("append y relectura devuelven los mismos eventos en orden", () => {
    const dir = runDir();
    appendEvent(dir, created);
    appendEvent(dir, { tipo: "accion_iniciada", fase: "preparar" });
    appendEvent(dir, { tipo: "accion_terminada", fase: "preparar", resultado: { tipo: "ok" } });
    expect(readLog(dir).events.map((e) => e.tipo)).toEqual([
      "run_creado",
      "accion_iniciada",
      "accion_terminada",
    ]);
  });

  // Si regresiona, un corte en medio de una escritura deja el run imposible de retomar.
  test("una última línea truncada se descarta e informa el descarte", () => {
    const dir = runDir();
    appendEvent(dir, created);
    appendFileSync(logFile(dir), '{"tipo":"accion_inic');
    const read = readLog(dir);
    expect(read.events).toHaveLength(1);
    expect(read.discardedTail).toBe(true);
  });

  // Si regresiona, flowrunner adivina un estado sobre un log dañado y repite o saltea trabajo.
  test("una línea corrupta en el medio es un error que nombra la línea", () => {
    const dir = runDir();
    appendEvent(dir, created);
    appendFileSync(logFile(dir), "no es json\n");
    appendEvent(dir, { tipo: "reanudado" });
    expect(() => readLog(dir)).toThrow(CorruptLogError);
    expect(() => readLog(dir)).toThrow(/línea 2/);
  });

  test("un evento con tipo desconocido es un error", () => {
    const dir = runDir();
    writeFileSync(logFile(dir), '{"tipo":"inventado","at":"2026-11-07T00:00:00.000Z"}\n');
    expect(() => readLog(dir)).toThrow(CorruptLogError);
  });

  test("el at sale del reloj inyectado", () => {
    const dir = runDir();
    appendEvent(dir, created, () => new Date("2026-11-07T10:00:00Z"));
    expect(readFileSync(logFile(dir), "utf8")).toContain('"at":"2026-11-07T10:00:00.000Z"');
  });
});

describe("lock por repo", () => {
  const statusOf =
    (map: Record<string, HolderStatus>) =>
    (runId: string): HolderStatus =>
      map[runId] ?? "activo";

  test("dos runs que toman el lock: el segundo falla nombrando el run del primero", () => {
    const home = runDir();
    acquireLock(home, "acme", "RUN-A", process.pid, statusOf({}));
    expect(() => acquireLock(home, "acme", "RUN-B", process.pid, statusOf({}))).toThrow(
      LockHeldError,
    );
    expect(() => acquireLock(home, "acme", "RUN-B", process.pid, statusOf({}))).toThrow(/RUN-A/);
  });

  test("un lock con un pid muerto y su run en curso se toma", () => {
    const home = runDir();
    acquireLock(home, "acme", "RUN-A", 999_999, statusOf({}), () => true);
    acquireLock(home, "acme", "RUN-B", process.pid, statusOf({}), () => false);
    expect(readLock(home, "acme")?.run_id).toBe("RUN-B");
  });

  // Si regresiona, un segundo run arranca sobre el repo mientras el primero espera tu aprobación.
  test("un lock con un pid muerto y su run esperando aprobación no se toma", () => {
    const home = runDir();
    acquireLock(home, "acme", "RUN-A", 999_999, statusOf({}));
    expect(() =>
      acquireLock(
        home,
        "acme",
        "RUN-B",
        process.pid,
        statusOf({ "RUN-A": "esperando" }),
        () => false,
      ),
    ).toThrow(LockHeldError);
  });

  test("un lock de un run terminado se toma aunque su proceso viva", () => {
    const home = runDir();
    acquireLock(home, "acme", "RUN-A", process.pid, statusOf({}));
    acquireLock(home, "acme", "RUN-B", process.pid, statusOf({ "RUN-A": "terminado" }), () => true);
    expect(readLock(home, "acme")?.run_id).toBe("RUN-B");
  });

  test("soltar el lock de otro run no lo suelta", () => {
    const home = runDir();
    acquireLock(home, "acme", "RUN-A", process.pid, statusOf({}));
    releaseLock(home, "acme", "RUN-B");
    expect(readLock(home, "acme")?.run_id).toBe("RUN-A");
    releaseLock(home, "acme", "RUN-A");
    expect(readLock(home, "acme")).toBeUndefined();
  });
});
