# flowrunner en Orca

Una pestaña en la barra derecha de [Orca](https://www.onorca.dev) con el progreso de los runs,
como `flowrunner watch`, pensada para el ancho angosto de la barra:

- Cada run es una tarjeta, como el seguimiento de un pedido: una frase con su estado («🟡 El plan
  te espera», «🔵 Implementando · 1 de 2 sub-tasks»), una barra de avance y cinco pasos, Plan, Tu
  OK, Código, Control y PR, que marcan lo listo, lo actual, lo que te espera y lo que falló.
- Los más recientes arriba. Los terminados muestran solo el resumen hasta que abrís su detalle.
- El detalle muestra las sub-tasks como lista de tareas y lo que hace la sesión que corre, con sus
  pasos a un toque.
- Las decisiones que el run espera: ver el plan, aprobarlo o pedir cambios; reanudar un run
  detenido o rehacerlo desde la fase que sugiere el motivo. Aprobar, reanudar y rehacer piden
  confirmación.

Se refresca cada 3 segundos mientras la pestaña se ve.

- `src/worker.ts` corre el CLI de flowrunner en un shell de login, para tener tu PATH: `watch`,
  `report --sesion`, `plan`, y cada decisión como un comando fijo (`approve`, `changes`, `resume`,
  `rerun --desde`). Valida el id del run, la fase y el motivo antes de llegar al shell.
- `src/panel.tsx` dibuja la pestaña con los componentes de Orca 1.4.246.
- `src/runs.ts` ordena los runs, agrupa las fases y decide qué decisiones ofrecer, sin depender de
  Orca.

## Instalar

Con Orca abierto:

```sh
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load ~/Documents/PersonalProjects/flowrunner/orca
```

Como corre comandos en tu máquina, Orca pide aprobarlo: el comando imprime el fingerprint y lo
volvés a correr con `--approve <fingerprint>`. Después aparece el ícono del cohete en la barra
derecha. Si `flowrunner` no está en el PATH de tu shell de login, cambiá el comando en Settings ›
Plugins › flowrunner.

## Probar

```sh
pnpm orca:test
```

Corre los tests del plugin con `orca plugin test`, con un flowrunner falso en `test/`.
