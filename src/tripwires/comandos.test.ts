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
