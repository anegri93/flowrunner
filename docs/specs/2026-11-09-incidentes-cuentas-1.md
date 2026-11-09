# Incidentes del run CUENTAS-1 (2026-11-09)

Informe para trabajar en flowrunner. Sale del run `CUENTAS-1-20261109-105810` del proyecto
`mango-portal-colaborador`: conectar cada cuenta del portal con su ficha. Lo que se dice acá se
comprobó en los eventos y las sesiones del run (`~/.flowrunner/runs/CUENTAS-1-20261109-105810/`) y en
el código de flowrunner en `main` (con #45 y #46 mergeados).

## Resumen

| # | Problema | Costo en este run | Estado |
|---|---|---|---|
| 0 | El planificador reescribía un test que fijaba una regla vigente y lo anotaba como decisión | Un run cancelado (~US$ 4,4) | **Resuelto** en #45 y #46 |
| 1 | Un comando de test que no termina queda en segundo plano y la sesión de la sub-task no se cierra | ~21 de los 26 min de ST-2 | Abierto |
| 2 | El plan cambia la firma de una función y deja a llamadores fuera de todo alcance | El run va a chocar en verificar (pendiente de ver) | Abierto |
| 3 | Las sub-tasks corren el `verify` completo antes de que las demás se integren | Rojos falsos y minutos de más en cada sub-task | Abierto |
| 4 | `watch` muestra «trabajando» con el reloj congelado mientras la sesión espera procesos | No se ve que el run está trabado | Abierto |

El 1 es el más urgente: le puede pasar a cualquier repo cuyo runner de tests no termine cuando el
arranque falla, y sin intervención manual el run queda parado hasta el timeout de la sesión.

---

## 0. Ya resuelto: cambiar lo existente sin avisar (#45, #46)

Contexto nada más. En el primer run de CUENTAS-1 el planificador escribió en `decisiones`: *«el test
viejo `rechaza un correo de otro dominio` contradice AC-1: se reescribe»*. El aviso fue el genérico y
el plan se aprobó.

- **#45:** campo `cambia_lo_existente`, detección de tests existentes tocados en el gate de planificar
  y en implementar, aviso ⚠, `approve --acepto-cambios` y sección en la PR.
- **#46:** el botón para aceptar cambios en el panel de Orca.

En el run de este informe funcionó: el plan declaró 7 cambios, incluido el contador de
`paginas-cobertura.e2e-spec.ts`, y se aprobaron con `cambios_aceptados: 7`.

---

## 1. Un test que no termina traba la sub-task

### Qué pasó

La sesión `implementar-ST-2-1` (`sesiones/implementar-ST-2-1.jsonl`):

| Hora UTC | Qué |
|---|---|
| 14:19:52 | Arranca ST-2 |
| ~14:21:30 | Corre `pnpm --filter @mango/api test:e2e conexion-en-login` (permitido tal cual, `timeout: 400000`) |
| 14:28:11 | El test falla en 2 s porque Nest no resuelve `AuditoriaService`. Pero **Jest no sale** («Jest did not exit one second after the test run has completed»). A los 400 s el Bash tool corta la espera y deja el proceso **en segundo plano**: `backgroundTaskId: "buiyc1bmm"`, `timedOutAfterMs: 400000` |
| 14:28:12 | Mismo patrón con `test:e2e conexiones-de-cuentas -t AC-3` |
| 14:34:52 | Segundo proceso en segundo plano: `bulfhlz2y` |
| 14:34:55 | Intenta leer `/private/tmp/claude-501/…/tasks/bulfhlz2y.output` con Grep y Read, y el hook los **rechaza** porque quedan fuera del worktree. Hay dos eventos `rechazo` en `events.jsonl` |
| 14:35–14:37 | Arregla el módulo, sus criterios pasan, corre `verify.sh` y termina con `success` |
| 14:37:41 | Último mensaje del modelo. **Pero la sesión no devuelve**: el proceso del SDK sigue vivo mientras viven los dos Jest |
| 14:45:25 | Se matan a mano los PIDs 43078 y 45718. En un segundo, ST-2 queda `commiteada` e `integrada` |

**Costo:** dos esperas de 400 s (~13 min) más 8 min con la sesión terminada pero trabada. Son ~21 de
sus 26 min. Sin intervención, la propia sub-task estimó que los procesos se cortaban recién por el
timeout de 30 min.

### Causa

Hay dos piezas, y la de flowrunner es la segunda:

1. **En el repo:** `apps/api/test/jest-e2e.json` no tiene `forceExit`. Cuando el arranque de Nest
   falla, el `afterAll` que cierra la app y Mongo no corre y Jest queda vivo. Es del repo, pero
   cualquier repo puede tener un runner así.
2. **En flowrunner:** cuando un comando pasa su timeout, el Bash tool de Claude Code lo **manda a
   segundo plano en vez de matarlo**. Después:
   - el agente no puede leer su salida, porque el archivo vive en `/private/tmp/…/tasks/`, fuera del
     worktree, y el hook lo rechaza (`src/tripwires/rules.ts`, `checkReadPath`);
   - la sesión no termina mientras haya procesos en segundo plano;
   - `runSession` (`src/agent/session.ts`) solo corta por `spec.timeoutMs` (60 min en implementar), y
     hasta ahí la sub-task no se commitea.

### Qué hacer

En orden de preferencia; la primera sola ya resuelve el bloqueo.

- **A. Cerrar la sesión cuando llega el `result`.** Cuando el SDK emite el mensaje final, flowrunner
  deja de esperar, aborta la query (`abort.abort()`) y mata el **grupo de procesos** de la sesión,
  incluidos los nietos lanzados por Bash. Hay que ver cómo expone el SDK el PID del CLI. Si no lo
  expone, matar por el worktree de la sub-task (los procesos con cwd adentro) es un plan B feo pero
  determinístico.
- **B. Que un comando que pasa su timeout muera en vez de ir a segundo plano.** Hay que verificar si
  el SDK o el CLI tienen una opción o variable de entorno para desactivar el pase a segundo plano. No
  lo comprobé. Si existe, va en las opciones de `runSession` para implementar, verificar y reparar.
- **C. Avisar en el prompt de implementar** que un comando que no termina no se reintenta en paralelo:
  el agente lanzó el segundo Jest mientras el primero seguía colgado. Ayuda, pero no reemplaza a A.
- **D. Opcional:** sumar un aviso al `informe` cuando una sesión dejó procesos vivos.

**Referencia de diseño:** [composed-di](https://github.com/imherrera/composed-di) (`packages/core`,
`ServiceModule.dispose` e `InitializationAbortedError`). Es como referencia, no como dependencia:
resuelve inyección de dependencias en tiempo de ejecución, no procesos. La regla que aplica es que
**quien crea algo lo cierra, también lo que quedó a medias**. `dispose()` cierra los servicios en
orden inverso al de creación, y uno que estaba inicializándose cuando se pidió cerrar se pasa igual a
su `dispose`, «so nothing leaks». Llevado a flowrunner: la sesión de una sub-task es dueña de todo
proceso que lanza, en primer plano o en segundo, y al terminar la sesión flowrunner los cierra sin
esperar a que terminen solos. Terminar no es «el modelo dijo `success`»: es «el modelo dijo `success`
y no queda nada vivo».

### Criterios para cerrarlo

- Una sub-task cuyo comando permitido no termina, simulada con un script que duerme más que el
  timeout del Bash tool, **se commitea** sin intervención en un tiempo acotado, y no quedan procesos
  hijos vivos al terminar la fase. Test de integración con `simWorld`, que tiene que fallar contra el
  código de hoy.
- El informe del run dice que hubo un proceso que no terminó, con el comando.

---

## 2. Llamadores fuera de todo alcance

### Qué pasó

- **El cambio:** el plan declaró en `cambia_lo_existente` que `asegurarAcceso` pasa a devolver
  `UsuarioDocumento | null` (`apps/api/src/usuarios/usuarios.service.ts:168`). ST-1 lo implementó.
- **Los llamadores que nadie puede tocar:** `seed-accesos.ts` (líneas 46-47) y `seed-nomina.ts`
  (líneas 213 y 216), en `apps/api/src/seeds/`, usan el resultado sin chequear `null`. **Ninguna
  sub-task los tiene en su alcance**, ni siquiera ST-5, la de cierre. Ver
  `runs/CUENTAS-1-20261109-105810/tasks.json`.
- **Quién lo vio:** ST-2 lo reportó al terminar («rompen el typecheck y el build… no están en mi
  alcance»), pero nada en flowrunner reacciona a ese texto.
- **Cómo terminó:** ni siquiera llegó a verificar. ST-5, la sub-task de cierre, corrió el verify: todo
  verde (unitarios y 914 e2e) salvo typecheck y build, con TS18047 `'usuario' is possibly 'null'` en
  los dos seeds. Dos intentos sin cambiar ningún archivo («los cuatro errores están en dos archivos que
  no puedo escribir») y el run quedó `detenido` a los 54 min, con US$ 5,22 gastados.
- **El `siguiente` del motivo está mal:** sugiere `flowrunner rerun <id> --desde implementar`, que
  repite los mismos alcances y vuelve a chocar. La salida real es `--desde planificar`. Cuando la
  sub-task dice que el arreglo está fuera de su alcance, el comando sugerido tiene que ser replanificar.

### Causa

El planificador listó a mano los llamadores de `asegurarAcceso`. Le faltaron los dos seeds, aunque
graft los encuentra (`graft callers asegurarAcceso`). El gate (`checkPlanShape` en
`src/gates/plan.ts`) solo controla forma y solapamiento de alcances, no que el alcance cubra el radio
del cambio.

### Qué hacer

- **A. Gate determinístico con graft (recomendado).** El plan declara qué símbolos cambian de firma o
  de contrato. Se puede pedir explícito, o sacarlo de `cambia_lo_existente` agregándole un campo
  `simbolo`. El gate corre `graft callers <símbolo>` sobre el índice del run (`graftIndex(run)`;
  `blastRadius` en `src/graft/graft.ts` ya usa graft en revisar) y rechaza el plan si un archivo
  llamador no está en el alcance de ninguna sub-task. El planificador lo corrige en la vuelta
  siguiente, como los demás rechazos del gate.
- **B. Cortar el bucle en verificar.** Cuando los errores de verify caen en archivos fuera de todo
  alcance, el run se detiene con un motivo claro en vez de devolver trabajo que nadie puede hacer:
  *«`apps/api/src/seeds/seed-nomina.ts:213` rompe el typecheck y no está en el alcance de ninguna
  sub-task: `flowrunner rerun <id> --desde planificar`»*. Es la red de seguridad de A.
- **C. Prompt de planificar:** al cambiar la firma o el contrato de una función, correr
  `graft_trace_calls` y poner a todos sus llamadores en algún alcance.

**Referencia de diseño:** [composed-di](https://github.com/imherrera/composed-di) (`packages/core`,
`ServiceModule.from`, `checkMissingDependencies`). Es como referencia, no como dependencia: valida un
grafo de servicios, no de código. Toma dos ideas:

- **Se valida que esté completo al componer, no al usar.** `ServiceModule.from()` revisa el grafo
  entero antes de que se pida el primer servicio. El equivalente acá es el gate del plan, antes de
  aprobar. En este run el faltante apareció en la última sub-task, después de ~50 min y US$ 5.
- **El error junta todos los faltantes y muestra el camino.** No se corta en el primero
  (`issues.join('\n\n')`), y cada uno nombra la arista rota: «X depende de Y, y nadie provee Y». El
  rechazo del gate tiene que listar **todos** los llamadores sin alcance, con el camino: «ST-1 cambia
  `asegurarAcceso` → la llaman `seed-nomina.ts:213` y `seed-accesos.ts:46` → ninguno está en el
  alcance de una sub-task». Así el planificador corrige todo en una vuelta.

Su README describe la causa de fondo con un caso igual: si exponés algo cuyo contrato puede cambiar,
«every module that registered it has to be tracked down and updated… and the failure shows up in the
consumer». Es lo que pasó con los seeds: el contrato cambió en ST-1 y la falla apareció en archivos
que nadie tenía asignados.

### Criterios para cerrarlo

- Un plan que cambia la firma de una función con un llamador fuera de todo alcance no pasa el gate, y
  el motivo nombra el archivo del llamador. Test unitario de planificar con un repo de juguete
  indexado por graft.
- Un verify rojo por un archivo fuera de todo alcance detiene el run, en vez de devolver unidades, con
  el motivo y el comando de `rerun`.

---

## 3. Sub-tasks que corren el verify completo antes de tiempo

### Qué pasó

ST-2 corrió `./.flowrunner/verify.sh` dentro de su worktree. Ese worktree se creó a las 14:19, antes
de que ST-3 se integrara a las 14:22. Reportó como rojo «falta
`apps/api/src/seeds/limpiar-cuentas-fuera-de-dominio.ts`», que no era un problema: lo traía ST-3 y ya
estaba integrado en la rama de la feature. En este repo el verify completo levanta Mongo y corre 914
tests e2e, así que cuesta minutos.

Además, el planificador agregó una sub-task «ST-5 Cierre: verify completo en verde» con un alcance
que es la unión de casi todos los demás. Es un síntoma: el verify de conjunto ya es el trabajo de la
fase verificar.

### Qué hacer

- **Implementar:** el prompt pide correr solo los comandos de los criterios de la sub-task (y el lint
  o el typecheck de sus archivos, si hay forma barata), no el verify del repo. El verify completo queda
  para verificar, sobre la rama integrada.
- **Planificar:** no crear sub-tasks de «cierre» o «verify en verde». Lo puede chequear el gate, por
  ejemplo rechazando una sub-task cuyo alcance cubra al de otras dos.

### Criterios para cerrarlo

- El prompt de implementar ya no ofrece el verify del repo como comando permitido de una sub-task, o lo
  limita. Hay un test que fija la lista de comandos permitidos de una unidad (`unitCommands` en
  `src/phases/implementar.ts`).

---

## 4. `watch` no muestra que la sesión está trabada

Entre 14:37 y 14:45, `flowrunner watch` mostró ST-2 como «trabajando», con el reloj de la unidad
congelado en `17m51s` mientras el de la fase seguía corriendo. No había forma de ver que el modelo ya
había terminado y que se esperaba a procesos.

**Qué hacer:** si la sesión ya emitió su `result` y la unidad no se commiteó, `watch` lo muestra como
estado propio, por ejemplo «terminó; esperando procesos». Con el arreglo 1A el estado dura un segundo,
así que es de menor prioridad.

---

## Para el repo del portal, aparte de flowrunner

- `apps/api/test/jest-e2e.json` sin `forceExit` hace que un e2e cuyo arranque falla deje Jest vivo.
  Agregar `"forceExit": true`, o un `afterAll` que cierre aunque el `beforeAll` haya fallado, evita la
  mitad del problema 1 en este repo. Es una decisión del repo: `forceExit` también esconde fugas
  reales, así que conviene preguntarlo antes.

## Estado del run al escribir esto

`CUENTAS-1-20261109-105810`: detenido en implementar por el problema 2, con ST-1 a ST-4 integradas.
La salida es:

```
flowrunner rerun CUENTAS-1-20261109-105810 --desde planificar
```
