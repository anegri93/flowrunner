# flowrunner en Orca

Una pestaña en la barra derecha de [Orca](https://www.onorca.dev) con el progreso de los runs,
como `flowrunner watch`, pensada para el ancho angosto de la barra:

- Cada run es una tarjeta, al estilo de flowindex: el estado como etiqueta («EN CURSO», «TE
  ESPERA»), el título, el tiempo, y las ocho etapas del flujo en lista con sus intentos y su tiempo.
  La etapa que trabaja gira, y debajo de la actual se ve qué está haciendo.
- Los más recientes arriba. Los terminados muestran solo su etapa actual hasta que los abrís.
- Debajo de la etapa actual: las sub-tasks con su estado y lo que hace la sesión que corre. El costo
  queda chico al pie.
- Cuando un run con la PR abierta se cierra, después de tu merge, su informe final se abre solo como
  pestaña de Orca, si el panel está abierto.
- El botón de pasos de una sesión, «Plan» y tocar la etapa «Aprobar», también con el plan ya
  aprobado, abren el archivo como pestaña de Orca, en el proyecto del run. El plugin lo escribe en `.git/flowrunner/<run>/` del repo, que git no versiona.
- Tocar una etapa que ya arrancó abre su detalle como pestaña: los intentos y cómo terminó cada uno,
  lo propio de la etapa (la rama, las sub-tasks y criterios, la aprobación, los hallazgos de la
  revisión, la PR), y sus decisiones, rechazos, avisos y sesiones. Tocar una sub-task abre lo que
  tenía que hacer, lo último que dijo su sesión y el diff de sus commits.
- Las decisiones que el run espera, en una fila: aprobar o pedir cambios al plan, reanudar un run
  detenido o rehacerlo desde la fase que sugiere el motivo, y «Aprender ahora» en un run con la PR
  abierta, para no esperar el chequeo de cada 10 minutos después de mergear. Aprobar, reanudar y
  rehacer piden confirmación.
- Si el plan cambia lo que ya existe, la tarjeta lo avisa y la pestaña del plan lo pone arriba de
  todo. Aprobar muestra cada cambio, con dónde está y qué criterio lo pide, y el botón pasa a ser
  «Acepto los cambios y apruebo», que aprueba con `--acepto-cambios`. Si alguno no va, pedí cambios.
- Al pie de cada run vivo, separado de las decisiones de la etapa, «Abortar el run»: corta lo que
  corre, en cualquier etapa, y borra sus worktrees; la rama y la PR quedan. Pide confirmación.

Se refresca cada 3 segundos mientras la pestaña se ve, y sigue al proyecto que tenés enfocado en Orca,
como el explorador y los agentes: muestra los runs de ese proyecto, incluidos los de sus worktrees,
con su nombre arriba y cuántos runs hay en otros. Al cambiar de proyecto lee enseguida, sin esperar los 3 segundos, y mientras tanto muestra
la nave en camino en vez de los runs del anterior. Para saber cuál está enfocado pide el permiso
`workspace:read`; sin él, o sin un proyecto enfocado, muestra todos.

- `src/worker.ts` corre el CLI de flowrunner en un shell de login, para tener tu PATH: `watch`,
  `report --sesion`, `plan`, y cada decisión como un comando fijo (`approve`, `changes`, `resume`,
  `rerun --desde`, `learn`, `abort`). Valida el id del run, la fase y el motivo antes de llegar al shell.
- `src/panel.tsx` dibuja la pestaña con los componentes de Orca 1.4.247; mientras lee los runs por primera vez, por ejemplo al cambiar de proyecto, muestra la nave en camino de `assets/nave.webp`, que sale de `scripts/nave.svg` con `scripts/nave-webp.mjs`.
- `src/runs.ts` ordena los runs, agrupa las fases y decide qué decisiones ofrecer, sin depender de
  Orca.

## Instalar

Con Orca abierto:

```sh
flowrunner orca install
```

Carga esta carpeta, esté donde esté clonado flowrunner. Como corre comandos en tu máquina, Orca pide
aprobarlo: el comando imprime el fingerprint y lo volvés a correr con `--approve <fingerprint>`. Si
mudás la carpeta de flowrunner, volvé a correrlo. Si Orca no está en `/Applications`, pasá su CLI en
`ORCA`. Después aparece el ícono del cohete en la barra
derecha. Si `flowrunner` no está en el PATH de tu shell de login, cambiá el comando en Settings ›
Plugins › flowrunner.

## Probar

```sh
pnpm orca:test
```

Corre los tests del plugin con `orca plugin test`, con un flowrunner falso en `test/`.
