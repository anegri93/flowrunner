# 0016 · Probar usa la feature en un entorno que levanta y baja flowrunner

Estado: Aceptada · 2026-11-09

## Contexto

Verificar corre los tests y revisar lee el diff, pero nadie usaba la feature como la usaría una persona.
La persona quería que el agente pruebe por la API y por la plataforma, con video, para validar ella
también. En mango-portal-colaborador, `start.sh` usa Atlas y AWS reales por defecto y se saltea los
servicios que ya responden: un agente que levante el entorno por su cuenta podía tocar datos reales o
probar el entorno de la persona en vez de la feature.

## Decisión

- **Una fase propia**, después de revisar: si el entorno falla, se reintenta solo probar, sin repetir
  la revisión. Una prueba en falla devuelve su sub-task a implementar, como un bloqueante.
- **El entorno lo levanta flowrunner**, con `probar.levantar` de la config del repo, desde el worktree
  de la feature y con los `env_files` copiados del checkout. Si una URL responde antes de levantar, se
  detiene: sería otro entorno. Al terminar corre `probar.bajar` y mata el grupo de procesos.
- **El agente no corre comandos.** Lee el código, usa la API con una herramienta propia que solo llega
  a las URLs del entorno y deja cada pedido en `http.md` con las cabeceras secretas tapadas, y navega con
  Playwright MCP 0.0.83, limitado a esos orígenes. Las herramientas del navegador van por lista: afuera
  `browser_run_code_unsafe`, que corre código en la máquina, y `browser_file_upload`; una captura no
  elige dónde escribirse.
- **El video lo garantiza la config, no el agente:** el contexto del navegador graba cada página en
  `pruebas/probar-<n>/video/`, con `slowMo` para que se vea cada acción. El servidor de Playwright lo
  lanza y lo baja flowrunner por HTTP, no el CLI de Claude, para que lo mate con SIGTERM y no con el
  SIGKILL de la limpieza de sesiones.

## Evidencia

Medido el 2026-11-09 con Playwright MCP 0.0.83 y Chrome sin ventana: `allowedOrigins` bloquea otros
orígenes con `ERR_BLOCKED_BY_CLIENT`. El video se escribe a medida que se graba y queda legible aunque
el servidor muera con SIGKILL después de unos segundos; con un SIGKILL inmediato no queda archivo.

## Verificación

`smoke/probar.smoke.ts`, con el SDK real y Chrome: Haiku prueba una API y una pantalla de juguete, las
dos pruebas salen `ok`, `http.md` tiene el pedido, queda un video de más de 1 KB y no queda vivo ni el
entorno ni el navegador. `src/phases/probar.test.ts`, `src/probar/*.test.ts` y los tests del engine y
del hook cubren el resto sin modelo.
