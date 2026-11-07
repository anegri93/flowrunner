import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TEST_BIN } from "../../test/helpers/cli.ts";
import { git, tempDir } from "../../test/helpers/git.ts";
import { plannedRun } from "../../test/helpers/planned.ts";
import { contextFor, testDeps } from "../../test/helpers/project.ts";
import { PLAN } from "../../test/helpers/plan-fixtures.ts";
import { readLog } from "../store/run-log.ts";
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
    expect(notices[0]).toBe("SHOP-214: PR abierta. Pedile a Claude que te explique el informe.");
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
});
