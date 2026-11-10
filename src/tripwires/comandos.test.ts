import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import {
  checkCommand,
  describeComandos,
  parseCommand,
  SIN_COMANDOS,
  type Comandos,
} from "./comandos.ts";
import type { Scope } from "./rules.ts";

interface Caso {
  readonly id: number;
  readonly comando: string;
  readonly alcance: readonly string[];
  readonly criterios: readonly string[];
  readonly fixers: readonly string[];
  readonly typecheck: string | null;
  readonly env_files: readonly string[];
  readonly esperado: "permitido" | "rechazado";
  readonly porque?: string;
}

const CASOS = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "comandos-rechazados.json"), "utf8"),
) as Caso[];

function base(extra: Partial<Scope> = {}): Scope {
  return {
    root: realpathSync(tempDir("fr-cmd-")),
    owner: "ST-1",
    writable: [],
    writeGlobs: [],
    locked: [],
    harness: [],
    lockfiles: [],
    manifests: [],
    depsDeclared: false,
    testGlobs: ["tests/**"],
    comandos: SIN_COMANDOS,
    ...extra,
  };
}

function scopeDe(caso: Caso): Scope {
  return base({
    writable: caso.alcance,
    unreadable: caso.env_files,
    comandos: {
      ampliables: [...caso.criterios, ...(caso.typecheck ? [caso.typecheck] : [])],
      exactos: [],
      fixers: caso.fixers,
    },
  });
}

const comandos = (extra: Partial<Comandos>): Comandos => ({ ...SIN_COMANDOS, ...extra });
const motivo = (v: { ok: boolean; motivo?: string }) => (v.ok ? "ok" : (v.motivo ?? ""));

const pasa = (scope: Scope, ...lista: string[]) => {
  for (const c of lista) expect(motivo(checkCommand(scope, c)), c).toBe("ok");
};
const noPasa = (scope: Scope, ...lista: string[]) => {
  for (const c of lista) expect(checkCommand(scope, c).ok, c).toBe(false);
};

describe("checkCommand", () => {
  // Si regresiona, vuelven los turnos perdidos de VF-6 (61 rechazos, unos 100 de solo lectura en 9 runs)
  // o pasa un script, el verify o una escritura fuera del alcance.
  test("los 135 comandos que rechazó el bloqueo en runs reales: pasan los que se pueden revisar y siguen afuera los scripts, el verify y lo que escribe fuera del alcance", () => {
    expect(CASOS).toHaveLength(135);
    for (const caso of CASOS) {
      const verdict = checkCommand(scopeDe(caso), caso.comando);
      expect(verdict.ok, `#${caso.id} ${caso.comando} → ${motivo(verdict)}`).toBe(
        caso.esperado === "permitido",
      );
    }
    expect(CASOS.filter((c) => c.esperado === "permitido")).toHaveLength(117);
  });

  test("parte el comando en tramos por ;, &&, || y |, respetando las comillas", () => {
    const parsed = parseCommand('grep -n "a|b; c" src/x.ts | head -5 && git status');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tramos).toHaveLength(3);
    expect(parsed.tramos.map((t) => t.desdePipe)).toEqual([false, true, false]);
    expect(parsed.tramos[0]?.palabras.map((p) => p.texto)).toEqual([
      "grep",
      "-n",
      "a|b; c",
      "src/x.ts",
    ]);
    expect(parsed.tramos[0]?.palabras[2]).toMatchObject({ citada: true, comodin: false });
    const otro = parseCommand("ls a || ls b; ls c\nls d");
    expect(otro.ok && otro.tramos.length).toBe(4);
  });

  test("rechaza sustituciones, heredocs, segundo plano, subshells, llaves y ~", () => {
    const s = base();
    const sustitucion = "`$( )`, backticks y `<( )` no se usan: corré cada comando por separado";
    expect(motivo(checkCommand(s, "echo `x`"))).toBe(sustitucion);
    expect(motivo(checkCommand(s, "cat $(ls)"))).toBe(sustitucion);
    expect(motivo(checkCommand(s, "diff <(a) b"))).toBe(sustitucion);
    expect(motivo(checkCommand(s, "python3 - <<'EOF'"))).toBe(
      "no se usan heredocs (`<<`): para escribir un archivo usá Write o Edit",
    );
    expect(motivo(checkCommand(s, "npx vitest &"))).toBe("no se corre nada en segundo plano (`&`)");
    const llaves = "no se usan `( )` ni `{ }` del shell: encadená con `;` o `&&`";
    expect(motivo(checkCommand(s, "(ls)"))).toBe(llaves);
    expect(motivo(checkCommand(s, "ls {a,b}"))).toBe(llaves);
    expect(motivo(checkCommand(s, "cat ~/.ssh/id_rsa"))).toBe(
      "`~` apunta fuera del worktree: usá rutas relativas a la raíz del worktree",
    );
  });

  test("las asignaciones al principio pasan, salvo las de credenciales", () => {
    const s = base({ comandos: comandos({ ampliables: ["npx vitest run tests/a.test.ts"] }) });
    pasa(s, "CI=1 npx vitest run tests/a.test.ts");
    expect(motivo(checkCommand(s, "ANTHROPIC_API_KEY=x npx vitest run tests/a.test.ts"))).toBe(
      "`ANTHROPIC_API_KEY` es una credencial: no se pasa a los comandos",
    );
  });

  test("lectura: git que mira con cualquier opción, ls, cat, grep, sed -n y awk; git que escribe, no", () => {
    const s = base();
    pasa(
      s,
      "git status --short",
      "git log --oneline -5",
      "git diff --stat",
      "sed -n 1,30p src/x.ts",
      "awk 'length > 150 {print FILENAME}' src/x.ts",
    );
    noPasa(
      s,
      "git commit -m x",
      "git checkout .",
      "git -C /tmp status",
      "git diff --no-index /etc/passwd x",
      "git branch -D x",
    );
    expect(motivo(checkCommand(s, "git commit -m x"))).toBe(
      "`git commit` no está permitido: flowrunner commitea por vos. Para mirar: git status, log, diff, show, grep o blame",
    );
  });

  test("un criterio pasa con argumentos y filtros detrás; instalar, solo idéntico", () => {
    const s = base({
      comandos: comandos({
        ampliables: ["npx vitest run tests/a.test.ts"],
        exactos: ["npm install zod"],
      }),
    });
    pasa(s, 'npx vitest run tests/a.test.ts -t "x" 2>&1 | tail -20', "npm install zod");
    noPasa(s, "npm install zod lodash");
  });

  test("el formateador y el lint, por su programa y sobre archivos del alcance", () => {
    const s = base({
      writable: ["src/a/"],
      comandos: comandos({ fixers: ["npx prettier --write --ignore-unknown"] }),
    });
    pasa(
      s,
      "npx prettier --write src/a/x.ts",
      "npx prettier --check src/a/x.ts",
      "npx prettier --write 'src/a/[id]/page.tsx'",
    );
    expect(motivo(checkCommand(s, "npx prettier --write src/b/y.ts"))).toBe(
      "el comando escribe en src/b/y.ts: src/b/y.ts está fuera del alcance de ST-1",
    );
    expect(motivo(checkCommand(s, "npx prettier --write src/a/*"))).toBe(
      "en un comando que escribe, nombrá cada ruta sin comodines y citala con comillas simples si tiene corchetes o paréntesis",
    );
    expect(motivo(checkCommand(s, "npx prettier --write --plugin ./p.js src/a/x.ts"))).toBe(
      "`--plugin` no se usa con `npx prettier`: la configuración la pone el repo",
    );
    expect(motivo(checkCommand(s, "npx prettier --write CLAUDE.md"))).toBe(
      "el comando escribe en CLAUDE.md: CLAUDE.md es parte de CLAUDE.md: ningún agente lo escribe",
    );
    expect(motivo(checkCommand(s, "npx prettier --write"))).toBe(
      "nombrá los archivos de tu alcance que querés pasar por `npx prettier`",
    );
  });

  test("redirigir a un archivo, solo dentro del alcance; 2>&1 y /dev/null, siempre", () => {
    const s = base({
      writable: ["src/a/"],
      comandos: comandos({ ampliables: ["npx vitest run tests/a.test.ts"] }),
    });
    pasa(s, "ls src 2>/dev/null", "npx vitest run tests/a.test.ts 2>&1", "echo x > src/a/nota.txt");
    expect(motivo(checkCommand(s, "echo x > /tmp/y"))).toBe(
      "el comando escribe en /tmp/y: /tmp/y queda fuera del worktree de ST-1",
    );
    noPasa(s, "cat src/a/x.ts >> src/b/y.ts");
  });

  test("los env_files no se leen ni se abarcan, tampoco con comodines ni con búsquedas recursivas", () => {
    const s = base({ unreadable: [".env.local"] });
    noPasa(s, "cat .env.local", "cat .env*", "grep -rn TOKEN .", "rg TOKEN", "find . -name x");
    expect(motivo(checkCommand(s, "cat .env.local"))).toBe(
      ".env.local tiene secretos del entorno: no se lee",
    );
    pasa(s, "grep -rn TOKEN src", "cat .env.example");
  });

  test("rutas absolutas y .. fuera del worktree se rechazan con el motivo de checkReadPath", () => {
    const s = base();
    expect(motivo(checkCommand(s, "cat /etc/hosts"))).toBe("/etc/hosts queda fuera del worktree");
    expect(motivo(checkCommand(s, "ls ../otro"))).toBe("../otro queda fuera del worktree");
  });

  test("cd y el verify del repo se rechazan con lo que hay que hacer en su lugar", () => {
    const s = base();
    expect(motivo(checkCommand(s, "cd src && ls"))).toBe(
      "los comandos corren en la raíz del worktree y `cd` no se usa: nombrá las rutas desde la raíz, como `ls app/src`",
    );
    expect(motivo(checkCommand(s, "./.flowrunner/verify.sh 2>&1 | tail -5"))).toBe(
      "el verify del repo lo corre verificar, sobre la rama con todas las sub-tasks integradas: corré los comandos de tus criterios",
    );
  });

  test("sed -i, sed sin -n, awk que escribe y find que ejecuta se rechazan", () => {
    const s = base();
    expect(motivo(checkCommand(s, "sed -i '' s/a/b/ x"))).toBe(
      "`sed -i` y los scripts de sed que escriben no se usan: para cambiar un archivo usá Edit; para mirar, `sed -n 10,40p archivo`",
    );
    expect(motivo(checkCommand(s, "sed s/a/b/ x"))).toBe(
      "sed solo se usa para mirar, con `-n`: `sed -n 10,40p archivo`",
    );
    noPasa(s, `awk '{print > "f"}' x`, `awk '{system("rm x")}' x`);
    expect([
      "no se usan `( )` ni `{ }` del shell: encadená con `;` o `&&`",
      "`find` cambia archivos por fuera de las herramientas: para crear o cambiar usá Write o Edit",
    ]).toContain(motivo(checkCommand(s, "find src -exec rm {} \\;")));
  });

  test("describeComandos nombra los comandos de la sub-task y omite lo que no tiene", () => {
    const vacio = describeComandos(SIN_COMANDOS);
    expect(vacio).not.toContain("Podés correr");
    expect(vacio).not.toContain("Podés pasar");
    expect(vacio).not.toContain("Para instalar");
    expect(
      describeComandos({
        ampliables: ["npx vitest run tests/a.test.ts", "pnpm run typecheck"],
        exactos: ["npm install zod"],
        fixers: ["npx eslint --fix", "npx prettier --write --ignore-unknown"],
      }),
    ).toBe(
      "Podés mirar con git status, log, diff, show, grep y blame, y con ls, cat, head, tail, grep, rg, find, `sed -n`, awk y wc, encadenados con `;`, `&&` o `|`. " +
        'Podés correr `npx vitest run tests/a.test.ts`, `pnpm run typecheck` con lo que quieras agregar detrás, como `-t "nombre"` o `2>&1 | tail -30`. ' +
        "Podés pasar `npx eslint`, `npx prettier` por archivos de tu alcance y crear carpetas de tu alcance con `mkdir -p`. " +
        "No se usan `cd`, variables, `$( )`, heredocs ni scripts (`python3`, `node -e`, `sh -c`): para cambiar archivos usá Write o Edit. " +
        "Para instalar lo declarado: `npm install zod`.",
    );
  });
});

// Caminos que la spec no nombraba y que el shell sí toma: cada caso pasaba con la regla literal de la
// spec, y lo que hace el shell está comprobado en macOS (`sh` es bash en modo POSIX, sed y grep de BSD).
describe("checkCommand, lo que el shell hace distinto de lo que parece", () => {
  const s = () =>
    base({
      writable: ["src/a/"],
      unreadable: [".env.local", "config/.env"],
      comandos: comandos({
        ampliables: ["npx vitest run tests/a.test.ts"],
        exactos: ["npm install zod"],
      }),
    });

  // Si regresiona, `cat -n .env.local` imprime los secretos: la opción se llevaba la ruta como su valor.
  test("una opción de lectura no se lleva la ruta que sigue, ni el valor de --opción=archivo", () => {
    noPasa(
      s(),
      "cat -n .env.local",
      "file -f .env.local",
      "diff -c .env.local src/a/x.ts",
      "diff --from-file=.env.local src/a/x.ts",
      "wc --files0-from=.env.local",
      "cat -- .env.local",
    );
    pasa(s(), "head -n 20 src/a/x.ts", "tail -n +285 src/a/x.ts", "cut -d: -f1 src/a/x.ts");
  });

  // Si regresiona, `cat ./.env*` o `cat .*/.env.local` leen el secreto, y `ls .*` lista la carpeta de arriba.
  test("un comodín no abarca un env_file ni sale del worktree por ./, .* o una carpeta", () => {
    noPasa(s(), "cat ./.env*", "cat .*/.env.local", "cat src/../.env*", "grep -r TOKEN c*");
    noPasa(base(), "ls .*", "cat .?/x");
    pasa(s(), "cat .prettierrc* 2>/dev/null", "ls src/a/*.ts");
  });

  // Si regresiona, un grep recursivo sin ruta lee el .env de la raíz: grep de BSD busca en `.` aunque
  // le llegue un pipe, y `-A 3` hacía pasar a 3 por el patrón y al patrón por una ruta.
  test("grep recursivo sin ruta busca en la raíz aunque una opción tome valor o venga de un pipe", () => {
    noPasa(
      s(),
      "grep -r -A 3 TOKEN",
      "grep -rn -m 1 TOKEN",
      "ls | grep -r TOKEN",
      "grep -f .env.local src/a/x.ts",
      "diff -r config src",
    );
    pasa(s(), "ls | rg TOKEN", "grep -rn -A 3 TOKEN src", "git status | grep -c M");
  });

  // Si regresiona, `sed -n '$w .git/config'` escribe la config de git (y con ella, un comando que corre
  // git), y `sed -n '1r .env.local'` lee el secreto: la regla miraba solo `w` al principio.
  test("sed no escribe, no lee ni ejecuta por un comando con dirección, un flag de s/// ni una opción en grupo", () => {
    const sedEscribe =
      "`sed -i` y los scripts de sed que escriben no se usan: para cambiar un archivo usá Edit; para mirar, `sed -n 10,40p archivo`";
    for (const c of [
      "sed -n '1w /tmp/x' src/a/x.ts",
      "sed -n '$w .git/config' src/a/x.ts",
      "sed -n '1,$W out' src/a/x.ts",
      "sed -n '1r .env.local' src/a/x.ts",
      "sed -n '/x/R .env.local' src/a/x.ts",
      "sed -n '1e id' src/a/x.ts",
      "sed -n 's/x/id/e' src/a/x.ts",
      "sed -n 's/x/y/gw out' src/a/x.ts",
      "sed -ni s/a/b/ src/a/x.ts",
      "sed -nI '' s/a/b/ src/a/x.ts",
      "sed -n --file=x src/a/x.ts",
      "sed -n -e p -e '1w out' src/a/x.ts",
    ])
      expect(motivo(checkCommand(s(), c)), c).toBe(sedEscribe);
    pasa(
      s(),
      "sed -n '/error/p' src/a/x.ts",
      "sed -n '$p' src/a/x.ts",
      "sed -nE 's/(a|b)+/x/gp' src/a/x.ts",
      "sed -n -e '1,5p' -e '/^export/=' src/a/x.ts",
      "sed -n '/^import/,/^$/{p;}' src/a/x.ts",
      "sed -n 's|a/b|c|p' src/a/x.ts",
    );
  });

  // Si regresiona, awk corre un comando (`system (…)`, `@load`, `-l`) o lee el .env por ARGV.
  test("awk no ejecuta ni lee otros archivos: system con espacio, @load, ARGV y opciones de gawk", () => {
    noPasa(
      s(),
      `awk '{system ("id")}' src/a/x.ts`,
      `awk '@load "x"' src/a/x.ts`,
      `awk 'BEGIN{ARGV[1]=".env.local"}{print}' src/a/x.ts`,
      "awk -l x '{}' src/a/x.ts",
      "awk -E prog.awk src/a/x.ts",
      "awk -i inc '{}' src/a/x.ts",
    );
    pasa(s(), "awk -F: -v n=2 '{print $1}' src/a/x.ts", "awk '{print FILENAME}' src/a/x.ts");
  });

  // Si regresiona, una opción de un programa de lectura escribe (`sort -no`, `tree -o`, `file -C`),
  // ejecuta (`--compress-program`), lee el .env como programa (`jq -f`) o no termina (`tail -fn`).
  test("sort, tree, file, jq y tail no escriben, no ejecutan ni se cuelgan por una opción", () => {
    noPasa(
      s(),
      "sort -no src/a/y.ts src/a/x.ts",
      "sort --compress-program=id src/a/x.ts",
      "sort -T src/a src/a/x.ts",
      "tree -o .git/x",
      "file -C -m src/a/m",
      "jq -f .env.local",
      "jq -rf .env.local",
      "tail -fn 5 src/a/x.ts",
    );
    pasa(s(), "sort -t: -k2 -n src/a/x.ts", "jq -r .name package.json", "tree -L 2 src");
  });

  // Si regresiona, git que mira lee el .env sin versionar o abre un editor que no termina.
  test("git que mira no lee archivos sin versionar ni abre un editor", () => {
    noPasa(
      s(),
      "git blame --contents .env.local src/a/x.ts",
      "git blame --contents=.env.local src/a/x.ts",
      "git grep --untracked TOKEN",
      "git grep --no-exclude-standard TOKEN",
      "git branch --edit-description",
    );
    pasa(s(), "git blame -L 1,20 src/a/x.ts", "git status --untracked-files=all");
  });

  // Si regresiona, una variable de entorno hace que git o ls corran otro programa: GIT_EXTERNAL_DIFF,
  // GIT_CONFIG_* con core.fsmonitor, o un PATH que empieza en el alcance.
  test("las asignaciones solo van delante de un criterio o de instalar: no cambian cómo corre git o ls", () => {
    for (const c of [
      "GIT_EXTERNAL_DIFF=rm git diff",
      "PATH=src/a git status",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=id git status",
      "LC_ALL=C ls src",
    ])
      expect(motivo(checkCommand(s(), c)), c).toBe(
        "las variables de entorno (`NOMBRE=valor`) solo van delante de los comandos de tus criterios o de instalar",
      );
    noPasa(s(), "PATH=src/a; git status", "PATH=src/a");
    pasa(s(), "CI=1 npx vitest run tests/a.test.ts -t x", "CI=1 npm install zod");
  });

  // Si regresiona, `cat $'.env.local'` lee el secreto: el shell junta `$'…'` en `.env.local` y la
  // política comprobaba `$.env.local`.
  test("$'…' y $\"…\" se rechazan: el shell los lee distinto de lo que se comprueba", () => {
    const sintaxis = "no pude leer el comando: revisá las comillas y los operadores";
    expect(motivo(checkCommand(s(), "cat $'.env.local'"))).toBe(sintaxis);
    expect(motivo(checkCommand(s(), 'cat $".env.local"'))).toBe(sintaxis);
    pasa(s(), "grep -n 'x$' src/a/x.ts", 'grep -nE "^(a|b)$" src/a/x.ts', "grep -n x$ src/a/x.ts");
  });
});
