# 0025 · Planificar retoma su sesión cuando el gate rechaza el plan

Estado: Aceptada · 2026-11-10

## Contexto

El plan se escribe recién después de pasar el gate, y cada intento de planificar arrancaba de cero:
reset del worktree y sesión nueva. Un rechazo por una sola declaración faltante volvía a explorar todo
el repo. En ML-1 y VF-5 el segundo intento costó US$ 2,07 y 2,77, y 9,2 y 10,3 minutos, con 89 y 121
turnos. Un replan con contexto (VF-6) cuesta entre US$ 0,69 y 1,03, en 2,5 a 3,7 minutos.

## Decisión

1. **Solo el reintento de planificar por un rechazo del gate retoma la sesión** (`resume` del SDK).
   Es el reintento cuando la última `accion_terminada` de planificar es una `falla` de clase `gate`,
   su motivo es la instrucción del intento, y después no hubo `rehacer` ni `cambios_pedidos`. Un
   pedido de cambios, un `rerun` o el primer intento siguen con una sesión nueva.
2. **Las sesiones de planificar se persisten** con un `sessionId` propio (`randomUUID()`), para
   conocerlo sin leer el stream. Las demás fases siguen sin persistir (`persistSession: false`).
3. **El id queda en `runs/<id>/planificar-sesion.json`**, con `{ sessionId, nombre }`, no en un
   evento: es una optimización. Si falta o está roto, se planifica de cero, como antes. El reintento
   retomado no resetea nada: corrige sobre el worktree que dejó el intento rechazado, con un solo
   mensaje que trae el motivo del gate. Los tests nuevos que el plan corregido ya no declara se
   descartan antes del gate, que es lo que antes hacía el reset.
4. **Fallback:** si la sesión retomada no devuelve `ok` ni `limite` («No conversation found», un error
   del CLI), queda el aviso `no se pudo retomar la sesión del plan (<motivo>): planifica de cero` y, en
   la misma llamada a la fase, se corre el camino de siempre. Los intentos del engine no cambian: el
   retomado es un intento más, y cada sesión emite su propio `uso`.
5. **Solo se retoma sobre el worktree que vio la sesión.** El archivo se borra al empezar un intento
   nuevo (que resetea la rama), cuando el gate rearma la rama para sacar lo que un replan no conserva
   (ADR 0024), y no se escribe si el intento no pudo reconstruir el índice de graft: el retomado no lo
   reconstruye, y la regla de los llamadores no puede correr con un índice viejo. En esos casos el
   próximo intento planifica de cero. En un replan, el retomado toma las candidatas de
   `candidatas.json` (las que siguen en la rama) y sus SHAs de la rama de ahora.
6. **Limpieza:** cuando el gate pasa se borra `planificar-sesion.json` y se intenta
   `deleteSession(sessionId, { dir: worktree })` del SDK, sin propagar un error.

## Consecuencias

- Un reintento por el gate debería costar menos de US$ 1 y menos de 4 minutos. Se mide con
  `stats --runs` en runs reales.
- **Residuo en modo token:** la conversación vive en la config de Claude de flowrunner
  (`~/.flowrunner/claude/projects/`), y el `deleteSession` del proceso, que no lleva esa config, puede
  no encontrarla. Queda ahí, como la de un run abortado en medio de planificar. Es chica, y es solo de
  planificar.
- Si una versión del SDK cambia la semántica de `resume`, lo atrapa el fallback y queda el aviso en
  el log.
- Retomar después de un `limite` o de un proceso que murió en medio de la sesión queda fuera: esos
  reintentos planifican de cero.

## Tests

- `src/agent/session.test.ts`: con `sessionId` se persiste, con `resume` se retoma, sin ninguno no.
- `src/phases/planificar.test.ts`: el reintento retoma con el motivo como único mensaje, el fallback,
  un pedido de cambios que no retoma, el test sin declarar que se descarta, un proceso que muere en el
  intento nuevo, y `gateRechazado` y `sesionAnterior`.
- `src/phases/replan.test.ts`: un replan rechazado retoma con las candidatas guardadas y los SHAs de
  la rama, no descarta los tests que commitearon las conservadas, y no retoma si el gate rearmó la
  rama o si no se pudo reconstruir el índice.
