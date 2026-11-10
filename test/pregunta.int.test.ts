// El run que se detiene y pregunta (ADR 0023), con el CLI real y las fases falsas: FAKE_VUELVE hace
// que verificar devuelva trabajo la primera vez.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PLAN } from "./helpers/plan-fixtures.ts";
import { writePlanArtifacts } from "../src/phases/planificar.ts";
import { readLog } from "../src/store/run-log.ts";
import { runPaths } from "../src/store/runs.ts";
import { homeWith, runCli } from "./helpers/cli.ts";
import { git, tempDir } from "./helpers/git.ts";
import { makeProject } from "./helpers/project.ts";
import {
  executions,
  FAKE_PHASES,
  FEATURE,
  launch,
  runDir,
  stateNow,
  waitFor,
  world,
} from "./helpers/runs.ts";

const events = (dir: string) => readLog(dir).events;

describe("detenido con pregunta", () => {
  // Si regresiona, el primer rojo dispara otra sesión de implementar sin que nadie la pida, o la
  // respuesta de la persona no la retoma (VF-6).
  test("con 0 vueltas, verificar en rojo detiene; fix --unidad corre solo esa sub-task y vuelve a verificar", async () => {
    const w = world({ FAKE_VUELVE: "ST-1" });
    const id = launch(w);
    await waitFor("el run detenido", () => stateNow(w, id).status === "detenido");
    const halted = stateNow(w, id);
    expect(halted.fase).toBe("verificar");
    expect(halted.halt?.unidades).toEqual(["ST-1"]);
    expect(executions(w, id).filter((f) => f === "implementar")).toHaveLength(1);

    const status = runCli(["status", id], w.env);
    expect(status.stdout).toContain(
      `Opciones:\n  flowrunner fix ${id} --unidad ST-1 "<qué cambiar>"  ·  `,
    );

    const fixed = runCli(["fix", id, "--unidad", "ST-1", "x", "--json"], w.env);
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(JSON.parse(fixed.stdout)).toMatchObject({ ok: true, id });
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id).filter((f) => f === "implementar")).toHaveLength(2);
    expect(executions(w, id).filter((f) => f === "verificar")).toHaveLength(2);
    expect(events(runDir(w, id))).toContainEqual(
      expect.objectContaining({
        tipo: "arreglo_pedido",
        unidades: ["ST-1"],
        instruccion: "x",
        origen: "terminal",
      }),
    );
  });

  // Si regresiona, un comando escribe una respuesta que el run no esperaba y el log queda con ella.
  test("fix sobre un run que no ofrece fix sale 1 y lista las opciones", async () => {
    const w = world({ FAKE_VUELVE: "ST-1" });
    const id = launch(w);
    await waitFor("el run detenido", () => stateNow(w, id).status === "detenido");
    // Detenido en verificar, ofrece ST-1 y no ST-9.
    const other = runCli(["fix", id, "--unidad", "ST-9", "x"], w.env);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(`el run ${id} no ofrece eso ahora (está detenido en verificar)`);
    expect(other.stderr).toContain(`flowrunner fix ${id} --unidad ST-1 "<qué cambiar>"`);
    expect(other.stderr).toContain(`Para seguir: flowrunner status ${id}`);
    const sinInstruccion = runCli(["fix", id, "--unidad", "ST-1"], w.env);
    expect(sinInstruccion.status).toBe(1);
    expect(sinInstruccion.stderr).toMatch(/falta la instrucción/);
    // Una sub-task se compara entera, no por prefijo del comando que ofrece el halt.
    const prefix = runCli(["fix", id, "--unidad", 'ST-1 "<qué', "x"], w.env);
    expect(prefix.status).toBe(1);
    expect(prefix.stderr).toContain("no ofrece eso ahora");
    const both = runCli(["fix", id, "--yo", "--unidad", "ST-1", "x"], w.env);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("--yo y --unidad no van juntos");
    const origen = runCli(["fix", id, "--yo", "--origen", "web"], w.env);
    expect(origen.status).toBe(1);
    expect(origen.stderr).toContain("--origen tiene que ser terminal, claude u orca");

    expect(runCli(["accept", id, "sigue"], w.env).status).toBe(0);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    const before = readFileSync(join(runDir(w, id), "events.jsonl"), "utf8");
    for (const args of [
      ["fix", id, "--unidad", "ST-1", "x"],
      ["fix", id, "--yo"],
      ["accept", id, "otra vez"],
    ]) {
      const result = runCli(args, w.env);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain(`el run ${id} no ofrece eso ahora (está entregado`);
    }
    expect(readFileSync(join(runDir(w, id), "events.jsonl"), "utf8")).toBe(before);
  });

  // Si regresiona, lo que la persona arregla a mano no llega a la rama, o llega sin verificar.
  test("fix --yo da el worktree; resume commitea el cambio a mano y sigue en verificar", async () => {
    const { work } = makeProject();
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
    // Planificar es falsa: el plan que leería resume lo deja el test, sin tests bloqueados.
    writePlanArtifacts(run, PLAN, {});

    const yo = runCli(["fix", id, "--yo", "--json"], env);
    expect(yo.status, yo.stdout + yo.stderr).toBe(0);
    const preparado = events(run.dir).find((e) => e.tipo === "preparado");
    const worktree = preparado?.tipo === "preparado" ? preparado.worktree : "";
    expect(existsSync(worktree)).toBe(true);
    expect(JSON.parse(yo.stdout)).toMatchObject({
      ok: true,
      accion: `editá ${worktree} y después: flowrunner resume ${id}`,
    });
    expect(stateNow(w, id)).toMatchObject({ status: "detenido", aMano: true });
    expect(executions(w, id).filter((f) => f === "verificar")).toHaveLength(1);

    // Un secreto no se commitea: resume sale 1, lo dice y no escribe nada.
    writeFileSync(join(worktree, "secreto.ts"), `export const t = "ghp_${"a".repeat(36)}";\n`);
    const refused = runCli(["resume", id], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("secreto.ts agrega un token de GitHub");
    expect(events(run.dir).some((e) => e.tipo === "arreglo_manual")).toBe(false);
    expect(git(worktree, "status", "--porcelain")).toContain("secreto.ts");

    git(worktree, "clean", "-fdq");
    writeFileSync(join(worktree, "CLAUDE.md"), "# reglas\nCorré npm run mac para la Mac.\n");
    const resumed = runCli(["resume", id, "--json"], env);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const manual = events(run.dir).find((e) => e.tipo === "arreglo_manual");
    const sha = manual?.tipo === "arreglo_manual" ? manual.sha : null;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(worktree, "log", "-1", "--format=%B", sha ?? "")).toContain(
      `Flowrunner-Manual: ${id}`,
    );
    expect(events(run.dir).some((e) => e.tipo === "reanudado")).toBe(false);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado", 60_000);
    expect(executions(w, id).filter((f) => f === "verificar")).toHaveLength(2);
    expect(executions(w, id).filter((f) => f === "implementar")).toHaveLength(1);
  });

  // Si regresiona, seguir con un rojo no queda dicho en la PR, o no se puede seguir sin replanificar.
  test("accept con motivo sigue a revisar, y el motivo queda en el informe", async () => {
    const w = world({ FAKE_VUELVE: "ST-1" });
    const id = launch(w);
    await waitFor("el run detenido", () => stateNow(w, id).status === "detenido");
    const sinMotivo = runCli(["accept", id], w.env);
    expect(sinMotivo.status).toBe(1);
    expect(sinMotivo.stderr).toMatch(/falta el motivo/);
    const accepted = runCli(
      ["accept", id, "AC-1", "es", "flaky", "--origen", "claude", "--json"],
      w.env,
    );
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ accion: "aceptado: revisar arrancó" });
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");
    expect(executions(w, id).filter((f) => f === "verificar")).toHaveLength(1);
    expect(executions(w, id)).toContain("revisar");
    expect(events(runDir(w, id))).toContainEqual(
      expect.objectContaining({
        tipo: "aceptado",
        fase: "verificar",
        motivo: "AC-1 es flaky",
        origen: "claude",
      }),
    );
    // El proceso que se detuvo ya dejó un informe: el que vale es el que escribe al entregar.
    const report = () => {
      const file = join(runDir(w, id), "informe.md");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    };
    await waitFor("el informe de la entrega", () => report().includes("entregado"));
    expect(report()).toContain("## Lo que aceptaste al seguir\n\n- en verificar: AC-1 es flaky");
  });

  // Regresión de la revisión: accept-untested o rerun durante un arreglo a mano entregaban una PR sin
  // el cambio, que quedaba sin commitear en el worktree; y un run abortado se intentaba retomar.
  test("con un arreglo a mano pendiente, accept-untested y rerun se niegan; abortado, resume también", async () => {
    const { work } = makeProject();
    const env: NodeJS.ProcessEnv = {
      ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
      FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
      FAKE_KEEP_REAL: "preparar",
      FAKE_SIN_PROBAR: "1",
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
    expect(stateNow(w, id)).toMatchObject({ fase: "probar", sinProbar: true });
    writePlanArtifacts(run, PLAN, {});
    expect(runCli(["fix", id, "--yo"], env).status).toBe(0);
    const preparado = events(run.dir).find((e) => e.tipo === "preparado");
    const worktree = preparado?.tipo === "preparado" ? preparado.worktree : "";
    writeFileSync(join(worktree, "arreglo.ts"), "export const x = 1;\n");
    const before = readFileSync(join(run.dir, "events.jsonl"), "utf8");

    const untested = runCli(["accept-untested", id, "igual"], env);
    expect(untested.status).toBe(1);
    expect(untested.stderr).toContain(`flowrunner resume ${id}`);
    const rerun = runCli(["rerun", id, "--desde", "probar"], env);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("sin commitear");
    expect(readFileSync(join(run.dir, "events.jsonl"), "utf8")).toBe(before);

    expect(runCli(["abort", id], env).status).toBe(0);
    const resumed = runCli(["resume", id], env);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toMatch(/está abortado: no hay nada que retomar/);
  });

  /** Un run detenido en verificar con el arreglo a mano iniciado: el worktree, listo para editar. */
  async function byHand(locked: Record<string, string> = {}) {
    const { work } = makeProject();
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
    writePlanArtifacts(run, PLAN, locked);
    const yo = runCli(["fix", id, "--yo"], env);
    expect(yo.status, yo.stdout + yo.stderr).toBe(0);
    const preparado = events(run.dir).find((e) => e.tipo === "preparado");
    const worktree = preparado?.tipo === "preparado" ? preparado.worktree : "";
    const commit = (file: string, content: string) => {
      writeFileSync(join(worktree, file), content);
      git(worktree, "add", "-A");
      git(worktree, "commit", "-q", "-m", `mano: ${file}`);
    };
    return { id, env, run, w, worktree, commit };
  }

  // Regresión: resume miraba solo lo que no estaba commiteado, y un secreto que la persona (o Claude
  // en el worktree) commiteaba por su cuenta llegaba a la PR.
  test("un secreto que la persona commiteó por su cuenta durante fix --yo no pasa resume", async () => {
    const r = await byHand();
    r.commit("token.ts", `export const t = "ghp_${"a".repeat(36)}";\n`);
    // Aunque después lo borre: el commit con el secreto sigue en la rama.
    git(r.worktree, "rm", "-q", "token.ts");
    git(r.worktree, "commit", "-q", "-m", "mano: sin token");
    const resumed = runCli(["resume", r.id], r.env);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("token.ts agrega un token de GitHub");
    expect(events(r.run.dir).some((e) => e.tipo === "arreglo_manual")).toBe(false);
  });

  // Regresión: un test bloqueado cambiado en un commit propio pasaba resume, y recién lo frenaba verificar.
  test("un test bloqueado cambiado en un commit propio de la persona tampoco", async () => {
    const readme = readFileSync(join(makeProject().work, "README.md"), "utf8");
    const r = await byHand({
      "README.md": createHash("sha256").update(readme).digest("hex"),
    });
    r.commit("README.md", "# otro\n");
    const resumed = runCli(["resume", r.id], r.env);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("README.md es un test bloqueado del plan");
    expect(events(r.run.dir).some((e) => e.tipo === "arreglo_manual")).toBe(false);
  });

  // Si regresiona, la PR no nombra el arreglo que la persona commiteó, o flowrunner suma un commit vacío.
  test("un commit propio limpio pasa y arreglo_manual lleva su sha", async () => {
    const r = await byHand();
    r.commit("CLAUDE.md", "# reglas\n");
    const head = git(r.worktree, "rev-parse", "HEAD");
    const resumed = runCli(["resume", r.id, "--json"], r.env);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(events(r.run.dir)).toContainEqual(
      expect.objectContaining({ tipo: "arreglo_manual", sha: head }),
    );
    expect(git(r.worktree, "rev-parse", "HEAD")).toBe(head);
    await waitFor("el run entregado", () => stateNow(r.w, r.id).status === "entregado", 60_000);
  });

  // Si regresiona, un reset o un rebase saca de la rama lo que ya estaba integrado y nadie lo chequea.
  test("si base ya no es ancestro de HEAD, resume se niega", async () => {
    const r = await byHand();
    const parent = git(r.worktree, "rev-parse", "HEAD~1");
    git(r.worktree, "reset", "-q", "--hard", parent);
    const resumed = runCli(["resume", r.id], r.env);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("el worktree ya no parte de donde lo dejó fix --yo");
    expect(events(r.run.dir).some((e) => e.tipo === "arreglo_manual")).toBe(false);
  });
});
