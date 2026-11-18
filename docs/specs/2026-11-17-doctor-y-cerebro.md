# Doctor en el panel y auditoría del cerebro

2026-11-17 · pedido: «en la pestaña del plugin, un botón doctor que me permita hacer self-update,
actualizar el plugin de Orca, verificar si los conocimientos del cerebro son consistentes y valiosos,
y tomar decisiones en base a ese conocimiento. Mi objetivo es que flowrunner sea cada vez más
autónomo y tenga menos bloqueantes».

La persona pidió implementarlo sin frenar a preguntar: las decisiones de abajo son de quien lo
implementó y quedan escritas para revisarlas en la PR.

## Etapa A · Doctor en el panel (ADR 0039)

- Un botón **Doctor** en la cabecera de la pestaña, también mientras se leen los runs, abre una
  vista en lugar de los runs; **Volver a los runs** la cierra.
- La vista muestra los chequeos de `flowrunner doctor --json` (los que fallan, con su arreglo) y la
  versión: el commit que corre y cuántos le faltan para `origin/main` **del último fetch**. Sin red:
  `doctor` se lee cada vez que se abre la vista. `flowrunner doctor` en la terminal suma la misma
  línea.
- **Actualizar flowrunner** y **Actualizar el plugin de Orca** piden confirmación y corren como
  tareas de fondo: `flowrunner self-update --fondo` y `flowrunner orca install --fondo`. Cada tarea
  deja su estado en `~/.flowrunner/tareas/<nombre>.json` y su salida en `<nombre>.log`;
  `flowrunner tareas --json` las lista. El panel las lee en cada refresco mientras la vista está
  abierta y vuelve a leer `doctor` cuando una termina.
- `self-update --fondo` con un run corriendo se rechaza enseguida, con el mismo motivo que
  `self-update`. Una tarea que dice correr sin su proceso vivo se ve cortada, con dónde está el log.
  No se lanza dos veces la misma.
- Si Orca pide aprobar el plugin, la tarea termina en falla con el comando para la terminal:
  `flowrunner orca install --approve <fp>`. El panel no aprueba plugins: `--approve` con `--fondo`
  se rechaza.

## Etapa B · Auditar el cerebro y decidir (ADR 0040)

- `flowrunner brain audit <ruta>` resuelve el proyecto registrado de esa ruta (también desde uno de
  sus worktrees), trae origin y abre un worktree limpio de la base. Una sesión de **solo lectura**
  (Read, Grep, Glob; modelo de revisar) lee el cerebro entero, comprueba contra el código lo que el
  cerebro nombra y recibe la historia de los runs del proyecto, armada por código desde sus logs:
  cada detención con su motivo y lo que respondió la persona (eligió el arreglo propuesto n de m,
  siguió igual, Autofix, rehízo, lo arregló a mano, abortó), los cambios pedidos al plan y los
  motivos que más se repiten (`stats`).
- Devuelve, validado con zod: `resumen`, `hallazgos` (contradicción, duplicada, obsoleta, sin valor,
  no alcanzó, falta; con archivo y evidencia) y `decisiones`, cada una con `por_que` (la evidencia),
  `reduce` (qué detención deja de pasar, o que solo ordena) y `ediciones` exactas: `buscar` un texto
  que aparece una sola vez y `reemplazar`.
- Las ediciones solo pueden tocar `.flowrunner/*.md`, `.flowrunner/propuestas/*.md` y
  `.flowrunner/config.yaml`: ni `verify.sh`, que corre en cada run, ni `ejemplos/`, ni código. El
  código revisa cada decisión sola contra el cerebro auditado; la que no se puede aplicar queda en el
  informe con su motivo y no se puede elegir.
- La auditoría se guarda en `~/.flowrunner/auditorias/<proyecto>/<id>.json`, con el sha256 de cada
  archivo que tocan sus decisiones, y su informe en `<id>.md`. `brain audit <ruta> --ultima` la
  devuelve con el informe; `--fondo` la corre como tarea (`auditar-<proyecto>`).
- `flowrunner brain apply <proyecto>/<id> --decision D1 [--decision D3 …]` aplica solo las elegidas
  sobre el cerebro de hoy de la base: una cuyo archivo cambió desde la auditoría, o que choca con otra
  elegida, no entra, y la PR lo dice. Si no entra ninguna, o el cerebro resultante no carga
  (`loadBrain`, `loadRepoConfig`), no se abre nada. La PR va en
  `chore/flowrunner-auditoria-<id>-<decisiones>`, una rama que `pushBranch` ahora permite. Una
  decisión ya aplicada no se vuelve a ofrecer.
- En la vista Doctor, la sección **Cerebro** del proyecto enfocado en Orca: **Auditar el cerebro**
  (pide confirmación: es una sesión de Claude), en curso mientras corre, y la última auditoría con su
  resumen, los hallazgos y las decisiones para elegir con un toque, **Abrir PR con las elegidas** y
  **Ver el informe**, que lo abre como pestaña de Orca.

## Por qué así

- **Nada se aplica solo.** El objetivo es que flowrunner pregunte menos, pero el cerebro es lo que
  leen todos los runs: un cambio malo ahí se repite en cada uno. La auditoría propone con evidencia y
  la persona elige; la PR se revisa como cualquier otra.
- **Ediciones exactas, no reescrituras.** Un `buscar`/`reemplazar` que aparece una sola vez se puede
  revisar, comprobar contra el archivo de hoy y rechazar si cambió. Reescribir el archivo entero
  pisaría lo que la persona escribió después.
- **La historia la arma el código.** Contar detenciones y respuestas no necesita modelo, y así la
  sesión no gasta turnos leyendo logs.
- **Config como decisión.** Las detenciones que más se repiten se resuelven muchas veces con la config
  (`vueltas`, `explorar_antes`, `env_files`, `probar`): si la persona casi siempre eligió el primer
  arreglo propuesto, flowrunner podría haberlo hecho solo.

## Fuera de alcance

- Auditar de forma periódica o automática.
- Proponer cambios al código del repo: si el problema está en el código, va como hallazgo, sin
  decisión.
- Aprobar el plugin de Orca desde el panel.
