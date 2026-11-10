// Autofix (ADR 0026) con el CLI real, git de verdad y las fases falsas: FAKE_VUELVE hace que verificar
// devuelva trabajo la primera vez, y la segunda pase.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writePlanArtifacts } from "../src/phases/planificar.ts";
import { readLog } from "../src/store/run-log.ts";
import { runPaths } from "../src/store/runs.ts";
import { homeWith, runCli } from "./helpers/cli.ts";
import { git, tempDir } from "./helpers/git.ts";
import { PLAN } from "./helpers/plan-fixtures.ts";
import { makeProject } from "./helpers/project.ts";
import { executions, FAKE_PHASES, FEATURE, stateNow, waitFor } from "./helpers/runs.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// El «formateador» del repo: cambia «mal formato» por «buen formato» en las rutas que recibe.
const FMT = `import { readFileSync, writeFileSync } from "node:fs";
for (const p of process.argv.slice(2))
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("mal formato", "buen formato"));
`;

/** Un run detenido en verificar con ST-1, con su worktree real y un repo con formateador. */
async function stopped() {
  const { work } = makeProject({
    files: { "fmt.mjs": FMT },
    config: { format: "node fmt.mjs" },
  });
  const env: NodeJS.ProcessEnv = {
    ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
    FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
    FAKE_KEEP_REAL: "preparar",
    FAKE_VUELVE: "ST-1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const home = join(env.HOME ?? "", ".flowrunner");
  const feature = join(tempDir(), "SHOP-214.md");
  writeFileSync(feature, FEATURE);
  const started = runCli(["run", feature, "--json"], env);
  expect(started.status, started.stderr).toBe(0);
  const id = (JSON.parse(started.stdout) as { id: string }).id;
  const run = runPaths(home, id);
  const w = { home, env, repo: work, feature };
  await waitFor("el run detenido", () => stateNow(w, id).status === "detenido", 60_000);
  const preparado = readLog(run.dir).events.find((e) => e.tipo === "preparado");
  const worktree = preparado?.tipo === "preparado" ? preparado.worktree : "";
  // Lo que habría commiteado implementar, sin formatear: código y un test bloqueado del plan.
  const test = "test('a', () => {}); // mal formato\n";
  writeFileSync(join(worktree, "a.ts"), "export const a = 1; // mal formato\n");
  writeFileSync(join(worktree, "a.test.ts"), test);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "feat: ST-1");
  writePlanArtifacts(run, PLAN, { "a.test.ts": sha256(test) });
  return { id, run, env, w, worktree };
}

describe("Autofix", () => {
  // Si regresiona, Autofix no destraba un rojo de formato (PIZ-2): no formatea lo de la rama, deja
  // un test bloqueado con su hash viejo, o no vuelve a verificar.
  test("formatea lo que cambió la rama en un commit propio, actualiza el hash bloqueado y verifica", async () => {
    const { id, run, env, w, worktree } = await stopped();
    expect(runCli(["status", id], env).stdout).toContain(`flowrunner fix ${id} --auto`);

    const auto = runCli(["fix", id, "--auto", "--origen", "orca", "--json"], env);
    expect(auto.status, auto.stdout + auto.stderr).toBe(0);
    expect(JSON.parse(auto.stdout)).toMatchObject({
      ok: true,
      accion: "autofix: formato y lint commiteados; verificar arrancó",
    });
    expect(readFileSync(join(worktree, "a.ts"), "utf8")).toContain("buen formato");
    const formatted = readFileSync(join(worktree, "a.test.ts"), "utf8");
    expect(formatted).toContain("buen formato");
    expect(git(worktree, "log", "-1", "--format=%B")).toContain(`Flowrunner-Run: ${id}`);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    const locked = JSON.parse(readFileSync(join(run.dir, "locked.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(locked["a.test.ts"]).toBe(sha256(formatted));
    const event = readLog(run.dir).events.find((e) => e.tipo === "autofix");
    expect(event).toMatchObject({ tipo: "autofix", origen: "orca" });
    expect(event?.tipo === "autofix" ? event.sha : null).toBe(git(worktree, "rev-parse", "HEAD"));

    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado", 60_000);
    expect(executions(w, id).filter((f) => f === "verificar")).toHaveLength(2);
    expect(executions(w, id).filter((f) => f === "implementar")).toHaveLength(1);
  });

  // Si regresiona, Autofix commitea como suyo un cambio que no hicieron las herramientas.
  test("con cambios sin commitear en el worktree, o con otras opciones, se niega sin escribir nada", async () => {
    const { id, run, env, worktree } = await stopped();
    const log = () => readFileSync(join(run.dir, "events.jsonl"), "utf8");
    const before = log();
    writeFileSync(join(worktree, "suelto.ts"), "export const b = 2;\n");
    const dirty = runCli(["fix", id, "--auto"], env);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("tiene cambios sin commitear");
    const mixed = runCli(["fix", id, "--auto", "--yo"], env);
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("--auto va solo");
    expect(log()).toBe(before);
    expect(readFileSync(join(worktree, "a.ts"), "utf8")).toContain("mal formato");
  });

  // Si regresiona, un run que ya eligió arreglarlo a mano (PIZ-2) no se puede destrabar con Autofix,
  // o Autofix pisa lo que la persona empezó a tocar.
  test("durante un arreglo a mano sin empezar sirve; con algo tocado, manda a resume", async () => {
    const { id, env, w, worktree } = await stopped();
    expect(runCli(["fix", id, "--yo"], env).status).toBe(0);
    writeFileSync(join(worktree, "a.ts"), "export const a = 2; // mal formato\n");
    const touched = runCli(["fix", id, "--auto"], env);
    expect(touched.status).toBe(1);
    expect(touched.stderr).toContain("ya empezaste a arreglarlo a mano");
    expect(touched.stderr).toContain(`flowrunner resume ${id}`);
    git(worktree, "checkout", "-q", "--", "a.ts");
    const auto = runCli(["fix", id, "--auto", "--json"], env);
    expect(auto.status, auto.stdout + auto.stderr).toBe(0);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado", 60_000);
  });
});
