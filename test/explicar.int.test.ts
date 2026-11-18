// `flowrunner explain` (ADR 0037), con el CLI real, las fases falsas y el SDK simulado: FAKE_VUELVE
// detiene el run en verificar con una pregunta.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { runCli } from "./helpers/cli.ts";
import { FEATURE, waitFor } from "./helpers/runs.ts";
import { simWorld, type SimWorld } from "./helpers/sim-world.ts";

const EXPLICA = "Sos el que explica de flowrunner";

const explicacion = (recomendada: number) => ({
  match: EXPLICA,
  costUsd: 0.4,
  output: {
    resumen: "verificar sigue en rojo por AC-1.",
    que_paso: "ST-1 no hizo pasar AC-1.",
    por_que_frena: "Con 0 vueltas, el primer rojo te pregunta.",
    opciones: [{ numero: 1, que_hace: "ST-1 lo corrige con tu instrucción.", riesgos: "" }],
    recomendada,
    por_que_recomienda: "Es la sub-task que cubre AC-1.",
  },
});

async function stopped(recomendada = 1): Promise<{ w: SimWorld; id: string }> {
  const w = simWorld({
    real: [],
    scripts: [explicacion(recomendada)],
    feature: FEATURE,
    extraEnv: { FAKE_VUELVE: "ST-1" },
  });
  const id = w.launch();
  await waitFor("el run detenido", () => w.state(id).status === "detenido", 60_000);
  return { w, id };
}

const explainSessions = (w: SimWorld, id: string) =>
  readdirSync(join(w.dir(id), "sesiones")).filter((f) => f.startsWith("explicar-"));

describe("explicar una detención", () => {
  // Si regresiona, la persona decide sin entender, o cada vista de la explicación gasta otra sesión.
  test("explica el run detenido con sus respuestas, una vez por detención, sin cambiar el run", async () => {
    const { w, id } = await stopped();
    const before = w.state(id);

    const first = runCli(["explain", id, "--json"], w.env);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const data = JSON.parse(first.stdout) as { ok: boolean; estado: string; texto: string };
    expect(data).toMatchObject({ ok: true, estado: "lista" });
    expect(data.texto).toContain("Por qué se detuvo en Verificar");
    expect(data.texto).toContain(`flowrunner fix ${id} --unidad ST-1 "<qué cambiar>"`);
    expect(data.texto).toContain(`flowrunner abort ${id}`);
    expect(w.prompts()).toContain("AC-1 sigue en rojo");

    // La misma detención se devuelve sin otra sesión.
    const second = runCli(["explain", id, "--json"], w.env);
    expect(JSON.parse(second.stdout)).toMatchObject({ estado: "lista", texto: data.texto });
    expect(explainSessions(w, id)).toHaveLength(1);

    const after = w.state(id);
    expect(after.status).toBe("detenido");
    expect(after.halt).toEqual(before.halt);
    expect(after.costoUsd).toBe(before.costoUsd);
    const { events } = readLog(w.dir(id));
    expect(events.filter((e) => e.tipo === "explicacion")).toHaveLength(1);
    expect(events.some((e) => e.tipo === "uso" && e.sesion.startsWith("explicar-"))).toBe(false);

    const watch = JSON.parse(runCli(["watch", "--json"], w.env).stdout) as {
      runs: { id: string; explicacion?: { estado: string } }[];
    };
    expect(watch.runs.find((r) => r.id === id)?.explicacion).toEqual({ estado: "lista" });
  });

  // Si regresiona, una explicación muestra como respuesta algo que el run no acepta.
  test("una recomendación que el run no ofrece no se guarda: queda el motivo y watch lo dice", async () => {
    const { w, id } = await stopped(9);
    const result = runCli(["explain", id, "--json"], w.env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("recomendó la respuesta 9");
    const watch = JSON.parse(runCli(["watch", "--json"], w.env).stdout) as {
      runs: { id: string; explicacion?: { estado: string; motivo?: string } }[];
    };
    expect(watch.runs.find((r) => r.id === id)?.explicacion).toMatchObject({ estado: "fallo" });
    expect(existsSync(join(w.dir(id), "explicaciones"))).toBe(true);
    expect(readdirSync(join(w.dir(id), "explicaciones")).some((f) => f.endsWith(".md"))).toBe(
      false,
    );
  });

  // Si regresiona, Orca muestra «explicando» para siempre o espera 20 s y corta el comando.
  test("--fondo contesta enseguida y deja la explicación lista al terminar", async () => {
    const { w, id } = await stopped();
    const started = runCli(["explain", id, "--fondo", "--json"], w.env);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ ok: true, estado: "explicando" });
    await waitFor(
      "la explicación lista",
      () => {
        const again = JSON.parse(runCli(["explain", id, "--fondo", "--json"], w.env).stdout) as {
          estado: string;
        };
        return again.estado === "lista";
      },
      60_000,
    );
    expect(explainSessions(w, id)).toHaveLength(1);
    expect(w.notices()).toContain("la explicación está lista");
  });

  // Si regresiona, se gasta una sesión explicando un run que no espera ninguna decisión.
  test("un run que no está detenido no se explica", async () => {
    const w = simWorld({ real: [], scripts: [explicacion(1)], feature: FEATURE });
    const id = w.launch();
    await waitFor("el run entregado", () => w.state(id).status === "entregado", 60_000);
    const result = runCli(["explain", id, "--json"], w.env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("solo se explica un run detenido");
    expect(w.prompts()).not.toContain(EXPLICA);
  });
});
