# 0020 · flowrunner corre desde un worktree fijo

Estado: Aceptada · 2026-11-10

## Contexto

ML-1 falló 3 veces en revisar con «a la plantilla revisar le faltan: rechazos». El comando
`flowrunner` (`~/.local/bin/flowrunner`), el `tick` de launchd y el plugin de Orca corrían todos desde
el checkout de desarrollo: el link apuntaba a su `bin/flowrunner.js`, el plist llevaba esa ruta y
`ORCA_PLUGIN_DIR` salía de `import.meta.dirname`. Alguien cambió de rama en el checkout con el run en
curso, y como el proceso del run lee los prompts del disco en cada sesión, leyó un prompt de otra rama.

## Decisión

- **El flowrunner que corre vive en `~/.flowrunner/app`** (`join(flowrunnerHome(env), "app")`): un
  worktree `--detach` del mismo repo en `origin/main`, con su propio `node_modules`.
- **Una sola puerta de entrada, `flowrunner self-update`:** crea la app o la mueve a `origin/main`,
  instala con `pnpm install --frozen-lockfile` y re-apunta el comando, launchd, el plugin de Orca y la
  skill. Lo hace corriendo `_reapuntar` con el código de la app, así `BIN`, `ORCA_PLUGIN_DIR` y la
  skill salen de ahí sin cambiar cómo se calculan.
- **Se niega con un proceso de run vivo** (un lugar con pid vivo o un `tick` corriendo). Los runs que
  esperan no frenan nada: siguen con el código nuevo, y el log es de solo agregar.
- **`init --aplicar` termina con `self-update`,** y `doctor` marca el comando o el plist que no apuntan
  a la app, con el arreglo `flowrunner self-update`.

Detalle en `docs/plan-de-raiz/pr-01-instalacion-separada.md`.

## Alternativas descartadas

- Un paquete npm publicado: es pesado para un proyecto personal.
- Un bloqueo en tiempo de ejecución que impida correr desde el checkout: rompe los tests, que corren
  el CLI desde el checkout.

## Verificación

`test/self-update.int.test.ts`, con la regresión de ML-1, y `src/cli/doctor.test.ts`, según la spec.
