import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TEST_BIN } from "../../test/helpers/cli.ts";
import { git, tempDir } from "../../test/helpers/git.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { PLAN } from "../../test/helpers/plan-fixtures.ts";
import { appendEvent, readLog } from "../store/run-log.ts";
import { leaseFile } from "./feedback.ts";
import { entregar } from "./entregar.ts";

async function delivered() {
  const home = tempDir("gh-home-");
  const notices: string[] = [];
  const deps = testDeps({
    notify: (_t, body) => notices.push(body),
    env: { ...testDeps().env, HOME: home, PATH: `${TEST_BIN}:${process.env.PATH ?? ""}` },
  });
  const planned = await plannedRun(PLAN, { "tests/ac1.mjs": "process.exit(0);\n" }, deps);
  const ghLog = () =>
    readFileSync(join(home, "gh.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
  return { ...planned, deps, home, notices, ghLog };
}

describe("entregar", () => {
  test("primera entrega: push de la rama y un pr create con la rama y el título correctos", async () => {
    const { run, deps, ghLog, work, notices } = await delivered();
    expect(await entregar(contextFor(run, "entregar", deps))).toEqual({ tipo: "ok" });
    const creates = ghLog().filter((a) => a[0] === "pr" && a[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual(
      expect.arrayContaining([
        "--head",
        "feat/SHOP-214-exportar-pedidos-a-csv",
        "--base",
        "main",
        "--title",
        "SHOP-214 · Exportar pedidos a CSV",
      ]),
    );
    expect(
      git(work, "ls-remote", "--heads", "origin", "feat/SHOP-214-exportar-pedidos-a-csv"),
    ).not.toBe("");
    expect(readLog(run.dir).events.findLast((e) => e.tipo === "pr")).toMatchObject({
      numero: 412,
      url: "https://github.com/acme/acme-api/pull/412",
    });
    // El aviso de la PR abierta lo da el runner al cambiar de estado, no la fase.
    expect(notices).toEqual([]);
  });

  // Si regresiona, retomar un run después de abrir la PR abre otra PR para la misma rama.
  test("retomar después de crear la PR no hace un segundo create", async () => {
    const { run, deps, ghLog } = await delivered();
    await entregar(contextFor(run, "entregar", deps));
    expect(await entregar(contextFor(run, "entregar", deps))).toEqual({ tipo: "ok" });
    expect(ghLog().filter((a) => a[1] === "create")).toHaveLength(1);
  });

  // Si regresiona, flowrunner mergea una PR de feature sin que nadie la revise.
  test("el registro de gh nunca contiene merge en una PR de feature", async () => {
    const { run, deps, ghLog } = await delivered();
    await entregar(contextFor(run, "entregar", deps));
    expect(ghLog().some((a) => a.includes("merge"))).toBe(false);
  });

  test("una PR ya mergeada no se vuelve a abrir: invariante", async () => {
    const { run, deps, home } = await delivered();
    await entregar(contextFor(run, "entregar", deps));
    const stateFile = join(home, "gh-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: { state: string }[] };
    for (const pr of state.prs) pr.state = "MERGED";
    writeFileSync(stateFile, JSON.stringify(state));
    expect(await entregar(contextFor(run, "entregar", deps))).toMatchObject({
      tipo: "falla",
      clase: "invariante",
    });
  });

  test("gh que falla es falla de infraestructura", async () => {
    const { run, deps } = await delivered();
    const failing = { ...deps, env: { ...deps.env, FAKE_GH_FAIL_CREATE: "1" } };
    expect(await entregar(contextFor(run, "entregar", failing))).toMatchObject({
      tipo: "falla",
      clase: "infra",
    });
  });

  describe("después de tu feedback (ADR 0038)", () => {
    const BRANCH = "feat/SHOP-214-exportar-pedidos-a-csv";
    const remoteSha = (work: string) =>
      git(work, "ls-remote", "origin", `refs/heads/${BRANCH}`).split(/\s/)[0];
    const commit = (dir: string, file: string, text: string) => {
      writeFileSync(join(dir, file), text);
      git(dir, "add", file);
      git(dir, "commit", "-qm", `toca ${file}`);
    };

    // Si regresiona, mergear la PR mientras se rehace deja el run detenido en entregar para siempre,
    // sin aprender del merge, y empuja a una rama ya mergeada.
    test("si la PR se mergeó mientras se rehacía, no empuja y sigue a aprender con un aviso", async () => {
      const { run, deps, home, featureWt, work } = await delivered();
      await entregar(contextFor(run, "entregar", deps));
      appendEvent(run.dir, { tipo: "feedback_pedido", texto: "otra cosa", origen: "orca" });
      const stateFile = join(home, "gh-state.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: { state: string }[] };
      for (const pr of state.prs) pr.state = "MERGED";
      writeFileSync(stateFile, JSON.stringify(state));
      const antes = remoteSha(work);
      commit(featureWt, "rehecho.txt", "rehecho\n");
      expect(await entregar(contextFor(run, "entregar", deps))).toEqual({ tipo: "ok" });
      expect(remoteSha(work)).toBe(antes);
      expect(readLog(run.dir).events.findLast((e) => e.tipo === "aviso")).toMatchObject({
        texto: expect.stringMatching(/se mergeó mientras se rehacía/) as unknown,
      });
    });

    // Si regresiona, un commit que empujaste a la PR mientras se rehacía desaparece con el push
    // forzado de la entrega, aunque un fetch de otro run haya puesto al día el ref de seguimiento.
    test("no pisa lo que empujaste mientras se rehacía; después de traerlo, entrega", async () => {
      const { run, deps, featureWt, work } = await delivered();
      await entregar(contextFor(run, "entregar", deps));
      appendEvent(run.dir, { tipo: "feedback_pedido", texto: "otra cosa", origen: "orca" });
      // Las lecciones de esta entrega ya están: este test es sobre el push.
      appendEvent(run.dir, { tipo: "lecciones_propuestas", cantidad: 0 });
      writeFileSync(leaseFile(run), `${remoteSha(work) ?? ""}\n`);
      const persona = tempDir("persona-");
      git(persona, "clone", "-q", "-b", BRANCH, git(work, "remote", "get-url", "origin"), ".");
      commit(persona, "tuyo.txt", "lo empujé yo\n");
      git(persona, "push", "-q", "origin", BRANCH);
      const tuyo = git(persona, "rev-parse", "HEAD");
      git(work, "fetch", "-q", "origin");
      commit(featureWt, "rehecho.txt", "rehecho\n");

      expect(await entregar(contextFor(run, "entregar", deps))).toMatchObject({
        tipo: "falla",
        clase: "entorno",
        motivo: expect.stringMatching(/empujaste a feat\/SHOP-214/) as unknown,
      });
      expect(remoteSha(work)).toBe(tuyo);

      git(featureWt, "merge", "-q", "--no-edit", `origin/${BRANCH}`);
      expect(await entregar(contextFor(run, "entregar", deps))).toEqual({ tipo: "ok" });
      expect(git(work, "fetch", "-q", "origin")).toBe("");
      expect(git(work, "merge-base", "--is-ancestor", tuyo, `origin/${BRANCH}`)).toBe("");
    });
  });
});
