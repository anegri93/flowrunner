# 0039 · El doctor en el panel de Orca, con las actualizaciones como tareas de fondo

Estado: Aceptada · 2026-11-17

## Contexto

`flowrunner doctor`, `flowrunner self-update` y `flowrunner orca install` existían solo en la
terminal. Desde Orca no se veía qué le faltaba a la máquina, ni si el flowrunner que corre estaba
atrás de `main`, y actualizar obligaba a salir del panel. Además, los comandos del worker del plugin
se cortan a los 20 segundos: `self-update` instala dependencias (hasta diez minutos) y re-apunta el
plugin de Orca, lo que recarga el worker que lo lanzó en el medio.

## Decisión

1. **Un botón «Doctor» en la cabecera de la pestaña** abre una vista en lugar de los runs: los
   chequeos de `doctor --json`, cada uno con su arreglo; la versión que corre comparada con
   `origin/main`; «Actualizar flowrunner» y «Actualizar el plugin de Orca», que piden confirmación; y
   las tareas de fondo con su estado. «Volver a los runs» la cierra. No se guarda.
2. **La versión se compara sin red**, contra el `origin/main` del último fetch: `doctor` se lee cada
   vez que se abre la vista y no puede esperar a GitHub. Dice «del último fetch»; `self-update` trae
   origin igual.
3. **Actualizar y cargar el plugin son tareas de fondo** (`self-update --fondo`, `orca install
   --fondo`): un proceso aparte que deja su estado en `~/.flowrunner/tareas/<nombre>.json` y su
   salida en `<nombre>.log`. El panel las lee con `flowrunner tareas --json`, barato, en cada
   refresco mientras la vista está abierta, y vuelve a leer `doctor` cuando una termina. Una tarea
   que dice correr sin su proceso vivo se muestra cortada, con dónde está el log. No se lanza dos
   veces la misma.
4. **Lo que se rechaza enseguida se rechaza antes de lanzar**: `self-update --fondo` con un run
   corriendo contesta el mismo error que `self-update`, y el panel lo muestra.
5. **Aprobar el plugin sigue siendo de la persona.** Si Orca pide `--approve`, la tarea termina en
   falla con el comando exacto para la terminal (`flowrunner orca install --approve <fp>`).
   `--approve` con `--fondo` se rechaza: el panel nunca aprueba solo un plugin que corre comandos en
   la máquina.
6. **El worker solo corre comandos fijos**, como con las decisiones: `doctor --json`, `tareas
   --json`, `self-update --fondo --json` y `orca install --fondo --json`. Nada que escriba la persona
   llega al shell.

## Alternativas descartadas

- **Correr `self-update` desde el worker con un tope más largo.** Re-apuntar el plugin recarga el
  worker: la respuesta no llega nunca y el proceso queda huérfano a mitad de la instalación.
- **Comparar contra GitHub con `git ls-remote` en cada doctor.** Suma la red a cada apertura de la
  vista y a los tests; el último fetch alcanza para saber si conviene actualizar.
- **Aprobar el plugin desde el panel con el fingerprint que imprime Orca.** Es justo lo que la
  aprobación de Orca existe para que decida una persona.

## Verificación

- `src/cli/tareas.test.ts`: una tarea sin proceso vivo se ve cortada; recién lanzada sin pid no;
  terminar deja ok o la falla con el comando para seguir; el `--approve` se arma solo de un
  fingerprint válido.
- `src/setup/version.test.ts`: cuenta los commits que faltan para `origin/main` sin red.
- `test/orca.int.test.ts`: `orca install --fondo` corre aparte y deja el `--approve` para la
  terminal; con `--approve` se rechaza.
- `orca/src/worker.test.ts` y `orca/src/doctor.test.ts`: los comandos fijos, doctor que sale 1, la
  confirmación y el seguimiento de la tarea hasta que termina.
