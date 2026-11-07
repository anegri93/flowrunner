import { describe, expect, test } from "vitest";
import { git } from "../../test/helpers/git.ts";
import { contextFor, makeProject, newRun, testDeps } from "../../test/helpers/project.ts";
import { readLog } from "../store/run-log.ts";
import { prepared } from "./inputs.ts";
import { preparar } from "./preparar.ts";

describe("preparar", () => {
  test("base en verde: worktree en la rama de la feature, en el sha de origin/main y limpio", async () => {
    const { work } = makeProject();
    const run = newRun(work);
    const outcome = await preparar(contextFor(run, "preparar", testDeps()));
    expect(outcome).toEqual({ tipo: "ok" });
    const done = prepared(readLog(run.dir).events);
    expect(done.rama).toBe("feat/SHOP-214-exportar-pedidos-a-csv");
    expect(done.base_sha).toBe(git(work, "rev-parse", "origin/main"));
    // graft se construyó afuera: el worktree queda sin archivos nuevos.
    expect(git(done.worktree, "status", "--porcelain")).toBe("");
  });

  // Si regresiona, flowrunner gasta tokens implementando sobre una base que ya estaba rota.
  test("base roja: falla de entorno con la salida de verify y sin reintento", async () => {
    const { work } = makeProject({ verify: 'echo "3 tests fallan" >&2\nexit 1' });
    const outcome = await preparar(contextFor(newRun(work), "preparar", testDeps()));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(
      /no está en verde[\s\S]*3 tests fallan/,
    );
  });

  // Si regresiona, un setup que no existe se reintenta como si el modelo pudiera arreglarlo.
  test("un setup que no existe es una falla de entorno con exit 127", async () => {
    const { work } = makeProject({ config: { setup: "comando-que-no-existe-xyz" } });
    const outcome = await preparar(contextFor(newRun(work), "preparar", testDeps()));
    expect(outcome).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(/salió 127/);
  });

  test("un verify que no es ejecutable se informa como tal", async () => {
    const { work } = makeProject();
    git(work, "update-index", "--chmod=-x", ".flowrunner/verify.sh");
    git(work, "commit", "-q", "-m", "sin x");
    git(work, "push", "-q", "origin", "main");
    const outcome = await preparar(contextFor(newRun(work), "preparar", testDeps()));
    expect(outcome.tipo === "falla" && outcome.motivo).toMatch(
      /no se pudo ejecutar verify.*no es ejecutable/,
    );
  });

  test("rehacer preparar sobre el mismo run rearma el worktree", async () => {
    const { work } = makeProject();
    const run = newRun(work);
    await preparar(contextFor(run, "preparar", testDeps()));
    expect(await preparar(contextFor(run, "preparar", testDeps()))).toEqual({ tipo: "ok" });
  });
});
