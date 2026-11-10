import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, repoWith } from "../../test/helpers/git.ts";
import type { Subtask } from "../gates/plan.ts";
import { commitAll } from "../git/git.ts";
import type { NewEvent } from "../store/events.ts";
import { commitsDeLaRama, reaplicar } from "./conservar.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function commit(
  repo: string,
  files: Record<string, string>,
  trailers: Record<string, string>,
) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return (await commitAll(repo, Object.keys(files).join(" "), trailers, ENV)) ?? "";
}

const st = (id: string, depende_de: string[] = []): Subtask => ({
  id,
  titulo: id,
  descripcion: id,
  alcance: [`src/${id}/`],
  dependencias: [],
  depende_de,
});

/** Una rama como la deja implementar: los tests del plan, ST-1, un arreglo de ST-1 después de ST-2, y un manual. */
async function rama() {
  const repo = repoWith({ "README.md": "# r\n", "compartido.txt": "uno\n" });
  const base = git(repo, "rev-parse", "HEAD");
  await commit(repo, { "tests/ac1.mjs": "x\n" }, { "Flowrunner-Run": "R" });
  const a1 = await commit(repo, { "src/ST-1/a.js": "1\n" }, { "Flowrunner-Subtask": "ST-1" });
  const b1 = await commit(repo, { "src/ST-2/b.js": "2\n" }, { "Flowrunner-Subtask": "ST-2" });
  const a2 = await commit(repo, { "src/ST-1/a.js": "1 bis\n" }, { "Flowrunner-Subtask": "ST-1" });
  const m = await commit(repo, { "docs/nota.md": "a mano\n" }, { "Flowrunner-Manual": "R" });
  return { repo, base, a1, a2, b1, m };
}

describe("commitsDeLaRama", () => {
  // Si regresiona, un replan pierde un arreglo de la sub-task o un arreglo a mano, o conserva los
  // tests del plan viejo como si fueran código.
  test("agrupa los commits por sub-task en el orden en que aparece cada una, aparte los manuales, y deja afuera los tests del plan", async () => {
    const { repo, base, a1, a2, b1, m } = await rama();
    expect(await commitsDeLaRama(repo, base, ENV)).toEqual({
      subtasks: [
        { id: "ST-1", shas: [a1, a2] },
        { id: "ST-2", shas: [b1] },
      ],
      manuales: [m],
    });
  });
});

describe("reaplicar", () => {
  const collect = () => {
    const avisos: string[] = [];
    const emit = (e: NewEvent) => {
      if (e.tipo === "aviso") avisos.push(e.texto);
      return { ...e, at: "" } as never;
    };
    return { avisos, emit };
  };

  // Si regresiona, la rama nueva pierde el arreglo a mano o lo pone antes que las sub-tasks.
  test("rearma la base con las sub-tasks enteras y los manuales al final", async () => {
    const { repo, base } = await rama();
    const r = await commitsDeLaRama(repo, base, ENV);
    const { emit, avisos } = collect();
    const out = await reaplicar(repo, base, r, [st("ST-1"), st("ST-2")], ENV, emit);
    expect(out.candidatas.map((c) => c.id)).toEqual(["ST-1", "ST-2"]);
    expect(git(repo, "log", "--reverse", "--format=%s", `${base}..HEAD`).split("\n")).toEqual([
      "src/ST-1/a.js",
      "src/ST-1/a.js",
      "src/ST-2/b.js",
      "docs/nota.md",
    ]);
    expect(out.nuevos["ST-1"]).toHaveLength(2);
    expect(existsSync(join(repo, "tests/ac1.mjs"))).toBe(false);
    expect(avisos).toEqual([]);
  });

  // Si regresiona, una sub-task que chocó queda a medias en la rama, o queda conservado código que se
  // apoyaba en ella.
  test("una sub-task que choca sale entera, junto con las que dependen de ella, y se avisa", async () => {
    const repo = repoWith({ "README.md": "# r\n", "compartido.txt": "uno\n" });
    const base = git(repo, "rev-parse", "HEAD");
    // Un commit sin trailer cambia la línea que después pisa ST-1: sin él, el cherry-pick de ST-1 choca.
    await commit(repo, { "compartido.txt": "dos\n" }, { "Flowrunner-Run": "R" });
    const a1 = await commit(repo, { "src/ST-1/a.js": "1\n" }, { "Flowrunner-Subtask": "ST-1" });
    const a2 = await commit(repo, { "compartido.txt": "tres\n" }, { "Flowrunner-Subtask": "ST-1" });
    const b1 = await commit(repo, { "src/ST-2/b.js": "2\n" }, { "Flowrunner-Subtask": "ST-2" });
    const c1 = await commit(repo, { "src/ST-3/c.js": "3\n" }, { "Flowrunner-Subtask": "ST-3" });
    const { emit, avisos } = collect();
    const out = await reaplicar(
      repo,
      base,
      {
        subtasks: [
          { id: "ST-1", shas: [a1, a2] },
          { id: "ST-2", shas: [b1] },
          { id: "ST-3", shas: [c1] },
        ],
        manuales: [],
      },
      [st("ST-1"), st("ST-2", ["ST-1"]), st("ST-3")],
      ENV,
      emit,
    );
    expect(out.candidatas.map((c) => c.id)).toEqual(["ST-3"]);
    expect(Object.keys(out.nuevos)).toEqual(["ST-3"]);
    expect(git(repo, "log", "--format=%s", `${base}..HEAD`)).toBe("src/ST-3/c.js");
    // Ni el primer commit de ST-1, que sí entraba, ni ST-2, que entraba pero dependía de ST-1.
    expect(existsSync(join(repo, "src/ST-1/a.js"))).toBe(false);
    expect(existsSync(join(repo, "src/ST-2/b.js"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(avisos).toEqual([
      "ST-1 no se pudo reaplicar sobre la base: se va a reimplementar",
      "ST-2 depende de una sub-task que no se pudo reaplicar: se va a reimplementar",
    ]);
  });

  // Si regresiona, la rama queda con la mitad de una sub-task que se va a reimplementar entera.
  test("los commits de una sub-task que choca se sacan aunque nada dependa de ella", async () => {
    const repo = repoWith({ "README.md": "# r\n", "compartido.txt": "uno\n" });
    const base = git(repo, "rev-parse", "HEAD");
    await commit(repo, { "compartido.txt": "dos\n" }, { "Flowrunner-Run": "R" });
    const a1 = await commit(repo, { "src/ST-1/a.js": "1\n" }, { "Flowrunner-Subtask": "ST-1" });
    const a2 = await commit(repo, { "compartido.txt": "tres\n" }, { "Flowrunner-Subtask": "ST-1" });
    const c1 = await commit(repo, { "src/ST-3/c.js": "3\n" }, { "Flowrunner-Subtask": "ST-3" });
    const { emit } = collect();
    const rama = {
      subtasks: [
        { id: "ST-1", shas: [a1, a2] },
        { id: "ST-3", shas: [c1] },
      ],
      manuales: [],
    };
    const out = await reaplicar(repo, base, rama, [st("ST-1"), st("ST-3")], ENV, emit);
    expect(out.candidatas.map((c) => c.id)).toEqual(["ST-3"]);
    expect(git(repo, "log", "--format=%s", `${base}..HEAD`)).toBe("src/ST-3/c.js");
    expect(existsSync(join(repo, "src/ST-1/a.js"))).toBe(false);
  });

  // Si regresiona, un arreglo a mano que ya no entra se pierde sin que nadie lo sepa.
  test("un arreglo a mano que choca se descarta con un aviso que dice cómo recuperarlo", async () => {
    const repo = repoWith({ "README.md": "# r\n" });
    const base = git(repo, "rev-parse", "HEAD");
    await commit(repo, { "src/ST-1/a.js": "1\n" }, { "Flowrunner-Subtask": "ST-1" });
    const m = await commit(repo, { "src/ST-1/a.js": "1 a mano\n" }, { "Flowrunner-Manual": "R" });
    const { emit, avisos } = collect();
    // ST-1 no se conserva: el arreglo a mano de su archivo ya no tiene dónde aplicarse.
    const out = await reaplicar(repo, base, { subtasks: [], manuales: [m] }, [], ENV, emit);
    expect(out.candidatas).toEqual([]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(avisos).toEqual([
      `el arreglo a mano ${m.slice(0, 7)} no se pudo reaplicar sobre la base y se descartó: con \`git cherry-pick ${m}\` en el worktree se recupera`,
    ]);
  });
});
