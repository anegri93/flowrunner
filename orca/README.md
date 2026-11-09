# flowrunner en Orca

Una pestaña en la barra derecha de [Orca](https://www.onorca.dev) con el progreso de los runs,
como `flowrunner watch`, pensada para el ancho angosto de la barra:

- Los runs más recientes arriba. Cada uno se contrae o se expande tocándolo; los terminados, con la
  PR abierta, arrancan contraídos.
- Las fases listas en una línea que se expande, la etapa actual destacada con sus sub-tasks y
  sesiones, y en otra línea las que faltan.
- El botón de cada sesión muestra sus pasos.
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
