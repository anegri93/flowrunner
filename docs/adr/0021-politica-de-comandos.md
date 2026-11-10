# 0021 · Política de comandos

Estado: Aceptada · 2026-11-10

## Contexto

En 9 runs, el bloqueo rechazó 135 comandos de Bash, 61 de ellos en VF-6. Una sub-task solo podía
correr una lista exacta de comandos (`checkBash`), comparada como texto:

- unos 100 eran de solo lectura: `git status --short` cuando la lista tenía `git status`,
  `git log --oneline -5` cuando tenía `-10`, `ls`, `cat`, `grep`, `sed -n`, encadenados con `;`;
- 20 eran de formato, como `npx prettier --write`;
- unos pocos eran un criterio con `| tail` detrás;
- el resto eran scripts ad hoc o escrituras.

Cada rechazo es un turno perdido, y varios terminaron en sub-tasks «sin cambios».

## Decisión

La lista exacta se reemplaza por una política que evalúa cada tramo del comando
(`src/tripwires/comandos.ts`, `checkCommand`):

1. Un comando se parte en tramos con `;`, `&&`, `||`, `|` y salto de línea, y se permite solo si cada
   tramo se permite. El primero que falla da el motivo.
2. Las comillas simples son literales; dentro de las dobles se escapan `\"`, `\\`, `\$` y `` \` ``;
   fuera de comillas, `\x` es `x`.
3. Siempre se rechazan, aunque estén entre comillas dobles: `$( )`, backticks, `<( )`, `>( )`,
   heredocs, un `&` suelto, `( )` y `{ }` sin comillas, y una palabra que empieza con `~`.
4. Las variables (`$X`, `${X}`, `$1`, `$?`…) se rechazan fuera de comillas simples: una ruta con una
   variable no se puede comprobar contra el alcance. Un `$` suelto, como el ancla de `grep 'x$'`, es
   literal.
5. Las asignaciones al principio del tramo (`CI=1 npx vitest …`) se sacan antes de evaluar; una a una
   credencial (`SECRET_ENV_VARS`) se rechaza.
6. `cd` se rechaza: los comandos corren en la raíz del worktree.
7. Las redirecciones a `/dev/null` y entre descriptores (`2>&1`) pasan siempre. Escribir en un archivo
   (`>`, `>>`, `&>`) pasa por `checkWritePath`; leer de uno (`<`), por `checkReadPath`.
8. Un tramo se permite si es, en este orden: idéntico a un comando de instalar lo declarado
   (`exactos`); un criterio o el typecheck con argumentos de más (`ampliables`); el programa del lint
   o del formato del repo sobre archivos del alcance, sin las opciones que cargan código o
   configuración (`fixers`); un programa de lectura con sus reglas de argumentos; `mkdir -p` o `tee`
   dentro del alcance. Todo lo demás se rechaza con el motivo de su categoría: script, red, archivos,
   git que escribe, verify del repo.
9. Los programas de lectura (`git` que mira, `ls`, `cat`, `head`, `grep`, `rg`, `find`, `sed -n`,
   `awk`, `sort`, `jq`…) comprueban sus rutas con `checkReadPath`, o con `checkSearchPath` si la
   búsqueda es recursiva, y un comodín sin comillas no puede abarcar un `env_file`.
10. Cada rechazo dice qué hacer en su lugar.
11. `Scope.bash` se reemplaza por `Scope.comandos: Comandos`.
12. El prompt de cada sesión con Bash describe la política con `describeComandos`, en lugar de listar
    comandos «tal cual».

Un criterio tal cual pasa siempre, aunque encadene pasos con `&&`: es lo que ya permitía la lista
exacta. Detalle en `docs/plan-de-raiz/pr-03-politica-de-comandos.md`.

### Lo que la spec no nombraba

El shell toma caminos que las reglas literales no veían. Se cierran así, cada uno con su caso en
`comandos.test.ts`:

- **Las asignaciones solo van delante de un criterio o de instalar.** Delante de `git` o `ls`,
  `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*` (con `core.fsmonitor`) o `PATH` hacen correr otro programa.
- **Las opciones de los programas de lectura no se llevan la ruta que sigue.** `cat -n .env.local`
  pasaba porque `-n` se tomaba como opción con valor. El valor de `--from-file=x` o `-fx` también se
  comprueba como ruta. `diff -r` busca como `grep -r`.
- **Un comodín se mira como lo ve el shell desde la raíz:** `./.env*`, `src/../.env*`, un `.*` que
  abarca `..`, y una carpeta que contiene un `env_file` en una búsqueda recursiva.
- **`grep -r` sin rutas busca en `.` aunque le llegue un pipe** (grep de BSD y de GNU); solo `rg` lee
  el pipe. Las opciones con valor (`-A 3`, `-m 1`) no corren el patrón, y `-f archivo` se comprueba.
- **sed se lee comando por comando:** `1w x`, `$w x`, `1r x`, `1e x` y `s///e` escriben, leen o
  ejecutan; `-ni` y `-I` editan en el lugar.
- **awk:** `system (` con espacio, `@load`, `ARGV` y las opciones de gawk (`-l`, `-i`, `-E`).
- **Opciones que escriben, ejecutan o no terminan:** `sort -o` en un grupo, `-T` y
  `--compress-program`; `tree -o`; `file -C`; `jq -f`; `tail -f` en un grupo.
- **git que mira:** `blame --contents`, `grep --untracked` y `--no-exclude-standard`, y
  `branch --edit-description`.
- **`$'…'` y `$"…"`** se rechazan: bash los lee con escapes propios.
- **Un `#` al principio de palabra es un comentario hasta el fin de la línea,** como para `sh`: las
  comillas que hay ahí no abren nada.
- **Las opciones largas abreviadas cuentan como las enteras**, hasta de una letra (`--o`, `--recur`,
  `--no-ind`, `--conte`), y un grupo de opciones cortas se lee letra por letra (`git grep -lO<pager>`,
  `file -bf<archivo>`).
- **diff recorre siempre como una búsqueda:** `diff -N . src` imprime lo que hay en `.`.
- **awk:** un `>` fuera de las cadenas es una redirección, salvo `>=` o una comparación con un número.
- **Un fixer no recibe llaves, comodines ni `..`, aunque vayan citados:** prettier y eslint los
  expanden por su cuenta. El valor de `--x=ruta` se comprueba como escritura.
- **Después de `--`, todo es un archivo**, también para `tee`, `mkdir`, `uniq`, `jq`, `sort` y los
  fixers.
- **Las rutas se resuelven con las mayúsculas del disco** (`realpathSync.native`): en APFS,
  `.ENV.LOCAL` es `.env.local`.
- **`$[…]`**, la aritmética de bash, se rechaza como una sustitución.
- **git no recibe archivos como valor de una opción** (`grep -f`, `blame -S`,
  `--ignore-revs-file`, `--pathspec-from-file`, `ls-files -X`): imprime en el error las líneas que
  no entiende.
- **Cada programa de lectura sabe qué letras toman valor:** `file -m` y `-M` leen un archivo; las de `cut`
  son listas o delimitadores, así que `cut -d /` no se comprueba como ruta.

## Alternativas descartadas

- **Una lista más larga de comandos exactos:** no cubre las variantes de opciones (`-5` o `-10`,
  `--short`), que eran la mayoría de los rechazos.
- **Permitir cualquier comando y confiar en el doble control sobre el diff:** el doble control ve lo
  que cambió en el worktree, no la red, la lectura de secretos ni lo que se escribe fuera.

## Verificación

`src/tripwires/comandos.test.ts`, con la tabla de los 135 comandos reales
(`src/tripwires/fixtures/comandos-rechazados.json`): pasan 117 y siguen rechazados 18. Los caminos de
arriba tienen su propio bloque de tests.
