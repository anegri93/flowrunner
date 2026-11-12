// Pausar un run para darle el lugar a otro (docs/specs/2026-11-12-pausar.md). El CLI real con fases
// falsas.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runStartedSchema } from "../src/cli/contracts.ts";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import {
  executions,
  FEATURE,
  runDir,
  stateNow,
  waitFor,
  world,
  type World,
} from "./helpers/runs.ts";

const CONFIG = {
  ".flowrunner/config.yaml": 'setup: "true"\ntests_globs: [tests/**]\nmax_runs: 1\n',
};

/** Otra feature del mismo proyecto: otra clave, otra rama. */
function feature(clave: string): string {
  const file = join(tempDir(), `${clave}.md`);
  writeFileSync(file, FEATURE.replace("SHOP-214", clave));
  return file;
}

function cli(w: World, ...args: string[]) {
  const result = runCli([...args, "--json"], w.env);
  if (result.status !== 0)
    throw new Error(`${args[0] ?? ""} falló: ${result.stdout}${result.stderr}`);
  return runStartedSchema.parse(JSON.parse(result.stdout));
}

/** Cuándo salió el run de la cola por primera vez. */
const salio = (w: World, id: string) =>
  readLog(runDir(w, id)).events.find((e) => e.tipo === "reanudado")?.at ?? "";

describe("pausar", () => {
  // Si regresiona, pausar para darle lugar a un run hace entrar al más viejo de la cola, tira lo que
  // la etapa hizo, o el run pausado vuelve solo.
  test("con max_runs 1, pausar el que trabaja con --para el más nuevo hace entrar a ese, y el pausado sigue al reanudar", async () => {
    const semaforo = join(tempDir(), "siga");
    const w = world({ FAKE_SEMAFORO: semaforo }, CONFIG);
    const a = cli(w, "run", w.feature).id;
    const viejo = cli(w, "run", feature("SHOP-215")).id;
    const nuevo = cli(w, "run", feature("SHOP-216")).id;
    await waitFor("a en preparar", () => executions(w, a).length === 1);
    // El lugar es para un run que espera en la cola: ni el mismo ni uno que no está en cola.
    expect(runCli(["pause", a, "--para", a, "--json"], w.env).stdout).toMatch(/no está en cola/);

    const paused = cli(w, "pause", a, "--para", nuevo);
    expect(paused.accion).toMatch(/se pausa al terminar lo que está haciendo/);
    // Sigue trabajando y con su lugar hasta terminar la etapa.
    expect(stateNow(w, a)).toMatchObject({ status: "en_curso", pausaPedida: true });
    expect(stateNow(w, viejo).status).toBe("en_cola");

    writeFileSync(semaforo, "");
    await waitFor("a pausado", () => stateNow(w, a).status === "pausado");
    expect(stateNow(w, a).fase).toBe("planificar");
    expect(executions(w, a)).toEqual(["preparar"]);
    await waitFor("los dos entregados", () =>
      [viejo, nuevo].every((id) => stateNow(w, id).status === "entregado"),
    );
    // Entró el elegido, no el más viejo de la cola.
    expect(salio(w, nuevo) < salio(w, viejo)).toBe(true);

    // tick no reanuda un run pausado: no tiene hora de vuelta.
    expect(runCli(["tick"], w.env).status).toBe(0);
    expect(stateNow(w, a).status).toBe("pausado");

    cli(w, "resume", a);
    await waitFor("a entregado", () => stateNow(w, a).status === "entregado");
    // Siguió en planificar: no rehízo la etapa que terminó antes de pausarse.
    expect(executions(w, a).slice(0, 2)).toEqual(["preparar", "planificar"]);
  });

  // Si regresiona, pausar un run en cola lo deja en la cola, o priorizar no cambia quién sale.
  test("pausar un run en cola lo saca en el acto; priorizar pone a otro primero", async () => {
    const semaforo = join(tempDir(), "siga");
    const w = world({ FAKE_SEMAFORO: semaforo }, CONFIG);
    const a = cli(w, "run", w.feature).id;
    const viejo = cli(w, "run", feature("SHOP-215")).id;
    const nuevo = cli(w, "run", feature("SHOP-216")).id;
    expect(cli(w, "pause", viejo).accion).toBe("pausado");
    expect(stateNow(w, viejo).status).toBe("pausado");
    expect(cli(w, "prioritize", nuevo).accion).toMatch(/sale primero/);
    writeFileSync(semaforo, "");
    await waitFor("a y nuevo entregados", () =>
      [a, nuevo].every((id) => stateNow(w, id).status === "entregado"),
    );
    expect(stateNow(w, viejo).status).toBe("pausado");
  });

  // Si regresiona, pausar un run que no ocupa lugar escribe un evento que no sirve, o --para deja el
  // lugar a un run que no está esperando.
  test("pause rechaza un run que no trabaja ni está en cola, y un --para que no está en cola", () => {
    const w = world({ FAKE_ESPERA_APROBAR: "1" });
    const a = cli(w, "run", w.feature).id;
    const b = cli(w, "run", feature("SHOP-215")).id;
    return waitFor("los dos esperando", () =>
      [a, b].every((id) => stateNow(w, id).status === "esperando_aprobacion"),
    ).then(() => {
      const waiting = runCli(["pause", a, "--json"], w.env);
      expect(waiting.status).toBe(1);
      expect(waiting.stdout).toMatch(/no ocupa lugar/);
      const noQueued = runCli(["prioritize", b, "--json"], w.env);
      expect(noQueued.status).toBe(1);
      expect(noQueued.stdout).toMatch(/no está en cola/);
    });
  });
});
