# flowrunner en Orca

Una pestaña en la barra derecha de [Orca](https://www.onorca.dev) con el progreso de los runs,
como `flowrunner watch`, pensada para el ancho angosto de la barra:

- Cada run es una tarjeta, al estilo de flowindex: el estado como etiqueta («EN CURSO», «TE
  ESPERA»), el título, el tiempo, y las nueve etapas del flujo en lista con sus intentos y su tiempo.
  Cada etapa tiene un indicador según su estado, y la que trabaja, uno animado propio: un arco al
  preparar, puntos que laten al planificar, barras en paralelo al implementar, un check que se dibuja
  al verificar, una lupa al revisar, una onda al probar, una flecha que sube al entregar. Lo que te
  espera respira, lo que volvió da una vuelta hacia atrás, lo pausado titila; lo terminado y lo
  pendiente quedan quietos, y con el movimiento reducido de macOS, todo. Debajo de la actual se ve
  qué está haciendo.
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
- Aprobar se habilita después de abrir el plan (el botón Plan o el link de la etapa Aprobar). Un plan
  corregido se vuelve a abrir. Abrirlo con `flowrunner plan` o desde Claude no cuenta, y el panel lo
  recuerda aunque lo recargues. Si el plan cambió desde que lo abriste, el panel no lo aprueba y te
  pide abrirlo de nuevo. Aprobar, pedir cambios, arreglar, arreglarlo a mano y seguir igual llegan a
  flowrunner con `--origen orca`.
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
- La pestaña es un frame (`sandboxed-ui`), no un panel de componentes: los componentes de Orca no
  dibujan SVG propio y rechazan las imágenes animadas, y los indicadores son SVG con animación CSS.
  `panel/index.html` carga `src/frame.ts`, lo único con DOM: lee los runs, escucha los clics y
  redibuja. `src/estado.ts` tiene el estado y qué pasa al tocar cada control, y `src/vista.ts` lo
  dibuja como HTML, con todo el texto escapado; los dos se prueban sin DOM. `src/indicadores.ts`
  tiene un SVG por estado; cada redibujo sigue la animación donde iba. Los planes abiertos y las
  tarjetas abiertas o cerradas quedan en el storage del plugin (`storage:own`). Mientras lee los runs
  por primera vez muestra la nave de `assets/nave.png`, que sale de `scripts/nave.svg` con
  `scripts/nave-png.mjs`.
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
