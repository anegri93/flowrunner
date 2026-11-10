# PR 03 · De la lista exacta de comandos a una política por tramos

Rama: `feat/politica-de-comandos` · Depende de: PR 01 y #72 mergeada · Tamaño: grande

## Objetivo

En 9 runs, el bloqueo rechazó **135 comandos de Bash** (61 en VF-6). Esto es lo que se rechazaba:

- **Unos 100 eran de solo lectura:** `git status --short` cuando la lista tenía `git status`,
  `git log --oneline -5` cuando tenía `-10`, `ls`, `cat`, `grep`, `sed -n`, encadenados con `;`.
- **20 eran de formato**, como `npx prettier --write`.
- **Unos pocos eran un criterio con `| tail`** detrás.
- **El resto eran scripts ad hoc** o escrituras.

Cada rechazo es un turno perdido, y varios terminaron en sub-tasks «sin cambios». La lista exacta
(`checkBash`, `src/tripwires/rules.ts:151`) se reemplaza por una política que evalúa cada tramo del
comando.

**Métrica:** de los 135 comandos reales (`pr-03-comandos-rechazados.json`), **117 pasan y 18 siguen
rechazados**. En runs nuevos, menos de 2 rechazos de Bash por run.

## Decisiones tomadas (no reabrir)

1. **Un comando se parte en tramos** con `;`, `&&`, `||`, `|` y salto de línea. Se permite solo si
   **cada** tramo se permite. No hay orden de preferencia entre tramos: el primero que falla da el
   motivo.
2. **Comillas:** las simples son literales. Dentro de las dobles, `\"`, `\\`, `\$` y `` \` `` se
   escapan. Fuera de comillas, `\x` es `x`.
3. **Siempre se rechaza**, aunque esté dentro de comillas dobles: `$( )`, backticks, `<( )`, `>( )`,
   `<<` y `<<<` (heredocs), un `&` suelto (segundo plano), `(` y `)` sin comillas, `{` y `}` sin
   comillas, y una palabra que empieza con `~` sin comillas.
4. **Variables:** un `$` seguido de letra, `_`, `{`, dígito o `@*#?!$-`, fuera de comillas simples, se
   rechaza. Un `$` suelto o al final, como el ancla de `grep 'x$'`, es literal. **Motivo:** una ruta
   con una variable no se puede comprobar contra el alcance.
5. **Asignaciones al principio del tramo** (`CI=1 npx vitest …`) se permiten y se sacan antes de
   evaluar. Una asignación a una credencial (`SECRET_ENV_VARS` de `src/agent/env.ts`) se rechaza.
6. **`cd` se rechaza.** Los comandos corren en la raíz del worktree (`scrubCommand` los envuelve en
   `sh -c`). Con `cd`, las rutas de los tramos siguientes cambiarían de base, y habría que seguirles
   el directorio para comprobarlas. En los 135 comandos no hubo ningún `cd`.
7. **Redirecciones:**
   - `N>&M`, `>&N` y cualquier redirección a `/dev/null` (`2>/dev/null`, `>/dev/null`,
     `&>/dev/null`) se permiten siempre.
   - `>`, `>>`, `N>` y `&>` a un archivo: el destino pasa por `checkWritePath`, o sea que tiene que
     estar en el alcance y no ser protegido.
   - `<` desde un archivo: pasa por `checkReadPath`.
8. **Qué se permite, en orden de evaluación del tramo:**

   | # | Tramo | Condición |
   |---|---|---|
   | 1 | **exacto**: idéntico a un comando de `comandos.exactos` (comparando por tokens) | ninguna. Es instalar las dependencias declaradas |
   | 2 | **ampliable**: empieza con los tokens de un comando de `comandos.ampliables` | cualquier argumento de más. Son los criterios y el typecheck |
   | 3 | **fixer**: empieza con el *programa* de un comando de `comandos.fixers` (los tokens hasta el primero que empieza con `-`, por ejemplo `npx prettier` de `npx prettier --write --ignore-unknown`) | al menos un archivo; cada argumento que no empieza con `-` pasa por `checkWritePath`; un archivo con comodines sin comillas se rechaza; las opciones `-o*`, `--output*`, `--out-file*`, `--plugin*`, `--config*` y `-c` se rechazan |
   | 4 | **lectura**: ver la tabla de programas de lectura, abajo | sus reglas de argumentos |
   | 5 | **`mkdir`** | solo las opciones `-p` y `-v`; cada carpeta pasa por `checkWritePath` y sin comodines |
   | 6 | **`tee`** | cada archivo pasa por `checkWritePath` |
   | — | todo lo demás | se rechaza con el motivo de su categoría |

9. **Programas de lectura y sus argumentos.** «Ruta» quiere decir que pasa por `checkReadPath`, o
   por `checkSearchPath` si la búsqueda es recursiva. Un argumento con comodines sin comillas se
   rechaza si `matchesGlob(env_file, argumento)` es verdadero para algún `env_file`.

   | Programa | Regla |
   |---|---|
   | `git` | sin opciones globales, salvo `--no-pager` y `-P`. Subcomandos: `status`, `log`, `diff`, `show`, `grep`, `blame`, `ls-files`, `rev-parse`, `shortlog`, `describe`, `cat-file`; `branch` solo con opciones y sin las que escriben (`-d -D -m -M -c -C -f -u --delete --move --copy --force --set-upstream-to --unset-upstream`); `remote` solo con opciones. Se rechazan los argumentos que empiezan con `--output`, `--ext-diff`, `--no-index`, `-O`, `--open-files-in-pager` o `--exec`. Los argumentos no se comprueban como rutas: git lee lo versionado |
   | `ls`, `cat`, `head`, `tail`, `wc`, `nl`, `file`, `stat`, `du`, `tree`, `realpath`, `diff`, `cmp`, `cut`, `column` | cada argumento que no es opción es una ruta, salvo un número (`20`, `+285`). Las opciones `-n -c -L -I -d -f --lines --bytes` toman el argumento siguiente. Se rechazan `tail -f`, `-F` y `--follow` |
   | `echo`, `printf`, `true`, `false`, `pwd`, `basename`, `dirname`, `tr`, `which` | sin comprobar argumentos |
   | `grep`, `egrep`, `fgrep`, `rg` | el primer argumento que no es opción es el patrón, salvo que haya `-e`, `-f`, `--regexp` o `--file`; el resto son rutas. `rg`, o `grep` con `-r`, `-R` o `--recursive`, busca en forma recursiva: sus rutas van por `checkSearchPath` y, sin rutas, se toma `.`, salvo que el tramo reciba de un `|`. Se rechaza `--pre*` |
   | `find` | las rutas son los argumentos antes del primero que empieza con `-`, `(` o `!` (si no hay, `.`), por `checkSearchPath`. Se rechazan `-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls` |
   | `sed` | requiere `-n`, `--quiet` o `--silent`. Se rechazan `-i*`, `--in-place*` y `-f`. Un script que escribe o lee archivos, `/(^\|[;{}\s])[wWeRr](\s\|$)\|\/[wW]\s+\S/`, se rechaza. El script es el primer argumento que no es opción, salvo con `-e`; el resto son rutas |
   | `awk` | se rechaza `-f`. El programa es el primer argumento que no es opción (`-v` y `-F` toman el siguiente). Se rechaza si contiene `system(`, `getline`, `\|` o `/\bprintf?\b[^;{}]*>/`. El resto son rutas |
   | `sort` | se rechazan `-o` y `--output*`; los argumentos que no son opción son rutas |
   | `uniq` | como mucho un argumento que no es opción (el segundo sería un archivo de salida) |
   | `jq` | el primer argumento que no es opción es el filtro; el resto son rutas |

10. **Las categorías de rechazo**, con motivos exactos (`<p>` es el programa del tramo):

    | Categoría | Motivo |
    |---|---|
    | sustitución | ``"`$( )`, backticks y `<( )` no se usan: corré cada comando por separado"`` |
    | variable | ``"no se usan variables de shell (`$X`): escribí el valor o la ruta tal cual"`` |
    | heredoc | ``"no se usan heredocs (`<<`): para escribir un archivo usá Write o Edit"`` |
    | subshell o llaves | ``"no se usan `( )` ni `{ }` del shell: encadená con `;` o `&&`"`` |
    | segundo plano | ``"no se corre nada en segundo plano (`&`)"`` |
    | tilde | ``"`~` apunta fuera del worktree: usá rutas relativas a la raíz del worktree"`` |
    | sintaxis | `"no pude leer el comando: revisá las comillas y los operadores"` |
    | credencial | ``"`<NOMBRE>` es una credencial: no se pasa a los comandos"`` |
    | `cd` | ``"los comandos corren en la raíz del worktree y `cd` no se usa: nombrá las rutas desde la raíz, como `ls app/src`"`` |
    | verify | `"el verify del repo lo corre verificar, sobre la rama con todas las sub-tasks integradas: corré los comandos de tus criterios"`. Aplica si el programa empieza con `.flowrunner/` o `./.flowrunner/` |
    | git que escribe | ``"`git <sub>` no está permitido: flowrunner commitea por vos. Para mirar: git status, log, diff, show, grep o blame"`` |
    | script | ``"`<p>` corre un script ad hoc, que no se puede revisar por partes: para mirar usá Read o Grep, y para cambiar, Write o Edit"``. Programas: `python python3 node sh bash zsh eval exec source . perl ruby deno bun env xargs time timeout nohup`, o uno que termina en `.py`, `.sh`, `.js` o `.mjs` |
    | red | ``"`<p>` usa la red, y una sub-task no sale a la red"``. Programas: `curl wget ssh scp nc rsync http ftp` |
    | archivos | ``"`<p>` cambia archivos por fuera de las herramientas: para crear o cambiar usá Write o Edit"``. Programas: `rm rmdir mv cp ln chmod chown touch dd truncate install` |
    | `sed` que escribe | ``"`sed -i` y los scripts de sed que escriben no se usan: para cambiar un archivo usá Edit; para mirar, `sed -n 10,40p archivo`"`` |
    | `sed` sin `-n` | ``"sed solo se usa para mirar, con `-n`: `sed -n 10,40p archivo`"`` |
    | comodín al escribir | `"en un comando que escribe, nombrá cada ruta sin comodines y citala con comillas simples si tiene corchetes o paréntesis"` |
    | fixer sin archivos | ``"nombrá los archivos de tu alcance que querés pasar por `<fixer>`"`` |
    | opción de fixer | ``"`<opción>` no se usa con `<fixer>`: la configuración la pone el repo"`` |
    | escritura fuera | `"el comando escribe en <ruta>: " + checkWritePath(...).motivo` |
    | ruta, secreto o búsqueda | el motivo tal cual de `checkReadPath` o `checkSearchPath` |
    | no permitido | ``"`<p>` no está entre los comandos permitidos. " + describeComandos(scope.comandos)`` |

11. **`Scope.bash` se reemplaza por `Scope.comandos: Comandos`.** No queda ningún campo `bash`.
12. **El prompt de cada sesión con Bash** deja de listar comandos «tal cual» y describe la política
    con `describeComandos`.

## Cambios, archivo por archivo

### `src/tripwires/comandos.ts` (nuevo)

```ts
// La política de comandos de Bash: cada tramo de un comando se evalúa por separado contra lo que la
// sesión puede leer, correr y escribir (PR 03, VF-6: 135 rechazos, 100 de solo lectura).
import { matchesGlob } from "node:path";
import { SECRET_ENV_VARS } from "../agent/env.ts";
import { checkReadPath, checkSearchPath, checkWritePath, type Scope, type Verdict } from "./rules.ts";

export interface Comandos {
  /** Pasan con argumentos de más detrás: los comandos de los criterios y el typecheck. */
  readonly ampliables: readonly string[];
  /** Pasan solo idénticos: instalar las dependencias declaradas. */
  readonly exactos: readonly string[];
  /** lint_fix y format del repo: su programa, sobre archivos del alcance. */
  readonly fixers: readonly string[];
}

export const SIN_COMANDOS: Comandos = { ampliables: [], exactos: [], fixers: [] };

export interface Palabra { readonly texto: string; readonly citada: boolean; readonly comodin: boolean }
export interface Redireccion { readonly fd: string; readonly op: ">" | ">>" | "<"; readonly destino: string }
export interface Tramo {
  readonly palabras: readonly Palabra[];
  readonly redirecciones: readonly Redireccion[];
  /** Recibe la salida de otro por `|`. */
  readonly desdePipe: boolean;
}

/** Parte el comando en tramos, o dice por qué no se puede (motivo de la tabla de la spec). */
export function parseCommand(command: string): { ok: true; tramos: Tramo[] } | { ok: false; motivo: string };

export function checkCommand(scope: Scope, command: string): Verdict;

/** La política en una frase para el prompt: qué se lee, qué se corre y sobre qué se pasa el formato. */
export function describeComandos(c: Comandos): string;
```

- **`parseCommand`** implementa las decisiones 2 a 4, y 7 para separar las redirecciones. Una
  palabra-redirección es un token sin comillas que matchea `/^(\d*|&)(>>|>|<)(.*)$/`. Si el destino
  viene vacío, se toma el token siguiente.
- **`checkCommand`** aplica la 5 y la 8 tramo por tramo, y devuelve el primer rechazo.
- **`describeComandos`** devuelve exactamente:
  > Podés mirar con git status, log, diff, show, grep y blame, y con ls, cat, head, tail, grep, rg,
  > find, `sed -n`, awk y wc, encadenados con `;`, `&&` o `|`. Podés correr <ampliables entre
  > backticks, separados por coma> con lo que quieras agregar detrás, como `-t "nombre"` o
  > `2>&1 | tail -30`. Podés pasar <programas de fixers> por archivos de tu alcance y crear carpetas
  > de tu alcance con `mkdir -p`. No se usan `cd`, variables, `$( )`, heredocs ni scripts
  > (`python3`, `node -e`, `sh -c`): para cambiar archivos usá Write o Edit.

  Si una lista está vacía, su oración no va. Si hay `exactos`, se suma: «Para instalar lo declarado:
  <exactos>.»

### `src/tripwires/rules.ts`

- **`Scope` (línea 34):** `readonly bash: readonly string[]` pasa a `readonly comandos: Comandos`,
  importado como tipo de `./comandos.ts`. Va con el comentario «Lo que una sesión con Bash puede
  correr; ver `checkCommand`».
- **Se borran `COMPOSITION` (línea 149) y `checkBash` (líneas 151 a 164).** No queda nada que los
  use.

### `src/tripwires/hook.ts`

- Se importa `checkCommand` de `./comandos.ts` en lugar de `checkBash`.
- **En el `case "Bash"` (líneas 72 a 80):** `checkCommand(policy.scope, command)` en lugar de
  `checkBash`. Lo demás no cambia, `scrubCommand` incluido.

### `src/phases/implementar.ts`

Las líneas son las de la versión de #72.

- **`unitCommands` (línea 93) pasa a ser `unitComandos`:**

  ```ts
  export function unitComandos(
    config: RepoConfig,
    task: Subtask,
    acCommands: readonly string[],
    exact: boolean,
  ): Comandos {
    return {
      ampliables: [
        ...new Set([
          ...acCommands.filter((c) => !isVerifyCommand(config, c)),
          ...(config.typecheck === undefined ? [] : [config.typecheck]),
        ]),
      ],
      exactos: installCommands(config, task, exact),
      fixers: [config.lint_fix, config.format].filter((c): c is string => c !== undefined),
    };
  }
  ```

  El comentario sobre el verify y sobre las rutas citadas se queda. Ya no hay `git status`,
  `git diff` ni `git log` en la lista: son lectura.
- **`unitScope` (línea 120):** el parámetro `bash: string[]` pasa a `comandos: Comandos`, y el campo
  `bash` (línea 138) pasa a `comandos`.
- **En `runUnit` (línea 174):** `const comandos = unitComandos(...)`. `unitScope(wt, config, task,
  locked, comandos)`.
- **La variable del prompt (línea 251):** `comandos: describeComandos(comandos)`.
- **`shellQuote`** se sigue importando para `installCommands`, si lo usa. Si no queda ningún uso, se
  saca el import.

### `src/phases/diagnosticar.ts`

- **Líneas 83 a 88:**
  `const comandos: Comandos = { ampliables: failing.map((f) => f.comando), exactos: [], fixers: [] };`
- **En el scope (línea 125):** `comandos` en lugar de `bash: commands`.
- **La variable del prompt (línea 35):** `comandos: describeComandos(comandos)`.

### Fases sin Bash

`aprender.ts:119`, `planificar.ts:128`, `probar.ts:171`, `reparar.ts:95`, `revisar.ts:87` y
`src/setup/draft.ts:238`: `bash: []` pasa a `comandos: SIN_COMANDOS`. Como su `policy.bash` es
`false`, no cambia el comportamiento.

### Prompts

- **`prompts/implementar.md:15`:** la oración «Solo podés correr estos comandos, tal cual:
  {{comandos}}. Usalos para comprobar tu trabajo antes de terminar.» pasa a «{{comandos}} Usá tus
  comandos para comprobar tu trabajo antes de terminar.» Lo que sigue («No formatees a mano…») se
  queda.
- **`prompts/diagnosticar.md:3`:** «Podés leer el repo y correr estos comandos para mirar:
  {{comandos}}» pasa a «Podés leer el repo con Read, Grep y Glob. {{comandos}}».
- **`prompts/planificar.md:16`**, la oración de permisos: «correr los comandos de sus criterios»
  pasa a «mirar el repo por Bash, correr los comandos de sus criterios con lo que quiera agregar
  detrás».

### Fixture

- **Se copia** `docs/plan-de-raiz/pr-03-comandos-rechazados.json` a
  `src/tripwires/fixtures/comandos-rechazados.json`, tal cual.
- **Qué contiene:** 135 casos con `id`, `run`, `sesion`, `comando`, `alcance`, `criterios`, `fixers`,
  `typecheck`, `env_files`, `esperado` (`"permitido"` o `"rechazado"`) y, en los rechazados,
  `porque`.
- **Los heredocs vienen recortados** a su primera línea, más `…` y `EOF`: el cuerpo no importa para
  la decisión.
- **Los 18 rechazados y por qué:**
  - 6 heredocs (`python3 - <<'EOF'`, `cat > /tmp/… <<'EOF'`);
  - 5 que corren `./.flowrunner/verify.sh`;
  - 3 `sh -c` o `for` con variables;
  - 1 `sed -i`;
  - 3 que escriben fuera del alcance: `mkdir -p src/panel`, porque `src/panel` no está en el
    alcance que esa sub-task tiene en el plan final; y dos con `npx prettier --check` sobre
    `CLAUDE.md` o sobre un archivo de otra sub-task, encadenados con `cp … /tmp/`.

## Tests (escribir primero y verlos fallar)

### `src/tripwires/comandos.test.ts` (nuevo)

El ayudante `scopeDe(caso)` arma un `Scope` con `root` igual a `realpathSync(tempDir("fr-cmd-"))`,
`owner: "ST-1"`, `writable: caso.alcance` y `env_files` en `unreadable`. Sus comandos son
`{ ampliables: [...caso.criterios, ...(caso.typecheck ? [caso.typecheck] : [])], exactos: [], fixers: caso.fixers }`,
y el resto de los campos, como en `rules.test.ts`.

1. **«los 135 comandos que rechazó el bloqueo en runs reales: pasan los que se pueden revisar y
   siguen afuera los scripts, el verify y lo que escribe fuera del alcance».** Recorre el fixture y
   espera `checkCommand(...).ok === (caso.esperado === "permitido")`, con el `id` y el comando en el
   mensaje del `expect`. Fallan 117 de 135 con la lista exacta; hoy ni compila, porque
   `checkCommand` no existe.
2. **«parte el comando en tramos por ;, &&, || y |, respetando las comillas».** `parseCommand`
   sobre `grep -n "a|b; c" src/x.ts | head -5 && git status` da 3 tramos; el segundo tiene
   `desdePipe: true`; el patrón queda como una sola palabra.
3. **«rechaza sustituciones, heredocs, segundo plano, subshells, llaves y ~».** Cada uno con su
   motivo exacto: `` echo `x` ``, `cat $(ls)`, `diff <(a) b`, `python3 - <<'EOF'`, `npx vitest &`,
   `(ls)`, `ls {a,b}`, `cat ~/.ssh/id_rsa`.
4. **«las asignaciones al principio pasan, salvo las de credenciales».**
   `CI=1 npx vitest run tests/a.test.ts` con ese criterio pasa;
   `ANTHROPIC_API_KEY=x npx vitest run tests/a.test.ts` se rechaza.
5. **«lectura: git que mira con cualquier opción, ls, cat, grep, sed -n y awk; git que escribe,
   no».** Pasan `git status --short`, `git log --oneline -5`, `git diff --stat`,
   `sed -n 1,30p src/x.ts` y `awk 'length > 150 {print FILENAME}' src/x.ts`. Se rechazan
   `git commit -m x`, `git checkout .`, `git -C /tmp status`, `git diff --no-index /etc/passwd x`,
   `git branch -D x`.
6. **«un criterio pasa con argumentos y filtros detrás; instalar, solo idéntico».** Con
   `ampliables: ["npx vitest run tests/a.test.ts"]` y `exactos: ["npm install zod"]`: pasan
   `npx vitest run tests/a.test.ts -t "x" 2>&1 | tail -20` y `npm install zod`; se rechaza
   `npm install zod lodash`.
7. **«el formateador y el lint, por su programa y sobre archivos del alcance».** Con
   `fixers: ["npx prettier --write --ignore-unknown"]` y `writable: ["src/a/"]`:
   - pasan `npx prettier --write src/a/x.ts`, `npx prettier --check src/a/x.ts` y
     `npx prettier --write 'src/a/[id]/page.tsx'`;
   - se rechazan `npx prettier --write src/b/y.ts` (fuera del alcance), `npx prettier --write src/a/*`
     (comodín), `npx prettier --write --plugin ./p.js src/a/x.ts` (opción) y
     `npx prettier --write CLAUDE.md` (protegida).
8. **«redirigir a un archivo, solo dentro del alcance; 2>&1 y /dev/null, siempre».** Pasan
   `ls src 2>/dev/null`, `npx vitest run tests/a.test.ts 2>&1` y `echo x > src/a/nota.txt`; se
   rechazan `echo x > /tmp/y` y `cat src/a/x.ts >> src/b/y.ts`.
9. **«los env_files no se leen ni se abarcan, tampoco con comodines ni con búsquedas
   recursivas».** Con `unreadable: [".env.local"]`, se rechazan `cat .env.local`, `cat .env*`,
   `grep -rn TOKEN .`, `rg TOKEN` y `find . -name x`. Pasan `grep -rn TOKEN src` y
   `cat .env.example`.
10. **«rutas absolutas y .. fuera del worktree se rechazan con el motivo de checkReadPath».**
    `cat /etc/hosts`, `ls ../otro`.
11. **«cd y el verify del repo se rechazan con lo que hay que hacer en su lugar».** `cd src && ls`
    y `./.flowrunner/verify.sh 2>&1 | tail -5`, con sus motivos exactos.
12. **«sed -i, sed sin -n, awk que escribe y find que ejecuta se rechazan».** `sed -i '' s/a/b/ x`,
    `sed s/a/b/ x`, `awk '{print > "f"}' x`, `awk '{system("rm x")}' x`,
    `find src -exec rm {} \;`. Este último cae por las llaves, antes de llegar a `-exec`: el test
    acepta cualquiera de los dos motivos.
13. **«describeComandos nombra los comandos de la sub-task y omite lo que no tiene».** Con las tres
    listas vacías, el texto no menciona «Podés correr» ni «Podés pasar».

### `src/tripwires/rules.test.ts`

- Se borra el `describe` de Bash (líneas 115 a 137): sus casos se cubren en `comandos.test.ts`, como
  el 6 (un comando permitido no abre la puerta a otro, por los tramos) y el 10.
- En `scope()` (línea 21), `bash: [...]` pasa a
  `comandos: { ampliables: ["pnpm vitest run tests/acceptance/ac1.test.ts"], exactos: [], fixers: [] }`.

### `src/tripwires/hook.test.ts`

- **Línea 21:** `bash: ["pnpm test"]` pasa a
  `comandos: { ampliables: ["pnpm test"], exactos: [], fixers: [] }`. El test «Bash permitido se
  reescribe para correr sin los secretos» (línea 87) sigue igual.
- **Test nuevo, «un comando de lectura encadenado pasa por el hook y se reescribe sin secretos»:**
  `git status --short; ls src` da `allow` y un `updatedInput` que empieza con `env -u`. Hoy da
  `deny`.

### `src/tripwires/diff.test.ts:36` y `test/fase3.int.test.ts:38`

`bash: []` pasa a `comandos: SIN_COMANDOS`.

### `src/phases/implementar.test.ts`

Las líneas son las de la versión de #72.

- **«instalar dependencias»** (líneas 65 y 68): pasa a esperar `unitComandos(...).exactos`, con los
  mismos valores.
- **«una sub-task corre sus criterios y el lint de su alcance, no el verify del repo»** (línea 75):
  espera
  `{ ampliables: ["npx jest seeds"], exactos: [], fixers: ["npx eslint --fix"] }`.
- **«el lint de la sub-task llega al archivo aunque la ruta tenga corchetes o paréntesis»**
  (línea 93) pasa a probar la política:
  `checkCommand(scope, "ls 'src/app/o/[publicId]/page.tsx' 'src/app/(comprador)/page.tsx'")` con
  `fixers: ["ls"]` pasa, y los archivos están en el alcance. Se conserva la comprobación con `sh` y
  `zsh` de que el comando citado lista los dos archivos.
- **«el comando de un criterio que es el verify del repo no pasa a la sub-task»** (línea 115):
  espera que `ampliables` sea `["npx jest conexiones"]` para cada variante del verify.
- **«una sub-task puede correr el formateador de su alcance y el typecheck del repo»** (de #72):
  espera `ampliables: ["pnpm run typecheck"]` y `fixers: ["npx prettier --write"]`.

### `src/phases/diagnosticar.test.ts`

Si algún test arma `bash`, pasa a `comandos`. Si alguno compara la variable `comandos` del prompt,
pasa a esperar el texto de `describeComandos`.

## Docs a actualizar

- **ADR nuevo, `docs/adr/0021-politica-de-comandos.md`:**
  - **Contexto:** los 135 rechazos, con el desglose del objetivo.
  - **Decisión:** las decisiones 1 a 12.
  - **Alternativas descartadas:**
    - una lista más larga de comandos exactos, que no cubre las variantes de opciones;
    - permitir cualquier comando y confiar en el doble control sobre el diff, que no ve la red ni la
      lectura de secretos.
  - **Verificación:** `comandos.test.ts`, con la tabla de casos.
- **`README.md`:** si hay una sección sobre lo que puede correr una sub-task, que describa la
  política en dos oraciones. Si no la hay, no se agrega.
- **`skills/flowrunner/SKILL.md`:** sin cambios.

## Verificación

```sh
pnpm vitest run --project unit src/tripwires src/phases/implementar.test.ts src/phases/diagnosticar.test.ts
pnpm lint
pnpm test
pnpm test:integration
```

Antes de implementar, el test 1 tiene que fallar (no compila). Después, pasa con los 135 casos.

## Fuera de alcance

- Permitir `cd`, variables, heredocs o scripts de un solo uso.
- Una lista de programas extra por repo en la config.
- Cambiar el doble control sobre el diff (`checkChanges`).
- Bash en planificar, revisar o probar.

## Riesgos y cómo se detectan

- **Leer un secreto por un camino no previsto**, como un programa de lectura que no está en la
  tabla. Lo frena la regla «todo lo demás se rechaza», y el test 9 fija los caminos conocidos.
- **Un fixer que ejecuta código**, como un `--plugin` de Prettier. Se rechazan esas opciones (test
  7). El código que un agente escribe en su alcance igual corre con los criterios: no es una
  frontera nueva.
- **Falsos rechazos nuevos.** `stats --runs` de la PR 02 cuenta los rechazos de Bash por run: si
  pasan de 2, se miran los motivos y se suma un caso a la tabla.
- **Diferencias entre el parser y `sh`.** Ante algo ambiguo, el parser rechaza («sintaxis»). Es
  conservador: el costo es un turno, no una puerta abierta.
