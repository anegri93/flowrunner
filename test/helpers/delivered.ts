// Un run entregado de verdad, con el SDK simulado y el gh falso, listo para probar aprender.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { git, tempDir } from "./git.ts";
import { FEATURE, PLAN, WRITE_TEST } from "./plan-fixtures.ts";
import type { ProjectOptions } from "./project.ts";
import { waitFor } from "./runs.ts";
import type { SimScript } from "./sim-sdk.ts";
import { simWorld, type SimWorld } from "./sim-world.ts";

export const BRANCH = "feat/SHOP-214-exportar-pedidos-a-csv";

interface FakePr {
  number: number;
  state: string;
  headRefName: string;
  commits: {
    oid: string;
    messageHeadline: string;
    messageBody: string;
    authors: { login: string }[];
  }[];
  comments: { author: { login: string }; body: string; url: string }[];
  reviews: { author: { login: string }; body: string }[];
  autoMerge: boolean;
  title: string;
  body: string;
  url: string;
}

export interface Delivered extends SimWorld {
  readonly id: string;
  readonly ghState: () => { prs: FakePr[] };
  readonly setPr: (number: number, change: (pr: FakePr) => void) => void;
  /** Un commit de `login` sobre la rama de la feature en el remote, como lo haría la persona. */
  readonly pushCorrection: (login: string, file: string, content: string) => string;
  readonly ghLog: () => string[][];
}

export async function delivered(
  learnScripts: SimScript[] = [],
  project: ProjectOptions = {},
): Promise<Delivered> {
  const w = simWorld({
    real: [
      "preparar",
      "planificar",
      "aprobar",
      "implementar",
      "verificar",
      "revisar",
      "entregar",
      "aprender",
    ],
    scripts: [
      { calls: [WRITE_TEST], output: PLAN },
      {
        calls: [
          {
            tool: "Write",
            input: { file_path: "src/export/csv.js", content: "export const csv = 1;\n" },
          },
        ],
      },
      { output: { hallazgos: [], decisiones: [] } },
      ...learnScripts,
    ],
    feature: FEATURE,
    project: { config: { setup: "true", tests_globs: ["tests/**"] }, ...project },
  });
  const id = w.launch();
  await waitFor("esperando", () => w.state(id).status === "esperando_aprobacion", 60_000);
  runCli(["approve", id], w.env);
  await waitFor("entregado", () => ["entregado", "detenido"].includes(w.state(id).status), 90_000);
  if (w.state(id).status !== "entregado")
    throw new Error(`no se entregó: ${w.state(id).halt?.motivo ?? ""}`);
  const stateFile = join(w.env.HOME ?? "", "gh-state.json");
  const ghState = () => JSON.parse(readFileSync(stateFile, "utf8")) as { prs: FakePr[] };
  const setPr = (number: number, change: (pr: FakePr) => void) => {
    const s = ghState();
    const pr = s.prs.find((p) => p.number === number);
    if (pr === undefined) throw new Error(`no hay PR ${number}`);
    change(pr);
    writeFileSync(stateFile, JSON.stringify(s));
  };
  // Los commits de la PR son los de la rama en el remote, con sus autores como logins de GitHub.
  const syncCommits = (authors: Record<string, string>) => {
    const log = git(w.remote, "log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `main..${BRANCH}`);
    const commits = log
      .split("\x1e")
      .map((c) => c.trim())
      .filter((c) => c !== "")
      .map((c) => {
        const [oid = "", headline = "", body = ""] = c.split("\x1f");
        return {
          oid,
          messageHeadline: headline,
          messageBody: body,
          authors: [{ login: authors[oid] ?? "flowrunner-bot" }],
        };
      });
    setPr(412, (pr) => (pr.commits = commits));
  };
  const corrections: Record<string, string> = {};
  syncCommits(corrections);
  return {
    ...w,
    id,
    ghState,
    setPr,
    pushCorrection(login, file, content) {
      const clone = join(tempDir(), "c");
      execFileSync("git", ["clone", "-q", "-b", BRANCH, w.remote, clone]);
      writeFileSync(join(clone, file), content);
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "-m", `fix: corrección de ${login}`);
      git(clone, "push", "-q", "origin", BRANCH);
      const oid = git(clone, "rev-parse", "HEAD");
      corrections[oid] = login;
      syncCommits(corrections);
      return oid;
    },
    ghLog: () =>
      readFileSync(join(w.env.HOME ?? "", "gh.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[]),
  };
}
