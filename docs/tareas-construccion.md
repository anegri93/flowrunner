# Tareas de construcción — flowrunner

Plan de tareas atómicas, secuenciadas y verificables para construir **flowrunner v0**: un runner local y desatendido, en TypeScript sobre el Claude Agent SDK, que lleva una feature escrita en conversación hasta una PR lista para revisar, con un cerebro por repo que aprende de las correcciones. Fuente: [`docs/specs/2026-11-07-flowrunner-v0-design.md`](specs/2026-11-07-flowrunner-v0-design.md).
Cada tarea desbloquea a la siguiente; cada fase cierra con un **gate** que desbloquea la fase posterior. La Fase 0 resuelve los puntos abiertos de la sección 10 de la spec antes de construir encima.

## Cómo usar este documento

- Cada tarea tiene: **Título**, **Descripción**, **Estado**, **Lint**, **Test**, **Canario**, **Criterio de aprobación** y **Revisión ponytail**.
- Una tarea pasa a `Hecho` solo cuando su lint, su test con el **canario** comprobado, su criterio y su revisión ponytail están verdes.
- **Test** = automatizado, corre en `pnpm verify`. **Criterio de aprobación** = condición observable, puede ser manual. Si ambos dicen lo mismo, uno es humo.
- Los tests van sobre **salidas observables**: valor devuelto, estado persistido, efecto real; no sobre "se llamó al mock". Se mockea solo el límite de confianza; nunca la unidad bajo prueba ni la lógica propia.
- **Canario** = se rompió el código a propósito y se confirmó que el test se pone **rojo**. En las tareas pendientes el campo dice la mutación prevista; al cerrar la tarea se reemplaza por lo que pasó.
- Si el borde es conocido antes de escribir el código, **el test va primero**.
- **`Test: N/A` es una salida válida** cuando no hay borde que afirmar: se escribe la razón y la verificación alternativa. Máximo uno por fase.
- Cobertura omitida a propósito dentro de una tarea con test → comentario `test-debt:` en el código nombrando el riesgo. El gate los lista.
- **Revisión ponytail** = `/ponytail-review` sobre el diff: abstracción especulativa, dependencia evitable, stdlib reinventada, flexibilidad muerta. Por tarea sobre su diff; por fase sobre el diff acumulado.
- No se arranca una tarea hasta que su predecesora, la que la **desbloquea**, está en `Hecho`.
- El **gate de fase** aporta lo que ninguna tarea puede: un **test de integración** del ensamblado, un **re-canario** sobre 2-3 tests de la fase al azar y la revisión ponytail acumulada.
- Bug de una fase anterior descubierto después → tarea insertada `TX.Yb` con **Regresión de:**.
- Cada tarea es un commit local en `main`: sin push, sin PRs y sin CI en GitHub hasta el cierre del proyecto, cuando se sube todo de una vez. El `.md` se actualiza en el mismo commit de la tarea. Desde 2026-11-07, a pedido de la persona.

**Estados:** `[ ] Pendiente` · `[~] En progreso` · `[x] Hecho` · `[!] Bloqueado`

**Decisiones de partida:** las 12 decisiones de la spec. Se registran como ADR en `docs/adr/` en T0.1, y cada spike de la Fase 0 agrega o completa el ADR de su punto abierto.

**Verificación (global):** `pnpm verify` = `pnpm lint && pnpm test && pnpm test:integration`, en local. Es lo que antes era la CI; la CI en GitHub se arma al cerrar el proyecto.

**Convención de lint (global):** `pnpm lint` = `eslint .` con `typescript-eslint` en modo `strict-type-checked`, más `prettier --check .`, más `tsc --noEmit` con `strict`, `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`. Sin `any` salvo justificación escrita en el código. Sin warnings nuevos en archivos tocados.

**Convención de test (global):** `pnpm test` = `vitest run --project unit`, sin red y sin gastar suscripción. **Se mockea solo en los límites de confianza:**
- La función `query` del Agent SDK: se inyecta un falso que reproduce streams grabados de sesiones reales, en `test/fixtures/streams/*.jsonl`, grabados en T0.3.
- `gh`: binario falso `test/bin/gh` antepuesto en el `PATH`, que registra sus argumentos en un archivo y devuelve fixtures.
- `security` del Keychain y `osascript`: binarios falsos en `test/bin/`, con la misma idea.
- El reloj: `now()` inyectado.

**Se usa lo real:** git, con repos creados en un tmpdir y un remote bare local; el filesystem; `events.jsonl`; la máquina de estados; los parsers, gates y tripwires.

**Convención de integración (global):** `pnpm test:integration` = `vitest run --project integration`. Por test levanta: repos git reales en tmpdir con remote bare, un `.flowrunner/` de fixture, `test/bin/` antepuesto en el `PATH`, el `query` falso inyectado, y el CLI real corriendo como proceso hijo con `HOME` apuntando a un tmpdir. Corre en `pnpm verify`. **Aparte**, `pnpm smoke` = `vitest run --project smoke`: usa el SDK real con el token de la suscripción, Haiku 5.5 con effort low, sobre el repo de juguete `test/toy-repo`. No corre en `pnpm verify`, gasta suscripción y solo aparece en las tareas y gates que lo piden.

---

# Fase 0 — Fundaciones y puntos abiertos

> Objetivo: repo con toolchain, CI y decisiones escritas; los cinco puntos abiertos de la spec resueltos con evidencia; streams reales grabados como fixtures; config y feature validadas.

### T0.1 · Esqueleto del repo, CI y ADRs
- **Estado:** `[x] Hecho` — PR #1, la única PR: desde T0.2 todo es commit local
- **Descripción:** crear el repo privado `anegri93/flowrunner` en GitHub, configurado solo con merge commit y borrado de rama al mergear. `package.json` con pnpm 10, Node 24, ESM; `tsconfig.json` estricto; eslint, prettier y vitest con los proyectos `unit`, `integration` y `smoke`. Layout `src/<módulo>/` según la sección 1 de la spec; cada módulo nace con la primera tarea que lo usa. CI en GitHub Actions: lint, typecheck, test e integración en cada PR, en macOS y Linux, con `graft` instalado. ADRs 0001-0012 con las decisiones de la spec. README corto.
- **Lint:** `pnpm lint` verde sobre el esqueleto; `actionlint` sobre el workflow.
- **Test:** N/A — no hay comportamiento propio todavía; verificación: un test deliberadamente roto en la primera PR pone la CI en rojo en las dos plataformas y se quita antes del merge.
- **Canario:** N/A — sin test propio. En local: un `expect(1).toBe(2)` hizo que `pnpm test` saliera 1 y un archivo mal formateado hizo que `pnpm lint` saliera 1; ambos restaurados. En CI, PR #1: el commit con `src/ci/canary.test.ts` puso en rojo `check (ubuntu-latest)` y `check (macos-latest)` en el paso `pnpm test`; se quitó de la rama antes del merge.
- **Criterio de aprobación:** `pnpm lint test test:integration` verde en local y en CI; los 12 ADR mergeados; el repo rechaza squash y rebase-merge. `actionlint` sin hallazgos.
- **Revisión ponytail:** revisión a mano contra la escalera de ponytail sobre el diff; 2 cortes aplicados: se quitaron `bin` y `dependencies` vacías de `package.json`, que no tenían uso todavía. Sin hallazgos abiertos.
- **Desbloquea:** T0.2

### T0.2 · Punto abierto 1: el token en los subprocesos de Bash
- **Estado:** `[x] Hecho`
- **Descripción:** comprobar con el SDK real si una sesión iniciada con `CLAUDE_CODE_OAUTH_TOKEN` en su `env` le pasa esa variable a los procesos que lanza su herramienta Bash. Si la pasa, implementar la mitigación en `src/agent/env.ts`: entorno mínimo para el SDK y entorno limpio para los subprocesos, o `apiKeyHelper` si el SDK no permite separarlos. El resultado y la mitigación elegida quedan en el ADR 0013. **Resultado:** la sesión pasa su entorno a Bash; mitigación: el hook reescribe cada comando con `env -u` sobre `SECRET_ENV_VARS`, implementado en `src/agent/env.ts`.
- **Lint:** `pnpm lint`.
- **Test:** smoke `smoke/env-leak.smoke.ts`: una sesión real con un token centinela corre `env` por Bash; afirma que la salida no contiene el nombre ni el valor del token. Comentario: si regresiona, el código que escribe el agente puede leer la credencial de la suscripción.
- **Canario:** el propio smoke trae el caso sin reescritura, que ve el centinela: el test distingue la fuga. Además, en unit, quitar los `-u` de `scrubCommand` puso en rojo `el comando reescrito no ve las variables secretas`; restaurado.
- **Criterio de aprobación:** ADR 0013 con la salida real de las sesiones: sin reescritura Bash ve el entorno de la sesión, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` no limpia variables arbitrarias, y la reescritura con `env -u` sí. Smoke verde: 2 de 2.
- **Revisión ponytail:** a mano contra la escalera; sin hallazgos. Se descartó usar el modo scrub del CLI: no se puede verificar qué limpia sin un token real.
- **Desbloquea:** T0.3

### T0.3 · Puntos abiertos 2 y 3: aislamiento, señal de límite y fixtures reales
- **Estado:** `[x] Hecho`
- **Descripción:** con el SDK real sobre `test/toy-repo`, que trae un `.mcp.json`, un `.claude/settings.json` con un hook y un `CLAUDE.md` propios:
  - Comprobar que con `settingSources: []`, `strictMcpConfig: true` y graft como único MCP, el mensaje de inicio de la sesión no lista el MCP del repo, el hook no corre y el `CLAUDE.md` no aparece en el prompt.
  - Buscar en los tipos del SDK qué mensaje informa la ventana o el límite de la suscripción y documentarlo; si no hay señal previa, documentar la forma del error.
  - Grabar en `test/fixtures/streams/` sesiones reales: lectura y edición, Bash permitido y negado, salida estructurada válida, salida que agota los reintentos de schema y una sesión cortada por timeout.
  Resultado en el ADR 0014.
- **Lint:** `pnpm lint`.
- **Test:** smoke `smoke/isolation.smoke.ts`: afirma sobre el mensaje de inicio grabado que los servidores MCP son exactamente `[graft]`, que el hook del repo no dejó su archivo marcador y que una pregunta sobre una frase que solo está en el `CLAUDE.md` del repo no se responde con esa frase. Comentario: si regresiona, una feature escrita por cualquiera corre con los hooks y conectores del repo o del usuario.
- **Canario:** el smoke trae el caso con las fuentes por defecto: entran `repo-mcp`, el hook escribe su marcador y la respuesta trae `ARANDANO`. Las tres aserciones se ven rojas en ese caso; verde 2 de 2.
- **Criterio de aprobación:** ADR 0014 con la evidencia, incluido que `settingSources: []` solo no alcanza; 5 fixtures en `test/fixtures/streams/`, uno sintético y declarado como tal en su README; smoke verde.
- **Revisión ponytail:** a mano; sin hallazgos. `smoke/helpers.ts` se comparte entre los smoke y el grabador en lugar de duplicarse.
- **Desbloquea:** T0.4

### T0.4 · Punto abierto 4: graft por worktree
- **Estado:** `[x] Hecho`
- **Descripción:** medir `graft build` sobre un repo del tamaño de flowindex y comprobar si el directorio `graft/` construido en el worktree de la feature sirve copiado al worktree de una sub-task. Decidir entre construir por worktree o una vez por run y copiar. Resultado en el ADR 0015: 3,6 s sobre flowindex; el índice va fuera del repo con `--dir` y `DO_NOT_TRACK=1`, porque `graft build` crea `.gitignore`, `.ignore` y una caché de telemetría dentro del repo; uno por run, reconstruido antes de revisar.
- **Lint:** `pnpm lint`.
- **Test:** integración `graft.int.test.ts`: construye el índice de un repo de fixture, levanta `graft mcp` por stdio y llama `graft_repo_map`; afirma que la respuesta nombra un archivo real del fixture. Si la decisión es copiar, un segundo caso afirma que el índice copiado responde igual en el otro worktree. Comentario: si regresiona, planificar y revisar trabajan sin el grafo sin enterarse.
- **Canario:** quitar `--dir` de `buildIndex` puso en rojo `construir el índice no deja ningún archivo en el worktree`; quitar `DO_NOT_TRACK` también. Restaurado; 3 de 3 verdes.
- **Criterio de aprobación:** ADR 0015 con los tiempos medidos y el efecto lateral descubierto; test verde en `pnpm verify`.
- **Revisión ponytail:** a mano; sin hallazgos. El cliente MCP del test es un helper de prueba de 40 líneas sobre stdio; en producción el MCP lo maneja el SDK, así que no se sumó una dependencia.
- **Desbloquea:** T0.5

### T0.5 · Config global, config del repo y formato de feature
- **Estado:** `[x] Hecho`
- **Descripción:** schemas Zod de `~/.flowrunner/config.yaml`, de `.flowrunner/config.yaml` y del frontmatter y las secciones de la feature, según las secciones 1 y 7 de la spec. Defaults aplicados en un solo lugar. `flowrunner feature check <archivo>` imprime la feature resuelta o los errores. El punto abierto 5, la política de la suscripción, se cierra como nota en el README: uso personal, API key antes de compartir.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Campo desconocido en cualquiera de las configs → error que nombra el campo.
  - Modelo o effort que no existe → error con la fase.
  - `max_parallel` menor que 1 → error.
  - Feature sin criterios, o con un criterio sin `AC-n`, o con claves repetidas → error.
  - Config válida → objeto con los defaults aplicados.
  - Varios problemas a la vez → todos en el mismo error.
  Cada test comenta qué se rompe en producción.
- **Canario:** cambiar `strictObject` por `object` en el schema del repo puso en rojo `un campo desconocido es un error que lo nombra`; anular el chequeo de criterios puso en rojo `sin criterios es un error`. Restaurados; 18 de 18 verdes.
- **Criterio de aprobación:** `flowrunner feature check` sale 0 con una feature válida y 1 con el motivo cuando no lo es.
- **Revisión ponytail:** a mano; 1 corte: el parser de la feature usa `yaml` y regex propias en lugar de sumar una librería de Markdown, porque el formato es fijo y chico. El CLI corre TypeScript con Node 24 sin paso de build. Sin hallazgos abiertos.
- **Desbloquea:** Gate F0

### Gate Fase 0
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde en todo el repo.
- **Tests:** `pnpm test` y `pnpm test:integration` verdes con `pnpm verify`; `pnpm smoke` verde en local.
- **Test de integración:** `test/fase0.int.test.ts`: el CLI real, como proceso hijo con un HOME propio, resuelve una feature válida a su proyecto y a la config del repo con defaults; sale 1 con el motivo si el repo no tiene `.flowrunner/config.yaml` y si el proyecto no está registrado.
- **Canario:** re-canario sobre tres tests al azar: `max_parallel: z.int().min(0)` puso en rojo `max_parallel menor que 1 es un error`; anular el chequeo de claves repetidas puso en rojo `un criterio sin AC-n o una clave repetida`; saltear el proyecto no registrado puso en rojo el caso de integración `un proyecto que no está registrado sale 1`. Una primera mutación de este último era débil, seguía verde, y se reemplazó. Restaurados.
- **Criterio de aprobación:** los ADR 0013-0015 responden los puntos abiertos 1-4 con evidencia real; el 5 queda como nota en el README. La spec se ajustó al ADR 0015 en preparar y en el aislamiento.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado: 4 cortes aplicados, `GRAFT_TELEMETRY` sin efecto, alias de modelos sin uso, alias de sección sin tilde y `repoWithRemote` sin uso. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 1

---

# Fase 1 — Núcleo: eventos, máquina de estados y proceso por run

> Objetivo: un run con fases falsas recorre todos los estados, se detiene, se retoma y llega al final con el mismo log que sin cortes.

### T1.1 · Store del run: `events.jsonl` y lock por repo
- **Estado:** `[x] Hecho`
- **Descripción:** `src/store/`: crear el directorio del run, append de eventos con fsync por evento, lectura del log. Una línea corrupta al final se descarta y se informa; una corrupta en el medio es un error. Lock por repo en `~/.flowrunner/locks/<proyecto>.lock` con el id del run y el pid, según la sección 5 de la spec: un run en espera conserva el lock sin proceso vivo, y el lock se toma solo si su run terminó o si no espera y su proceso ya no existe. Eventos validados con un schema Zod discriminado por `tipo`.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Append y relectura devuelven los mismos eventos en orden.
  - Una última línea truncada → se descarta y la lectura informa el descarte.
  - Una línea corrupta en el medio → error que nombra la línea.
  - Un evento con `tipo` desconocido → error.
  - Dos runs que toman el lock → el segundo falla nombrando el run del primero.
  - Un lock con un pid muerto y su run en curso → se toma.
  - Un lock con un pid muerto y su run en `esperando_aprobacion` → no se toma.
  Comentario: si regresiona, un segundo run sobre el mismo repo arranca mientras el primero espera tu aprobación.
- **Canario:** tratar toda línea corrupta como la última puso en rojo `una línea corrupta en el medio es un error que nombra la línea`; quitar la regla del run en espera puso en rojo `un lock con un pid muerto y su run esperando aprobación no se toma`. Restaurados; 28 de 28 verdes.
- **Criterio de aprobación:** una última línea truncada se descarta y los eventos completos se conservan; el corte real con `kill -9` lo cubre el gate de la Fase 1. El lock se crea con `wx` para que dos runs simultáneos no lo tomen los dos.
- **Revisión ponytail:** a mano; sin hallazgos. Sin `seq` en los eventos: el orden de las líneas ya es el orden, y dos escritores, el run y un `abort`, no pueden romperlo.
- **Desbloquea:** T1.2

### T1.2 · Máquina de estados pura
- **Estado:** `[x] Hecho`
- **Descripción:** `src/engine/`: `reduce(estado, evento)` y `siguiente(estado) → acción`, sin IO. Los 13 estados de la spec, intentos por fase y por sub-task, vueltas de verificar y revisar con sus topes, el mismo fallo dos veces seguidas detiene, los tres tipos de falla, `changes` que vuelve a planificar sin gastar intentos, y el tope `budget.run_usd` sumando los eventos de uso.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Una falla de entorno detiene sin reintentar.
  - Una falla de gate reintenta hasta el tope y después detiene.
  - El mismo motivo dos veces seguidas detiene antes del tope.
  - La tercera vuelta de revisar detiene.
  - `changes` no incrementa los intentos de planificar.
  - El uso acumulado que pasa `run_usd` detiene con el motivo.
  - **Propiedad:** para cada prefijo de los logs de runs completos de fixture, retomar desde el prefijo y seguir con las mismas respuestas produce el mismo estado final que sin cortes.
- **Canario:** `>=` en lugar de `>` en el tope de vueltas puso en rojo `la tercera vuelta de revisar detiene`; sumar intentos en `cambios_pedidos` puso en rojo su test. La propiedad de reanudación primero no detectó un defecto real, que la acción de un run interrumpido fuera preparar, porque solo comparaba el estado final; se endureció para comparar el log completo y ahí se puso roja en los dos guiones. Restaurados; 14 de 14 verdes.
- **Criterio de aprobación:** la tabla de transiciones de `src/engine/engine.ts` sigue la sección 3 de la spec: entorno e invariante detienen, gate reintenta hasta `MAX_ATTEMPTS` y el mismo motivo dos veces detiene, infra reintenta dos veces, verificar y revisar devuelven a implementar hasta 2 vueltas, aprobar espera sin proceso y `cambios_pedidos` no gasta intentos. Un run detenido por presupuesto a mitad de una fase no revive cuando la fase termina.
- **Revisión ponytail:** a mano; sin hallazgos. Sin tabla de transiciones genérica: un `switch` sobre el resultado se lee de una vez.
- **Desbloquea:** T1.3

### T1.3 · El loop del run: acciones idempotentes
- **Estado:** `[x] Hecho`
- **Descripción:** `src/runner/`: lee el log, pide `siguiente`, ejecuta la acción con el módulo de fase que le toca, registra `accion_iniciada` y `accion_terminada`. Al retomar, una acción iniciada y no terminada se rehace; las fases reciben el sha registrado al iniciar para volver su worktree. Las fases se inyectan por registro.
- **Lint:** `pnpm lint`.
- **Test:** con fases falsas que escriben un archivo por ejecución:
  - Un run completo deja exactamente una ejecución por acción.
  - Un corte entre `accion_iniciada` y `accion_terminada` rehace esa acción y solo esa.
  - Un corte después de `accion_terminada` no la repite.
  - Una fase que lanza una excepción no tipada queda como falla de infraestructura, no como gate.
- **Canario:** volver a emitir `accion_iniciada` para una acción interrumpida puso en rojo `un corte entre iniciada y terminada rehace esa acción y solo esa`; clasificar la excepción como gate puso en rojo `una excepción de la fase queda como falla de infraestructura`. Restaurados; 5 de 5 verdes.
- **Criterio de aprobación:** el log de un run falso muestra cada acción con su par de eventos: 7 iniciadas y 7 terminadas en un run completo hasta `entregado`. Las fases reciben el log completo, así implementar puede ver qué sub-tasks ya integró.
- **Revisión ponytail:** a mano; sin hallazgos. El backoff de infraestructura es una función de una línea, no una política configurable.
- **Desbloquea:** T1.4

### T1.3b · Regresión: la fase recibía el log sin su propia accion_iniciada
- **Estado:** `[x] Hecho`
- **Regresión de:** T1.3 — el gate de la Fase 5 mostró que, al volver de verificar, implementar no hacía nada: leía el log de antes de su `accion_iniciada`, encontraba la entrada anterior y daba por integrada la sub-task que tenía que rehacer.
- **Descripción:** el runner pasa a la fase el log con la `accion_iniciada` que acaba de emitir.
- **Lint:** `pnpm lint`.
- **Test:** `la fase recibe el log con su propia accion_iniciada al final`, en `src/runner/runner.test.ts`.
- **Canario:** gratis: el test se escribió contra el código con el bug y salió rojo; con el arreglo, verde.
- **Criterio de aprobación:** `test/fase5.int.test.ts` hace una sola vuelta de verificar y rehace ST-2 en la primera devolución.
- **Revisión ponytail:** a mano; sin hallazgos.
- **Desbloquea:** T1.4

### T1.4 · CLI: run, status, resume, rerun, abort
- **Estado:** `[x] Hecho`
- **Descripción:** `flowrunner run <archivo>` valida la feature, copia `feature.md` al run, lanza el proceso del run separado de la terminal y devuelve el id. `status` lista runs o uno fase por fase. `resume` relanza un run detenido o interrumpido. `rerun <run> --desde <fase>` lo rehace desde una fase. `abort` lo cancela, borra sus worktrees y deja las ramas. Salidas legibles; errores con el comando siguiente. Cada comando acepta `--json` con una salida validada por un schema Zod exportado, que es lo que lee la skill de consola; esta convención rige para todos los comandos que se agreguen después.
- **Lint:** `pnpm lint`.
- **Test:** sobre el CLI real como proceso hijo:
  - `run` sobre una feature inválida sale 1 sin crear el directorio del run.
  - `run` devuelve un id y el proceso sigue vivo después de que el CLI terminó.
  - Editar el archivo original después de `run` no cambia `runs/<id>/feature.md`.
  - `resume` sobre un run terminado sale 1 con el motivo.
  - `rerun --desde` con una fase que no existe sale 1 y lista las fases válidas.
  - `status --json` valida contra su schema, y un error con `--json` también sale como JSON.
  - `abort` sobre un run en curso termina su proceso y lo deja `abortado`.
- **Canario:** guardar la feature del run como link al original puso en rojo `editar el archivo original después de run no cambia la copia del run`. Sacar el `kill` del abort primero no puso el test en rojo, porque el run igual se detiene solo al releer el log cuando termina la fase; el test se endureció para exigir que el proceso muera en menos de 1,5 s con una fase de 3 s, y ahí se puso rojo. Restaurados; 8 de 8 verdes.
- **Criterio de aprobación:** `flowrunner run` vuelve al prompt al instante con el id, el proceso del run sigue vivo, toma el lock con su propio pid y `flowrunner status` muestra el avance fase por fase. Un segundo run sobre el mismo repo se niega y nombra el que tiene el lock.
- **Revisión ponytail:** a mano; sin hallazgos. La única costura de test es `FLOWRUNNER_TEST_HOOKS`, documentada en `src/runner/production.ts`; sin framework de inyección.
- **Desbloquea:** Gate F1

### Gate Fase 1
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase1.int.test.ts`: un run lanzado por CLI con fases falsas de 1,5 s se mata con `kill -9` durante planificar, implementar y revisar, se retoma con `resume` cada vez y llega a `entregado`. Su log, sin los `reanudado`, las acciones cortadas, los tiempos y las rutas, es igual al de un run sin cortes; las tres fases cortadas corrieron dos veces y el resto una.
- **Canario:** re-canario sobre tres tests: anular la regla del mismo motivo dos veces puso en rojo su test del engine; volver a emitir `accion_iniciada` en una acción interrumpida puso en rojo el test del runner. El tercero, sacar el estado de espera de `holderStatus`, siguió verde: no había test de `holderStatus`. Se agregó `src/store/runs.test.ts` y con ese test la mutación se puso roja. Restaurados.
- **Criterio de aprobación:** demo hecha por el test de integración con el CLI real: lanzar, matar, retomar y ver el estado final; `flowrunner status <run>` muestra cada paso con su resultado.
- **Revisión ponytail:** sobre el diff acumulado de la fase: 2 cortes aplicados, el tipo `EventType` sin uso y el modo `--tick` del proceso del run, que nadie usaba todavía y vuelve con T7.1. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 2

---

# Fase 2 — Git, cerebro y preparar

> Objetivo: preparar deja un worktree listo con la base en verde, el índice de graft y el cerebro cargado, o se detiene sin gastar tokens.

### T2.1 · Módulo git
- **Estado:** `[x] Hecho`
- **Descripción:** `src/git/`: worktree desde `origin/<base>` en una rama nueva, commit con trailer, cherry-pick con detección de conflicto que deja el worktree limpio, reset a un sha, push con `--force-with-lease` que se niega fuera de las ramas `feat/` y `chore/lecciones-` de flowrunner, y diff contra la base con archivos y contenido.
- **Lint:** `pnpm lint`.
- **Test:** con git real y remote bare:
  - El worktree nace en el sha de `origin/<base>` aunque la base local esté atrasada.
  - Un cherry-pick con conflicto devuelve el conflicto y deja el worktree sin cambios.
  - Push a `main` o a una rama ajena → error sin tocar el remote.
  - Push con el remote movido por otro → error de lease.
- **Canario:** anular la lista de ramas empujables puso en rojo `push a main o a una rama ajena falla`; `--force` en lugar de `--force-with-lease` puso en rojo `push con el remote movido por otro falla por lease`; no abortar el cherry-pick puso en rojo `un cherry-pick con conflicto … deja el worktree sin cambios`. Restaurados; 6 de 6 verdes.
- **Criterio de aprobación:** las operaciones corren sobre repos reales con remote bare sin tocar el checkout principal: el worktree vive en su propia carpeta. `changesSince` incluye archivos sin seguimiento, que el doble control necesita.
- **Revisión ponytail:** a mano; sin hallazgos. `runProc` es el único lanzador de procesos y siempre limpia los secretos del entorno.
- **Desbloquea:** T2.2

### T2.2 · Cerebro: carga, topes y plantillas
- **Estado:** `[x] Hecho`
- **Descripción:** `src/brain/`: carga `.flowrunner/` desde un worktree según la sección 8 de la spec, con los topes por archivo, rechazo de links, lista de `ejemplos/` y sha256 por archivo. `flowrunner project add <ruta>` registra el repo y dice qué le falta. `flowrunner brain init <ruta>` escribe las plantillas sin commitear y sin pisar archivos existentes.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Un archivo en su tope exacto se carga; uno con un carácter más detiene con archivo, tamaño y tope.
  - Un `convenciones.md` que es un link → error.
  - Un repo sin `.flowrunner/` → error que sugiere `brain init`.
  - `brain init` sobre un repo con `lecciones.md` existente no lo pisa.
  - El sha256 registrado cambia si cambia un byte.
- **Canario:** `>=` en lugar de `>` en el tope puso en rojo `un archivo en su tope exacto se carga`; copiar las plantillas sin chequear si existen puso en rojo `no pisa archivos existentes`. Restaurados; 5 de 5 verdes, más 2 de integración en `test/project.int.test.ts`.
- **Criterio de aprobación:** `brain init` sobre un repo deja plantillas que `project add` da por listas: `faltan` vacío. Sin config global, `project add` exige `--github-user`, que aprender necesita para filtrar correcciones.
- **Revisión ponytail:** a mano; sin hallazgos. Las plantillas son archivos en `templates/brain/`, no strings en el código.
- **Desbloquea:** T2.3

### T2.3 · Fase preparar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/preparar.ts`: lock del repo, fetch, worktree de la feature, `setup`, `verify` sobre la base y `graft build` según el ADR 0015. Clasifica las fallas: base roja, exit 126 o 127, setup que falla y config inválida son fallas de entorno.
- **Lint:** `pnpm lint`.
- **Test:** con repos de fixture:
  - Base con `verify` en verde → evento de preparado con el sha de la base.
  - Base roja → falla de entorno con la salida de `verify`, sin reintento.
  - Un `setup` que no existe → falla de entorno con exit 127, no de gate.
  - Un segundo `flowrunner run` sobre el mismo repo mientras el primero tiene el lock → se niega y nombra el run que lo tiene.
- **Canario:** clasificar el setup que falla como gate puso en rojo `un setup que no existe es una falla de entorno con exit 127`; dejar pasar un verify rojo puso en rojo `base roja: falla de entorno`. Restaurados; 5 de 5 verdes.
- **Criterio de aprobación:** preparar deja el worktree en `feat/SHOP-214-exportar-pedidos-a-csv`, en el sha de `origin/main` y limpio aun después de construir graft; una base roja, un setup inexistente o un verify no ejecutable detienen como falla de entorno. El caso del run completo con costo cero lo prueba el gate de la Fase 2.
- **Revisión ponytail:** a mano; sin hallazgos. `runVerify` vive aparte porque lo comparten preparar y verificar.
- **Desbloquea:** Gate F2

### Gate Fase 2
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase2.int.test.ts`: un run por CLI con preparar real y el resto falso. Con la base verde llega a `entregado`, deja el índice de graft en el run y el worktree limpio; con la base roja termina `detenido` en preparar con la salida de verify, sin ningún evento de uso, y `status` dice cómo seguir.
- **Canario:** re-canario sobre tres tests: anular las ramas empujables puso en rojo el push a main; dejar pasar links en el cerebro puso en rojo su test; chequear lectura en lugar de ejecución en verify puso en rojo `un verify que no es ejecutable`. Restaurados.
- **Criterio de aprobación:** demo hecha por el test de integración con el CLI real en los dos casos, base verde y base roja.
- **Revisión ponytail:** sobre el diff acumulado: 4 cortes aplicados, `artifact`, `unitWorktree` y `resetHard` sin uso todavía, que vuelven con la Fase 5, y la opción `input` de `runProc`. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 3

---

# Fase 3 — Agente y tripwires

> Objetivo: una sesión del SDK corre aislada, con su salida validada, su costo registrado y los tripwires rechazando en el acto lo que sale del alcance.

### T3.1 · Capa de agente
- **Estado:** `[x] Hecho`
- **Descripción:** `src/agent/`: arma las opciones de cada sesión según la fase: aislamiento de la sección 4 de la spec, el entorno del ADR 0013, modelo y effort, `outputFormat` desde un schema Zod, `maxBudgetUsd`, timeout con `abortController` y graft como MCP. Copia el stream a `runs/<id>/sesiones/`, emite eventos de uso con costo y tokens por modelo, y clasifica el resultado: éxito, infraestructura, límite, presupuesto o schema agotado. Recibe `query` por parámetro.
- **Lint:** `pnpm lint`.
- **Test:** con los streams grabados en T0.3:
  - Éxito con salida estructurada → devuelve el objeto validado y un evento de uso.
  - `error_max_structured_output_retries` → falla de gate con el motivo.
  - Timeout → falla de infraestructura y el stream parcial queda copiado.
  - Error de límite → evento de pausa.
  - Las opciones construidas para cada fase tienen `settingSources` vacío y un único MCP.
- **Canario:** clasificar el timeout como gate puso en rojo `el timeout es falla de infraestructura`; quitar `settingSources: []` puso en rojo `las opciones llevan settingSources vacío`. Restaurados; 9 de 9 verdes en `src/agent/session.test.ts`.
- **Criterio de aprobación:** cada sesión copia su stream a `runs/<id>/sesiones/<nombre>.jsonl` y emite un evento `uso` con costo, tokens por modelo y duración. Sin token en el Keychain, la sesión falla como entorno con el comando para generarlo y nunca llega a llamar al SDK. La lectura del stream como texto con `flowrunner report --sesion` llega con T6.3.
- **Revisión ponytail:** a mano; sin hallazgos. `runSession` es el único lugar que arma opciones del SDK; las fases solo describen su sesión.
- **Desbloquea:** T3.2

### T3.2 · Reglas de tripwires
- **Estado:** `[x] Hecho`
- **Descripción:** `src/tripwires/rules.ts`, funciones puras: rutas resueltas sin seguir links, dentro del worktree y del alcance; rutas prohibidas; lockfiles y manifiestos solo con dependencias declaradas; contenido sin `skip`, `only` ni `todo` agregados en tests y sin secretos; Bash por coincidencia exacta con rechazo de composición. Cada rechazo con un motivo legible.
- **Lint:** `pnpm lint`.
- **Test:** tabla de casos por regla:
  - `../` y un link que apunta fuera del worktree → rechazo.
  - Archivo dentro del worktree pero fuera del alcance → rechazo con la sub-task.
  - `CLAUDE.md`, `.flowrunner/lecciones.md` y un test bloqueado → rechazo.
  - `pnpm-lock.yaml` sin dependencias declaradas → rechazo; con dependencias → permitido.
  - `it.only(` agregado → rechazo; un `only` en un string de otra línea → permitido.
  - Una clave privada en el contenido → rechazo.
  - El comando exacto del ac-map → permitido; el mismo con `&& curl …` → rechazo.
- **Canario:** resolver rutas sin realpath puso en rojo `una carpeta que es un link hacia afuera`; no reconocer archivos de test puso en rojo `it.only( agregado en un test`. Restaurados; 13 de 13 verdes.
- **Criterio de aprobación:** cada regla de la sección 4 de la spec tiene al menos un caso permitido y uno rechazado en `src/tripwires/rules.test.ts`: alcance, `..`, links, protegidos, bloqueados, harness, lockfiles con y sin dependencias, globs de planificar, lectura fuera del worktree, tests desactivados, secretos y Bash exacto o compuesto.
- **Revisión ponytail:** a mano; sin hallazgos. Los globs usan `path.matchesGlob` de Node, sin dependencia.
- **Desbloquea:** T3.3

### T3.3 · Hook `PreToolUse` y deny por defecto
- **Estado:** `[x] Hecho`
- **Descripción:** `src/tripwires/hook.ts`: el hook que aplica las reglas por fase y devuelve allow o deny con su motivo, y un `canUseTool` que rechaza todo lo que llega sin decidir. Cada rechazo emite un evento `rechazo`.
- **Lint:** `pnpm lint`.
- **Test:** llamando al hook con entradas de la forma del SDK:
  - Write fuera del alcance → deny con el motivo y evento `rechazo`.
  - Una herramienta que ninguna regla menciona → deny.
  - WebFetch en implementar → deny.
  - Read dentro del worktree → allow.
  Smoke `smoke/tripwire.smoke.ts`: una sesión real a la que se le pide escribir fuera del alcance termina sin el archivo y con el motivo en el stream.
- **Canario:** permitir por defecto las herramientas desconocidas puso en rojo `una herramienta que ninguna regla menciona: deny`; dejar de reescribir Bash puso en rojo `Bash permitido se reescribe para correr sin los secretos`. Restaurados; 6 de 6 verdes.
- **Criterio de aprobación:** `smoke/tripwire.smoke.ts` verde con el SDK real: una sesión de Haiku a la que se le pide escribir `src/billing/tarifas.js` fuera de su alcance termina sin el archivo, con el evento `rechazo` y el motivo visible en su transcript.
- **Revisión ponytail:** a mano; sin hallazgos. `decide` separa la decisión del efecto para testearla sin el SDK.
- **Desbloquea:** T3.4

### T3.4 · Doble control sobre el diff
- **Estado:** `[x] Hecho`
- **Descripción:** `src/tripwires/diff.ts`: aplica las mismas reglas de ruta y contenido al diff real de un worktree contra su punto de partida, incluidos los archivos sin seguimiento.
- **Lint:** `pnpm lint`.
- **Test:** con git real:
  - Un archivo fuera del alcance creado por un comando, no por Edit → rechazo.
  - Un test bloqueado modificado → rechazo.
  - Un diff dentro del alcance → aprobado.
  - Un archivo sin seguimiento fuera del alcance → rechazo.
- **Canario:** sacar los archivos sin seguimiento de `changesSince` puso en rojo `un archivo sin seguimiento fuera del alcance: violación`. Restaurado; 5 de 5 verdes.
- **Criterio de aprobación:** el diff de una sub-task que crea un archivo por fuera de Edit, en `src/billing/`, se rechaza con el archivo y la regla; también un test bloqueado modificado y un secreto agregado dentro del alcance.
- **Revisión ponytail:** a mano; sin hallazgos. El doble control reusa las reglas del hook; no tiene reglas propias.
- **Desbloquea:** Gate F3

### T3.1b · Regresión: una credencial rechazada se reintentaba como infraestructura
- **Estado:** `[x] Hecho`
- **Regresión de:** T3.1 — el smoke real de la Fase 4 mostró que una sesión sin credencial válida termina con `authentication_failed` y "Not logged in", y `runSession` la clasificaba como infraestructura: tres reintentos inútiles.
- **Descripción:** `runSession` detecta `authentication_failed` y devuelve falla de entorno con el motivo. Se suma `FLOWRUNNER_HOME` para que un run use un home de flowrunner propio sin perder el HOME real, donde vive la sesión de Claude Code.
- **Lint:** `pnpm lint`.
- **Test:** `una sesión sin credencial válida es falla de entorno, no de infraestructura`, sobre `test/fixtures/streams/sin-sesion.jsonl`, el stream real del fallo.
- **Canario:** el test se escribió después del arreglo; anular la detección de `authentication_failed` lo puso en rojo. Restaurado.
- **Criterio de aprobación:** el mismo smoke ahora se detiene en el primer intento con un motivo de entorno, y con la credencial correcta pasa.
- **Revisión ponytail:** a mano; sin hallazgos.
- **Desbloquea:** Gate F3

### Gate Fase 3
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes; `pnpm smoke` verde en local.
- **Test de integración:** `test/fase3.int.test.ts`: `runSession` con un SDK simulado que pasa cada herramienta por el hook real, como el SDK, sobre un worktree real. El Edit a `src/billing/tarifas.ts` fuera del alcance de ST-2 se rechaza, el diff del worktree queda vacío, el doble control no encuentra nada y el log del run registra el `rechazo` y el `uso` con su costo. `test/helpers/sim-sdk.ts` queda para los tests de las fases de agente.
- **Canario:** re-canario sobre tres piezas del ensamblado, todas en el test de integración: un hook que permite todo, sacar la regla de alcance y no emitir el evento de uso pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** `pnpm smoke` verde con el SDK real, incluido `smoke/tripwire.smoke.ts`.
- **Revisión ponytail:** sobre el diff acumulado: 1 corte, `describeViolations` sin uso. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 4

---

# Fase 4 — Planificar y aprobar

> Objetivo: un run llega a `esperando_aprobacion` con un plan que pasó su gate, avisa y espera sin procesos vivos; `approve` y `changes` lo destraban.

### T4.1 · Schemas del plan y gate de planificar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/gates/plan.ts`: schemas de `tasks.json`, `ac-map.json` y `decisiones`, y el gate de la sección 3 de la spec: cada criterio con comando y sub-task, cada comando falla y no es no ejecutable, rutas dentro del repo aunque su carpeta no exista, alcances disjuntos entre sub-tasks sin camino de dependencia, lockfiles y manifiestos sumados con dependencias, y sin ciclos.
- **Lint:** `pnpm lint`.
- **Test:** fixtures, incluidos los casos reales de SELECTIA:
  - Comando que sale 127 → rechazado como no ejecutable.
  - Comando que pasa antes de implementar → rechazado.
  - Ruta nueva `db/migrations/2026…/migration.sql` en carpeta inexistente → válida.
  - Ruta que escapa del repo → rechazada.
  - Dos sub-tasks paralelas, una con `src/a/` y otra con `src/a/b.ts` → rechazadas por pisarse.
  - Las mismas, con dependencia entre ellas → válidas.
  - Dos sub-tasks paralelas que declaran dependencias → rechazadas por el lockfile.
  - Un ciclo A→B→A → rechazado.
- **Canario:** comparar rutas solo por igualdad, sin prefijo, puso en rojo `dos sub-tasks paralelas con src/a/ y src/a/b.ts`; no reconocer los comandos no ejecutables puso en rojo `un comando que sale 127`. Restaurados; 10 de 10 verdes.
- **Criterio de aprobación:** cada rechazo nombra la sub-task, el criterio o la ruta en un texto que sirve como motivo de reintento, por ejemplo `ST-1 y ST-2 pueden correr a la vez y sus alcances se pisan (src/a y src/a/b.ts): hacé que una dependa de la otra o separá los archivos`. Las dependencias transitivas habilitan alcances superpuestos; un glob en el alcance se rechaza porque el alcance son rutas concretas.
- **Revisión ponytail:** a mano; sin hallazgos. El gate está partido en la forma, que es pura, y los comandos, que corren procesos, para testear la primera sin disco.
- **Desbloquea:** T4.2

### T4.2 · Fase planificar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/planificar.ts` y `prompts/planificar.md`: sesión de Opus 5.5 con la feature, el cerebro, graft y el subagente explorador de Haiku 5.5; escritura limitada a `tests_globs` y sin Bash. Si el gate pasa: commit de los tests y `locked.json`. Si falla: reintento con el motivo. Una instrucción de `changes` entra en el prompt.
- **Lint:** `pnpm lint`.
- **Test:** con `query` falsa que devuelve planes grabados y escribe tests en el worktree:
  - Plan válido → commit con los tests y `locked.json` con un hash por archivo.
  - Plan rechazado → reintento cuyo prompt contiene el motivo del gate.
  - Con una instrucción de `changes` → el prompt la contiene.
  - Un test escrito fuera de `tests_globs` → rechazado por el tripwire.
- **Canario:** commitear antes de pasar el gate puso en rojo `un plan cuyo criterio ya pasa se rechaza … y no commitea nada`; no volver el worktree a la base puso en rojo `un reintento arranca de la base`. Restaurados; 5 de 5 verdes.
- **Criterio de aprobación:** con un SDK simulado que escribe por el hook real, un plan válido deja el commit de tests, `plan.md`, `tasks.json`, `ac-map.json` y `locked.json`; uno rechazado vuelve con el motivo del gate y sin commit. El plan real con el SDK lo prueba el smoke del gate de la Fase 4.
- **Revisión ponytail:** a mano; sin hallazgos. Las plantillas de prompt viven en `prompts/` con un render de marcas `{{x}}` que falla si falta una variable.
- **Desbloquea:** T4.3

### T4.3 · Aprobar: espera sin proceso, approve, changes
- **Estado:** `[x] Hecho`
- **Descripción:** `src/notify/` con `osascript` y la fase aprobar: registra la espera, avisa con un texto que dice qué pedirle a Claude, como *"SHOP-214: el plan espera tu aprobación. Pedile a Claude que te lo muestre."*, y termina el proceso. `flowrunner plan <run>` muestra plan, sub-tasks con alcance y diff de los tests. `approve` relanza hacia implementar; `changes <run> "<motivo>"` relanza hacia planificar con la instrucción.
- **Lint:** `pnpm lint`.
- **Test:** sobre el CLI real:
  - Al llegar a la espera, el proceso del run termina y el `osascript` falso registró el aviso con la clave.
  - `approve` sobre un run que no espera → sale 1 con el estado actual.
  - `changes` sin motivo → sale 1.
  - `changes` con motivo → planificar corre otra vez con el motivo y los intentos no suben.
- **Canario:** que aprobar devuelva `ok` en lugar de `espera` puso en rojo `al llegar a la espera el proceso termina`; dejar aprobar un run que no espera puso en rojo `approve sobre un run que no espera sale 1`. Restaurados; 4 de 4 verdes en `test/approval.int.test.ts`.
- **Criterio de aprobación:** con el CLI real y el SDK simulado, el run llega a la espera, su proceso termina, el lock queda con el run y el `osascript` falso registra el aviso con lo que hay que pedirle a Claude. `flowrunner plan` muestra sub-tasks, criterios y el diff de los tests; `changes` vuelve a planificar con el motivo en el prompt y los intentos en cero.
- **Revisión ponytail:** a mano; sin hallazgos. Los guiones del SDK simulado se reparten entre procesos con un contador en archivo, solo en los tests.
- **Desbloquea:** Gate F4

### Gate Fase 4
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase4.int.test.ts`: con el CLI real, preparar, planificar y aprobar reales y el SDK simulado, el run llega a la espera sin proceso vivo, `changes` lo devuelve a planificar con el motivo en el prompt, el segundo plan pasa, `flowrunner plan` muestra el plan corregido y `approve` lo lleva a `entregado` con las fases siguientes.
- **Canario:** re-canario sobre tres piezas, todas en el test de integración: que `cambios_pedidos` vaya a implementar, que planificar no reescriba los artefactos de un segundo plan y que aprobar no espere pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** `smoke/plan.smoke.ts` verde con el SDK real sobre el repo de juguete: Haiku escribió el test de AC-1, el plan pasó el gate, quedaron seis decisiones en el log y el run espera la aprobación; costo USD 0,006. En el camino apareció la regresión T3.1b.
- **Revisión ponytail:** sobre el diff acumulado: sin exports sin uso; las constantes del plan de los tests se movieron a `test/helpers/plan-fixtures.ts` para no importar de un archivo de test. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 5

---

# Fase 5 — Implementar en paralelo y verificar

> Objetivo: las sub-tasks corren en paralelo en sus worktrees, se integran por cherry-pick y la rama de la feature pasa sus criterios y sus tests bloqueados intactos.

### T5.1 · Programador de sub-tasks
- **Estado:** `[x] Hecho`
- **Descripción:** `src/engine/scheduler.ts`, puro: dado el grafo de dependencias, las sub-tasks integradas, las en curso y `max_parallel`, devuelve cuáles arrancar.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Tres independientes con `max_parallel` 2 → arranca dos.
  - Una que depende de otra no integrada → no arranca aunque haya lugar.
  - Al integrarse la dependencia → arranca.
  - Una sub-task fallida definitivamente → sus dependientes nunca arrancan y el run se detiene.
- **Canario:** tomar como lista una dependencia que está corriendo, todavía no integrada, puso en rojo `un diamante arranca en el orden esperado`; ignorar las que ya corren al contar lugares puso en rojo `con una corriendo y max_parallel 2 arranca una más`. Restaurados; 7 de 7 verdes.
- **Criterio de aprobación:** el diamante ST-1 → ST-2 y ST-3 → ST-4 arranca en ese orden: primero ST-1, después ST-2 y ST-3 juntas, ST-4 al final. Una dependencia que no es parte de la ronda, porque se integró antes, cuenta como lista.
- **Revisión ponytail:** a mano; sin hallazgos.
- **Desbloquea:** T5.2

### T5.2 · Fase implementar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/implementar.ts` y `prompts/implementar.md`: por sub-task, worktree en `feat/<clave>/<id>` desde la punta de la feature, `setup`, sesión de Sonnet 5.5 con los tripwires, doble control, un commit con trailer y cherry-pick sobre la feature. Un conflicto rehace la sub-task sobre la punta nueva y cuenta como intento. Las sesiones corren en paralelo según el programador.
- **Lint:** `pnpm lint`.
- **Test:** integración con `query` falsa que edita archivos en el worktree:
  - Dos sub-tasks independientes corren a la vez y quedan dos commits en la feature, uno por sub-task, con su trailer.
  - Una sub-task que choca al integrarse se rehace una vez y después integra.
  - Una sub-task que viola el doble control no se commitea y reintenta con el motivo.
  - Un fallo de una sub-task no corta la otra que está en curso.
- **Canario:** integrar con `git merge --no-ff` en lugar de cherry-pick puso en rojo `dos sub-tasks independientes corren a la vez y dejan un commit cada una`, por el historial con merges; saltear el doble control puso en rojo `una sub-task que viola el doble control no se commitea`. Restaurados; 5 de 5 verdes.
- **Criterio de aprobación:** el historial de la rama de la feature queda lineal: los tests del plan y un commit por sub-task con su trailer `Flowrunner-Subtask`. Dos sub-tasks independientes corrieron a la vez, con dos sesiones simultáneas medidas en el SDK simulado; un conflicto de integración se rehizo sobre la punta nueva con el conflicto en el prompt; una sub-task fallida no cortó la otra.
- **Revisión ponytail:** a mano; 1 atajo deliberado marcado con `ponytail:`: los worktrees de sub-tasks fallidas quedan para mirarlos y `abort` los borra. Las integraciones se serializan con una cadena de promesas, sin dependencia de mutex.
- **Desbloquea:** T5.3

### T5.3 · Reanudar a mitad de implementar
- **Estado:** `[x] Hecho`
- **Descripción:** al retomar en implementar, las sub-tasks integradas se respetan y las que estaban en curso vuelven su worktree al sha de inicio y se rehacen.
- **Lint:** `pnpm lint`.
- **Test:** integración: con tres sub-tasks, se mata el proceso cuando una está integrada, otra commiteada sin integrar y otra a medio editar. Al retomar, la primera no se rehace, la segunda se integra sin otra sesión y la tercera se rehace desde un worktree limpio.
- **Canario:** no reconocer las integradas al retomar puso en rojo el test, porque rehízo ST-1; anular la integración directa de una commiteada también, porque ST-2 abrió otra sesión. Restaurados; 1 de 1 verde.
- **Criterio de aprobación:** con ST-1 integrada, ST-2 commiteada sin integrar y ST-3 cortada con un archivo a medias y basura en su worktree, retomar abre una sola sesión, la de ST-3. ST-2 se integra con su commit grabado, ST-3 se rehace desde un worktree limpio, la basura no llega a la feature y el historial queda ST-1, ST-2, ST-3.
- **Revisión ponytail:** a mano; sin hallazgos. No hizo falta código nuevo: la reanudación sale de leer los eventos `unidad` de la entrada actual, ya escrita en T5.2.
- **Desbloquea:** T5.4

### T5.4 · Fase verificar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/verificar.ts`: sobre la feature integrada, `verify`, cada comando del ac-map y los hashes de `locked.json`. Un criterio rojo devuelve a implementar la sub-task que lo cubre con la salida; un test bloqueado cambiado detiene sin reintentar.
- **Lint:** `pnpm lint`.
- **Test:** con repos de fixture:
  - Todo verde → avanza a revisar.
  - AC-2 rojo → vuelve a implementar solo la sub-task de AC-2, con la salida en el motivo.
  - Tercera vuelta → detiene.
  - Un byte cambiado en un test bloqueado → detiene con el archivo.
- **Canario:** devolver todas las sub-tasks en lugar de la del criterio puso en rojo `AC-2 rojo: vuelve solo ST-2`; no comparar los hashes puso en rojo `un byte cambiado en un test bloqueado detiene como invariante`. Restaurados; 4 de 4 verdes. La tercera vuelta la corta el engine, probado en T1.2.
- **Criterio de aprobación:** el motivo de vuelta muestra el criterio, el comando y su salida, por ejemplo `AC-2 sigue en rojo: \`node tests/ac2.mjs\` salió 1:` seguido de `esperaba 403`. Un verify rojo con criterios verdes vuelve con todas las sub-tasks, como atajo marcado con `ponytail:`.
- **Revisión ponytail:** a mano; 1 atajo deliberado: no se intenta atribuir un verify rojo a una sub-task.
- **Desbloquea:** Gate F5

### Gate Fase 5
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase5.int.test.ts`: implementar y verificar reales en el runner con el SDK simulado y tres sub-tasks, dos en paralelo y una dependiente. AC-2 falla en la primera pasada, vuelve con su motivo, ST-2 se rehace y la rama queda verde, lineal y con dos sesiones simultáneas medidas. Este test encontró la regresión T1.3b del runner.
- **Canario:** re-canario sobre tres piezas, todas en el test de integración: que verificar devuelva todas las sub-tasks, revertir el arreglo de T1.3b e integrar por merge pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** `smoke/implementar.smoke.ts` verde con el SDK real: Haiku implementó en paralelo `confirmados` y `cancelados` sobre el repo de juguete, cada una en su worktree; se integraron por cherry-pick y verificar corrió los dos criterios y verify en verde.
- **Revisión ponytail:** sobre el diff acumulado: sin exports sin uso. `ponytail:` nuevos: 2, worktrees de sub-tasks fallidas que quedan para mirarlos y un verify rojo atribuido a todas las sub-tasks. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 6

---

# Fase 6 — Revisar, entregar e informe

> Objetivo: un run llega a una PR abierta, nunca mergeada, con un informe que explica qué decidió, cuánto costó y qué falló en el camino.

### T6.1 · Fase revisar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/revisar.ts` y `prompts/revisar.md`: sesión de Opus 5.5 de solo lectura con el diff, el plan, convenciones, `que-es-bien.md` con `ejemplos/`, lecciones, graft y la salida de `graft blast`. Schema de `review.json`. Los bloqueantes devuelven su sub-task con el hallazgo; los avisos pasan al informe.
- **Lint:** `pnpm lint`.
- **Test:** con `query` falsa:
  - Un bloqueante en ST-2 → vuelve a implementar solo ST-2 con el hallazgo en el prompt.
  - Solo avisos → avanza y los avisos quedan en eventos.
  - Un hallazgo que nombra una sub-task inexistente → falla de gate y reintento.
  - Tercera vuelta → detiene.
- **Canario:** tratar los avisos como bloqueantes puso en rojo `solo avisos: avanza`; no pasarle el radio de graft al prompt puso en rojo `el prompt recibe el radio de impacto de graft sobre el diff real`. Restaurados; 4 de 4 verdes. La tercera vuelta la corta el engine, probado en T1.2.
- **Criterio de aprobación:** el prompt de revisar recibe el diff real contra la base y la salida de `graft blast --base <sha>` sobre el índice reconstruido; la sesión corre con Read, Grep, Glob y graft, sin escritura ni comandos.
- **Revisión ponytail:** a mano; sin hallazgos. `graft blast` que falla no frena revisar: es contexto, no un gate, y el prompt lo dice.
- **Desbloquea:** T6.2

### T6.2 · Fase entregar
- **Estado:** `[x] Hecho`
- **Descripción:** `src/github/` y `src/phases/entregar.ts`: push de la feature, PR con `gh` solo si no existe, título desde la feature y cuerpo desde el resumen del informe. Libera el lock. Nunca mergea.
- **Lint:** `pnpm lint`.
- **Test:** con el `gh` falso:
  - Primera entrega → un `gh pr create` con la rama correcta.
  - Retomar después de crear la PR → ningún segundo `create`.
  - El registro de argumentos de `gh` nunca contiene `merge` en una PR de feature.
  - El lock queda libre al terminar.
- **Canario:** crear la PR sin buscar si existe puso en rojo `retomar después de crear la PR no hace un segundo create` y `una PR ya mergeada no se vuelve a abrir`. Restaurado; 5 de 5 verdes.
- **Criterio de aprobación:** la rama llega al remote bare de prueba y el `gh` falso registra un único `pr create` con la rama, la base y el título esperados; ningún `merge`. El lock lo suelta el proceso del run al quedar entregado, cubierto por el gate de la Fase 6.
- **Revisión ponytail:** a mano; sin hallazgos. El `gh` falso guarda su estado en un JSON del HOME del test para que aprender pueda reusarlo.
- **Desbloquea:** T6.3

### T6.3 · Informe del run
- **Estado:** `[x] Hecho`
- **Descripción:** `src/report/`: `informe.md` desde los eventos según la sección 6 de la spec, también parcial cuando el run se detiene, con el comando exacto para seguir. Aviso al terminar o al detenerse. `flowrunner report <run>` y `--sesion <nombre>`.
- **Lint:** `pnpm lint`.
- **Test:** desde logs de fixture:
  - Run completo → el informe trae la PR, las decisiones por fase, costo y duración por fase, rechazos y avisos.
  - Run detenido en verificar → informe parcial con el motivo y `flowrunner resume <run>`.
  - Las fallas de infraestructura y de gate aparecen separadas.
  - Un texto de modelo con HTML aparece como texto, sin interpretarse.
- **Canario:** quitar el comando siguiente del informe parcial puso en rojo `un run detenido en verificar trae el motivo y el comando para seguir`; mostrar el texto del modelo sin escapar puso en rojo `un texto de modelo con HTML aparece como texto`. Restaurados; 5 de 5 verdes.
- **Criterio de aprobación:** el informe sale del log solo: estado, PR, costo, decisiones por fase, duración y costo por fase, vueltas, reintentos por gate separados de las fallas de infraestructura, rechazos y avisos; parcial si se detuvo, con el comando para seguir. El proceso del run lo escribe siempre al terminar; `flowrunner report <run>` lo regenera y `--sesion` muestra un transcript como pasos de texto. El aviso al entregar lo emite entregar, T6.2; al detenerse, el runner, T1.3.
- **Revisión ponytail:** a mano; sin hallazgos. El informe usa listas y no tablas, por la preferencia de la persona para reportes.
- **Desbloquea:** Gate F6

### Gate Fase 6
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase6.int.test.ts`: un run completo por CLI, con todas las fases reales salvo el modelo, que es el SDK simulado, y `gh`, que es el falso. Pasa por la aprobación, una vuelta de verificar porque AC-1 sigue rojo y una de revisar por un bloqueante; termina `entregado` con la rama en el remote, un único `pr create`, ningún `merge`, el informe con las dos vueltas, el lock suelto y el aviso "PR abierta, 2 vueltas".
- **Canario:** re-canario sobre tres piezas, todas en el test de integración: ignorar los bloqueantes de revisar, no escribir el informe al terminar el proceso y omitir las vueltas del informe pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** `smoke/e2e.smoke.ts` verde con el SDK real en todas las fases sobre el repo de juguete: plan, aprobación por CLI, implementar, verificar, revisar y entregar, con la PR registrada por el `gh` falso contra un remote bare local. En el camino apareció que los falsos escribían en el HOME real durante los smoke; ahora usan `FAKE_LOG_DIR`, y los archivos que habían quedado se borraron.
- **Revisión ponytail:** sobre el diff acumulado: sin exports sin uso. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Fase 7

---

# Fase 7 — Aprender y tick

> Objetivo: al mergear una PR, las correcciones de la persona se convierten solas en lecciones que llegan a la base por una PR con auto-merge.

### T7.1 · `flowrunner tick` y `learn`: pausados y estado de las PRs
- **Estado:** `[x] Hecho`
- **Descripción:** `src/cli/tick.ts`: retoma los runs `pausado_por_limite` y consulta con `gh` el estado de las PRs de los runs `entregado`: cerrada sin merge lleva a `cerrado`; mergeada lleva a aprender. `flowrunner learn <run>` hace la misma consulta para un solo run, en el momento. Dos ticks a la vez, o un tick y un `learn` sobre el mismo run, no se pisan.
- **Lint:** `pnpm lint`.
- **Test:** con el `gh` falso:
  - Un run pausado se retoma.
  - PR cerrada sin merge → `cerrado` sin sesión de agente.
  - PR mergeada → pasa a aprender.
  - PR abierta → sin cambios.
  - Dos ticks simultáneos → el segundo sale sin hacer nada.
  - `learn` sobre un run cuya PR sigue abierta → sale 0 diciendo que no hay merge todavía.
  - `learn` mientras un tick procesa ese run → no escribe la lección dos veces.
- **Canario:** tratar una PR cerrada como mergeada puso en rojo `PR cerrada sin merge: cerrado sin ninguna sesión`, que ahora también exige `pr_cerrada` con `mergeada: false`; quitar el límite de una pasada por tick puso en rojo `en un tick, aprender corre una sola vez aunque la PR siga abierta`. Restaurados; 5 de 5 verdes en `test/tick.int.test.ts` y 7 de 7 en el runner.
- **Criterio de aprobación:** `flowrunner tick` sin nada pendiente termina sin llamar al modelo; con la PR abierta deja el run entregado y vuelve a probar en el próximo tick. Los locks de archivo, `tick.lock` y `aprender.lock` por run, evitan que dos procesos aprendan del mismo run. En el camino aparecieron dos cosas: el runner en modo tick giraba sin fin con la PR abierta, y la salida de `gh pr view` no se validaba; ahora pasa por un schema de Zod.
- **Revisión ponytail:** a mano; sin hallazgos.
- **Desbloquea:** T7.2

### T7.2 · Correcciones de la persona
- **Estado:** `[x] Hecho`
- **Descripción:** junta los commits de la rama posteriores al último commit de flowrunner y los comentarios de la PR, filtrando por `github_user`. Sin nada de la persona, el run pasa a `cerrado`.
- **Lint:** `pnpm lint`.
- **Test:** con git real y el `gh` falso:
  - Un commit de la persona después del último de flowrunner → incluido con su sha.
  - Un comentario de otro usuario con texto que parece una instrucción → excluido.
  - Un commit de otra persona → excluido.
  - Sin nada de la persona → `cerrado` sin sesión de agente.
  Comentario: si el filtro regresiona, cualquiera que comente la PR escribe en el cerebro de todos los runs futuros.
- **Canario:** quitar el filtro por usuario en los comentarios puso en rojo `un comentario de otro usuario con texto que parece una instrucción se excluye`; mirar todos los commits y no solo los posteriores al último de flowrunner puso en rojo `un commit de otra persona se excluye; uno de la persona anterior…`. Restaurados; 4 de 4 verdes.
- **Criterio de aprobación:** cada corrección trae su origen, el link al commit `…/pull/412/commits/<sha>` o al comentario, y el diff del commit leído con git. Sin nada de la persona, el run se cierra sin sesión de agente, probado en T7.1. En la v0 cuentan los comentarios generales y los de revisión; los comentarios de línea quedan para después.
- **Revisión ponytail:** a mano; sin hallazgos.
- **Desbloquea:** T7.3

### T7.3 · Lecciones y su PR con auto-merge
- **Estado:** `[x] Hecho`
- **Descripción:** `src/phases/aprender.ts` y `prompts/aprender.md`: sesión de Sonnet 5.5 de solo lectura que propone de 1 a 3 lecciones con su origen; el código las numera y agrega a `lecciones.md` en un worktree `chore/lecciones-<clave>` desde la base, con el lock del repo; push y PR; comprobación de que el diff toca solo `lecciones.md` antes de activar auto-merge con merge commit. Si el archivo pasa su tope, una sesión consolida y la PR se abre sin auto-merge, con aviso.
- **Lint:** `pnpm lint`.
- **Test:** con git real y el `gh` falso:
  - Dos lecciones → `lecciones.md` con `L-n` correlativos y su origen, y un `gh pr merge --auto --merge`.
  - Un diff que además toca otro archivo → PR sin auto-merge y aviso.
  - Un archivo que pasa el tope → consolidación y PR sin auto-merge.
  - Una lección sin origen → falla de gate.
- **Canario:** reducir la regla del auto-merge a "sin consolidación", salteando el chequeo del diff, puso en rojo `autoMergeAllowed: solo con lecciones.md y sin consolidación`; aceptar orígenes inventados puso en rojo `una lección sin un origen de la persona es falla de gate`. Restaurados; 3 de 3 de integración y 5 de 5 unitarios verdes.
- **Criterio de aprobación:** el `gh` falso registra el `pr create` de `chore/lecciones-SHOP-214` y un único `pr merge 413 --auto --merge`; `lecciones.md` en esa rama del remote tiene `L-1` y `L-2` con su origen; el evento `lecciones` dice `auto_merge: true` y el run queda cerrado. Con el archivo sobre su tope, se consolida, no hay auto-merge y llega el aviso. El auto-merge real en GitHub se prueba al subir el proyecto.
- **Revisión ponytail:** a mano; 1 corte: la regla del auto-merge quedó como una función pura de una línea en lugar de estar enterrada en la fase.
- **Desbloquea:** T7.4

### T7.4 · launchd y doctor
- **Estado:** `[x] Hecho`
- **Descripción:** `flowrunner launchd install` escribe el plist del tick con `tick_minutes` de la config global, por defecto 10, y lo carga; `uninstall` lo quita. `flowrunner doctor` comprueba Node, git, `gh` con sesión, graft, el token en el Keychain y el job de launchd, cada uno con su arreglo.
- **Lint:** `pnpm lint`.
- **Test:** `doctor` con binarios falsos: un `gh` sin sesión → sale 1 y nombra el arreglo; el Keychain sin token → sale 1 y sugiere `claude setup-token`; todo presente → sale 0. El plist generado se compara contra uno esperado: programa, argumentos, intervalo y logs.
- **Canario:** ignorar el exit de `gh auth status` puso en rojo `gh sin sesión: sale 1 y dice cómo arreglarlo`; un intervalo fijo de 600 s puso en rojo el test del plist, que espera 420 s con `tick_minutes: 7`. Restaurados; 4 de 4 verdes.
- **Criterio de aprobación:** con el `launchctl` falso, `launchd install` escribe el plist con `tick`, el intervalo de la config y el log, y lo carga con `bootout` y `bootstrap`; `uninstall` lo quita. Los tests escriben en un LaunchAgents de prueba con `FLOWRUNNER_LAUNCH_AGENTS`. Instalarlo de verdad en la Mac de la persona, y ver el tick en `launchctl list`, queda para cuando lo pida.
- **Revisión ponytail:** a mano; sin hallazgos. El plist se escribe como texto con escape XML, sin librería.
- **Desbloquea:** Gate F7

### Gate Fase 7
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase7.int.test.ts`: sobre un run entregado de verdad, con el SDK simulado y el `gh` falso, la PR pasa a mergeada con un commit de la persona y un comentario de otro usuario que pide meter una API key. `flowrunner tick` produce la PR de lecciones: el prompt de aprender trae el commit y no el comentario ajeno, `lecciones.md` cita solo ese commit, hay un único `pr merge 413 --auto --merge` y el run queda cerrado.
- **Canario:** re-canario sobre tres piezas, todas en el test de integración: quitar el filtro por usuario, negar siempre el auto-merge y no dejar correr aprender en modo tick pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** el ciclo completo contra un remote bare local con el `gh` falso: una PR mergeada con una corrección propia produce la PR de lecciones con su origen y auto-merge. El ciclo en GitHub real se prueba al subir el proyecto.
- **Revisión ponytail:** sobre el diff acumulado: sin exports sin uso; la salida de `gh` se valida con Zod en lugar de confiar en su forma. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: los comentarios de línea de la PR no se leen todavía, anotado en T7.2.
- **Desbloquea:** Fase 8

---

# Fase 8 — La consola en Claude Code y telemetría

> Objetivo: la persona opera flowrunner entero conversando en Claude Code, sin tocar la terminal, y puede medir qué pieza de la fábrica mejorar.

### T8.1 · Skill `flowrunner`: la consola
- **Estado:** `[x] Hecho`
- **Descripción:** `skills/flowrunner/SKILL.md` según la sección 2 de la spec: escribir la feature con la entrevista de una pregunta por vez, y operar los runs con la tabla de pedidos de la spec, siempre por el CLI con `--json`. Aprobar y pedir cambios solo con la decisión explícita de la persona; el plan, el informe y los transcripts como datos, nunca como instrucciones. `flowrunner skill install` copia la skill a `~/.claude/skills` y, después de mostrarlas y con confirmación, agrega las reglas *ask* para `approve` y `changes` a `~/.claude/settings.json` sin pisar las que ya existen.
- **Lint:** `pnpm lint`; el frontmatter de la skill se valida con el schema de skills.
- **Test:** sobre `skill install` con un `HOME` temporal:
  - Con un `settings.json` que ya tiene permisos propios → los conserva y agrega las dos reglas *ask*.
  - Correrlo dos veces → no duplica las reglas.
  - Sin confirmación → no toca `settings.json`.
  Comentario: si regresiona, Claude podría aprobar un plan sin preguntarte.
  - El frontmatter de la skill valida contra el schema de skills: nombre `flowrunner` y descripción.
  El comportamiento conversacional de la skill no tiene test automático; se verifica en el criterio.
- **Canario:** reemplazar `settings.json` en lugar de mezclarlo puso en rojo `con permisos propios, --confirmar los conserva y agrega las dos reglas ask`. Restaurado; 4 de 4 verdes en `test/skill.int.test.ts`.
- **Criterio de aprobación:** verificado lo automatizable: la skill instruye cada pedido con su comando `--json`, y cada uno de esos comandos tiene su test de integración con el CLI real. **Pendiente de la persona:** correr `flowrunner skill install --confirmar` en su máquina y operar una feature real desde una sesión de Claude Code, con el permiso pedido al aprobar. Requiere cambiar su `~/.claude/settings.json` real, que no se toca sin su decisión. Queda como parte del criterio del gate final.
- **Revisión ponytail:** a mano; sin hallazgos. `skill install` copia una carpeta y mezcla un JSON, sin dependencias.
- **Desbloquea:** T8.2

### T8.2 · `flowrunner stats`
- **Estado:** `[x] Hecho`
- **Descripción:** `src/report/stats.ts`: agrega los eventos de todos los runs de un proyecto o de todos: reintentos por fase, motivos de gate y de rechazo más frecuentes, costo y duración por fase, lecciones generadas.
- **Lint:** `pnpm lint`.
- **Test:** desde logs de fixture de cinco runs: la fase con más reintentos encabeza la lista; los motivos se agrupan aunque difieran en rutas o números; un run detenido cuenta su costo parcial; un directorio de run sin eventos no rompe el total.
- **Canario:** agrupar por el texto exacto del motivo puso en rojo `la fase con más reintentos encabeza y los motivos se agrupan aunque cambien rutas y números` y `motiveKey quita rutas, ids y números`. Restaurado; 4 de 4 verdes.
- **Criterio de aprobación:** `flowrunner stats` muestra en una pantalla la fase que más reintenta y vuelve, sus motivos agrupados sin rutas, ids ni números, los rechazos de tripwires, el costo y la duración por fase y las lecciones generadas; filtra por proyecto.
- **Revisión ponytail:** a mano; sin hallazgos. Reusa `phaseSummaries` del informe en lugar de recontar eventos.
- **Desbloquea:** Gate F8

### Gate Fase 8
- **Estado:** `[x] Hecho`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** `test/fase8.int.test.ts`: una feature pasa `feature check --json`, corre de punta a punta por CLI con el SDK simulado y el `gh` falso, con una vuelta de verificar, y `flowrunner stats acme-api --json` pone a verificar primera con su vuelta, el costo de cada fase y el motivo agrupado.
- **Canario:** re-canario sobre tres piezas, todas en el test de integración: no contar las vueltas en stats, no registrar el costo de las sesiones y una feature resuelta con otra clave pusieron el test en rojo. Restaurados.
- **Criterio de aprobación:** lo automatizable está verde: los comandos que usa la skill, cada uno con su test. **Pendiente de la persona:** la demo desde su sesión de Claude Code, escribir la feature con la skill, lanzarla, aprobarla y pedir que explique `stats`. Queda consolidada en el criterio del gate final.
- **Revisión ponytail:** sobre el diff acumulado: sin exports sin uso. `ponytail:` nuevos: ninguno. `test-debt:` nuevos: ninguno.
- **Desbloquea:** Cierre

---

# Cierre del proyecto

### Gate final
- **Estado:** `[!] Bloqueado` — todo lo automatizable está verde; falta la aceptación de la persona
- **Motivo del bloqueo:** el criterio de aprobación pide una feature real en un repo real de la persona, operada desde su sesión de Claude Code, y comparar el tiempo de espera con flowindex. Eso necesita tres cosas que no se hacen sin ella: el token de `claude setup-token` en su Keychain, las reglas *ask* en su `~/.claude/settings.json` real y un repo suyo con `.flowrunner/`.
- **Acción:** la persona, en este orden: `flowrunner doctor`; `claude setup-token` y guardarlo con `security add-generic-password -s flowrunner -a claude-oauth-token -w`; `flowrunner skill install --confirmar`; `flowrunner project add <repo> --github-user anegri93` y `flowrunner brain init <repo>`; completar el cerebro y commitearlo; `flowrunner launchd install`; y desde una sesión de Claude Code, escribir y lanzar una feature real.
- **Validación de lint:** `pnpm lint` verde en todo el repo: eslint `strict-type-checked`, prettier y `tsc` estricto.
- **Tests:** `pnpm verify` verde: 158 unitarios en 25 archivos y 46 de integración en 18. `pnpm smoke` verde con el SDK real: 8 en 6 archivos, incluidos el plan real, implementar en paralelo real y el recorrido de punta a punta real sobre el repo de juguete.
- **Test de integración:** `test/final.int.test.ts`: el recorrido entero por CLI sobre repos reales en tmpdir, con el SDK simulado y el `gh` falso: feature check, preparar, planificar con un `kill -9` y su `resume`, aprobar, implementar dos sub-tasks en paralelo con otro `kill -9` y su `resume`, verificar, revisar y entregar; después la persona corrige y mergea la PR, y `tick` escribe la lección, abre su PR con auto-merge y cierra el run. `report` y `stats` lo reflejan.
- **Canario:** se rompió el invariante central apagando a la vez el hook y el doble control, para que el modelo pudiera escribir fuera del alcance: la suite se puso roja, con 11 tests unitarios y 1 de integración que lo detectan. Restaurado.
- **Criterio de aprobación:** pendiente de la persona, según el motivo del bloqueo. Lo más cercano ya verificado: `smoke/e2e.smoke.ts` lleva una feature real del repo de juguete de punta a punta con el SDK real, con la aprobación por CLI en el medio.
- **Revisión ponytail:** sobre el diff completo, revisado fase por fase en cada gate. Ledger de `ponytail:`: 2 atajos deliberados, `src/phases/implementar.ts`, donde los worktrees de sub-tasks fallidas quedan para mirarlos y `abort` los borra, y `src/phases/verificar.ts`, donde un verify rojo con criterios verdes vuelve con todas las sub-tasks. Ledger de `test-debt:`: los comentarios de línea de una PR no se leen al aprender, anotado en T7.2. Regresiones encontradas en el camino: T1.3b y T3.1b.
