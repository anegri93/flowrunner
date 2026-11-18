// El servicio de la feature para probarla a mano con la PR abierta (ADR 0042): el CLI real levanta el
// entorno del repo en un proceso aparte, watch lo muestra y se baja al pararlo o al cerrarse el run.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { expect, test } from "vitest";
import { responds } from "../src/probar/entorno.ts";
import { leerServicio } from "../src/store/servicio.ts";
import { leerTurno, turnoFile } from "../src/store/turno.ts";
import { runCli } from "./helpers/cli.ts";
import { delivered, type Delivered } from "./helpers/delivered.ts";
import { freePort, serverScript } from "./helpers/puerto.ts";
import { waitFor } from "./helpers/runs.ts";

/**
 * Un run entregado en un repo que, después de la entrega, dice cómo levantar el entorno: con `probar`
 * antes, el plan simulado tendría que marcar sus criterios `en_entorno`. Va en el checkout, que lee
 * watch, y en el worktree de la feature, que es lo que se levanta.
 */
async function conServicio(): Promise<{ d: Delivered; url: string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const d = await delivered();
  const probar = { levantar: "node server.cjs", urls: { web: url }, sigue_corriendo: true };
  const worktree = join(d.home, "worktrees", d.id, "feature");
  for (const root of [d.work, worktree]) {
    const file = join(root, ".flowrunner", "config.yaml");
    writeFileSync(file, stringify({ ...(parse(readFileSync(file, "utf8")) as object), probar }));
  }
  writeFileSync(join(worktree, "server.cjs"), serverScript(port));
  return { d, url };
}

const servicio = (d: Delivered) =>
  (
    JSON.parse(runCli(["watch", d.id, "--json"], d.env).stdout) as {
      runs: { servicio?: { estado: string; urls: Record<string, string>; mensaje: string } }[];
    }
  ).runs[0]?.servicio;

const turno = (d: Delivered) => leerTurno(turnoFile(d.home, d.state(d.id).proyecto, "entorno"));

// Si regresiona, para probar la feature con la PR abierta hay que levantar el entorno a mano en el
// worktree; o queda arriba con el turno del entorno tomado y los runs del proyecto no pueden probar.
test("con la PR abierta, levantar deja la feature respondiendo con el turno del entorno, y parar la baja y lo suelta", async () => {
  const { d, url } = await conServicio();
  expect(servicio(d)).toEqual({ estado: "parado", urls: {}, mensaje: "" });

  const up = runCli(["servicio", d.id, "levantar", "--json"], d.env);
  expect(up.status, up.stdout + up.stderr).toBe(0);
  expect(up.stdout).toContain("levantando el servicio");
  await waitFor("arriba", () => ["arriba", "falla"].includes(servicio(d)?.estado ?? ""), 60_000);
  expect(servicio(d)).toMatchObject({ estado: "arriba", urls: { web: url } });
  expect(await responds(url)).toBe(true);
  expect(turno(d)?.run_id).toBe(d.id);
  // Otra vez levantar no lanza un segundo proceso.
  expect(runCli(["servicio", d.id, "levantar", "--json"], d.env).stdout).toContain(
    "ya está arriba",
  );

  const down = runCli(["servicio", d.id, "parar", "--json"], d.env);
  expect(down.status, down.stdout + down.stderr).toBe(0);
  await waitFor("parado", () => servicio(d)?.estado === "parado", 60_000);
  expect(servicio(d)?.mensaje).toBe("el servicio se bajó: lo paraste");
  expect(await responds(url)).toBe(false);
  expect(turno(d)).toBeUndefined();
}, 300_000);

// Si regresiona, el servicio sigue arriba con el run cerrado: ocupa los puertos y el turno del entorno
// hasta que alguien lo mata a mano.
test("el servicio se baja solo cuando el run deja de tener la PR abierta, y después no se levanta", async () => {
  const { d, url } = await conServicio();
  runCli(["servicio", d.id, "levantar", "--json"], d.env);
  await waitFor("arriba", () => ["arriba", "falla"].includes(servicio(d)?.estado ?? ""), 60_000);
  expect(servicio(d)?.estado).toBe("arriba");

  runCli(["abort", d.id], d.env);
  // Con el run cerrado, watch ya no lo muestra: se lee lo que dejó el proceso.
  const enDisco = () => leerServicio({ dir: d.dir(d.id) }, new Date());
  await waitFor("parado", () => enDisco()?.estado === "parado", 60_000);
  expect(enDisco()?.mensaje).toBe("el servicio se bajó: el run quedó abortado");
  expect(servicio(d)).toBeUndefined();
  expect(await responds(url)).toBe(false);
  expect(turno(d)).toBeUndefined();

  const again = runCli(["servicio", d.id, "levantar", "--json"], d.env);
  expect(again.status).toBe(1);
  expect(again.stdout).toContain("el servicio es para probar la feature con la PR abierta");
}, 300_000);
