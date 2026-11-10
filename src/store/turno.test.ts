import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  conTurno,
  intentarTurno,
  leerTurno,
  soltarTurno,
  TurnoAgotadoError,
  turnoFile,
} from "./turno.ts";

const fileIn = () => turnoFile(mkdtempSync(join(tmpdir(), "fr-turno-")), "acme", "entorno");

/** Un pid que ya terminó: el de un proceso que corrió y salió. */
const deadPid = () => spawnSync("true").pid;

function writeOwner(file: string, owner: { run_id: string; pid: number; token: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(owner));
}

describe("intentarTurno", () => {
  // Si regresiona, dos sub-tasks del mismo run (mismo pid) tocan el .git a la vez.
  test("un turno tomado está ocupado para otro, aunque sea de este mismo proceso", () => {
    const file = fileIn();
    const first = intentarTurno(file, "RUN-A");
    expect(first.tipo).toBe("tomado");
    const second = intentarTurno(file, "RUN-B");
    expect(second).toMatchObject({ tipo: "ocupado", dueño: { run_id: "RUN-A" } });
  });

  // Si regresiona, un run que murió con el turno tomado traba el entorno del repo para siempre.
  test("el turno de un dueño muerto se toma", () => {
    const file = fileIn();
    writeOwner(file, { run_id: "RUN-A", pid: deadPid(), token: "t" });
    expect(intentarTurno(file, "RUN-B")).toMatchObject({
      tipo: "tomado",
      dueño: { run_id: "RUN-B" },
    });
    expect(leerTurno(file)?.run_id).toBe("RUN-B");
  });

  test("un turno que no se lee se toma", () => {
    const file = fileIn();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{roto");
    expect(intentarTurno(file, "RUN-B").tipo).toBe("tomado");
  });

  test("soltar con el dueño de otro no suelta; con el propio, sí", () => {
    const file = fileIn();
    const mine = intentarTurno(file, "RUN-A");
    if (mine.tipo !== "tomado") throw new Error("no se tomó");
    soltarTurno(file, { ...mine.dueño, token: "otro" });
    expect(existsSync(file)).toBe(true);
    soltarTurno(file, mine.dueño);
    expect(existsSync(file)).toBe(false);
  });
});

describe("conTurno", () => {
  // Si regresiona, una falla en verify deja el entorno tomado y el otro run espera dos horas.
  test("suelta el turno aunque la función tire", async () => {
    const file = fileIn();
    await expect(
      conTurno(file, "RUN-A", () => Promise.reject(new Error("verify explotó"))),
    ).rejects.toThrow("verify explotó");
    expect(existsSync(file)).toBe(false);
  });

  test("espera mientras el dueño vive, avisa una sola vez y corre cuando se libera", async () => {
    const file = fileIn();
    writeOwner(file, { run_id: "RUN-A", pid: 4242, token: "t" });
    let ownerAlive = true;
    let waits = 0;
    const avisos: string[] = [];
    const result = await conTurno(file, "RUN-B", () => Promise.resolve("corrió"), {
      alive: () => ownerAlive,
      alEsperar: (d) => avisos.push(d.run_id),
      esperar: () => {
        waits += 1;
        if (waits === 3) ownerAlive = false;
        return Promise.resolve();
      },
    });
    expect(result).toBe("corrió");
    expect(waits).toBe(3);
    expect(avisos).toEqual(["RUN-A"]);
  });

  // Si regresiona, un run colgado con el turno deja a los demás esperando sin fin.
  test("al cumplirse el límite falla nombrando a quien lo tiene", async () => {
    const file = fileIn();
    writeOwner(file, { run_id: "RUN-A", pid: 4242, token: "t" });
    let now = 0;
    const attempt = conTurno(file, "RUN-B", () => Promise.resolve("nunca"), {
      alive: () => true,
      limiteMs: 60_000,
      ahora: () => now,
      esperar: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(TurnoAgotadoError);
    await expect(attempt).rejects.toThrow(/turno de entorno, que tiene RUN-A/);
  });

  // Si regresiona, dos verify del mismo repo corren juntos y comparten puertos y base.
  test("dos esperas a la vez nunca están adentro juntas", async () => {
    const file = fileIn();
    let inside = 0;
    let overlapped = false;
    const work = (id: string) =>
      conTurno(
        file,
        id,
        async () => {
          inside += 1;
          if (inside > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          inside -= 1;
        },
        { pausaMs: { desde: 1, hasta: 5 } },
      );
    await Promise.all([work("RUN-A"), work("RUN-B"), work("RUN-C")]);
    expect(overlapped).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});
