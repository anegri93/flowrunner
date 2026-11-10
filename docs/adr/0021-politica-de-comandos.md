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

## Alternativas descartadas

- **Una lista más larga de comandos exactos:** no cubre las variantes de opciones (`-5` o `-10`,
  `--short`), que eran la mayoría de los rechazos.
- **Permitir cualquier comando y confiar en el doble control sobre el diff:** el doble control ve lo
  que cambió en el worktree, no la red, la lectura de secretos ni lo que se escribe fuera.

## Verificación

`src/tripwires/comandos.test.ts`, con la tabla de los 135 comandos reales
(`src/tripwires/fixtures/comandos-rechazados.json`): pasan 117 y siguen rechazados 18.
