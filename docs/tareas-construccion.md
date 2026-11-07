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
- **Estado:** `[ ] Pendiente`
- **Descripción:** comprobar con el SDK real si una sesión iniciada con `CLAUDE_CODE_OAUTH_TOKEN` en su `env` le pasa esa variable a los procesos que lanza su herramienta Bash. Si la pasa, implementar la mitigación en `src/agent/env.ts`: entorno mínimo para el SDK y entorno limpio para los subprocesos, o `apiKeyHelper` si el SDK no permite separarlos. El resultado y la mitigación elegida quedan en el ADR 0013.
- **Lint:** `pnpm lint`.
- **Test:** smoke `smoke/env-leak.smoke.ts`: una sesión real con un token centinela corre `env` por Bash; afirma que la salida no contiene el nombre ni el valor del token. Comentario: si regresiona, el código que escribe el agente puede leer la credencial de la suscripción.
- **Canario:** a comprobar: sin la mitigación, el smoke se pone rojo con el centinela visible en la salida.
- **Criterio de aprobación:** ADR 0013 mergeado con la salida real de la sesión y la mitigación; el smoke verde.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T0.3

### T0.3 · Puntos abiertos 2 y 3: aislamiento, señal de límite y fixtures reales
- **Estado:** `[ ] Pendiente`
- **Descripción:** con el SDK real sobre `test/toy-repo`, que trae un `.mcp.json`, un `.claude/settings.json` con un hook y un `CLAUDE.md` propios:
  - Comprobar que con `settingSources: []`, `strictMcpConfig: true` y graft como único MCP, el mensaje de inicio de la sesión no lista el MCP del repo, el hook no corre y el `CLAUDE.md` no aparece en el prompt.
  - Buscar en los tipos del SDK qué mensaje informa la ventana o el límite de la suscripción y documentarlo; si no hay señal previa, documentar la forma del error.
  - Grabar en `test/fixtures/streams/` sesiones reales: lectura y edición, Bash permitido y negado, salida estructurada válida, salida que agota los reintentos de schema y una sesión cortada por timeout.
  Resultado en el ADR 0014.
- **Lint:** `pnpm lint`.
- **Test:** smoke `smoke/isolation.smoke.ts`: afirma sobre el mensaje de inicio grabado que los servidores MCP son exactamente `[graft]`, que el hook del repo no dejó su archivo marcador y que una pregunta sobre una frase que solo está en el `CLAUDE.md` del repo no se responde con esa frase. Comentario: si regresiona, una feature escrita por cualquiera corre con los hooks y conectores del repo o del usuario.
- **Canario:** a comprobar: con `settingSources` por defecto, el smoke se pone rojo en las tres aserciones.
- **Criterio de aprobación:** ADR 0014 mergeado; los fixtures grabados y nombrados por caso; el smoke verde.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T0.4

### T0.4 · Punto abierto 4: graft por worktree
- **Estado:** `[ ] Pendiente`
- **Descripción:** medir `graft build` sobre un repo del tamaño de flowindex y comprobar si el directorio `graft/` construido en el worktree de la feature sirve copiado al worktree de una sub-task. Decidir entre construir por worktree o una vez por run y copiar. Resultado en el ADR 0015.
- **Lint:** `pnpm lint`.
- **Test:** integración `graft.int.test.ts`: construye el índice de un repo de fixture, levanta `graft mcp` por stdio y llama `graft_repo_map`; afirma que la respuesta nombra un archivo real del fixture. Si la decisión es copiar, un segundo caso afirma que el índice copiado responde igual en el otro worktree. Comentario: si regresiona, planificar y revisar trabajan sin el grafo sin enterarse.
- **Canario:** a comprobar: apuntar `graft mcp` a un directorio sin índice pone el test en rojo.
- **Criterio de aprobación:** ADR 0015 mergeado con los tiempos medidos; test verde en `pnpm verify`.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T0.5

### T0.5 · Config global, config del repo y formato de feature
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: quitar `.strict()` del schema del repo pone en rojo el test del campo desconocido; quitar el chequeo de criterios pone en rojo el de la feature sin criterios.
- **Criterio de aprobación:** `flowrunner feature check` sale 0 con una feature válida y 1 con el motivo cuando no lo es.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F0

### Gate Fase 0
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde en todo el repo.
- **Tests:** `pnpm test` y `pnpm test:integration` verdes con `pnpm verify`; `pnpm smoke` verde en local.
- **Test de integración:** el CLI real, como proceso hijo, valida una feature de fixture contra la config de un repo de fixture: verde con datos válidos y salida 1 con el motivo cuando el repo no tiene `.flowrunner/config.yaml`.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** los ADR 0013-0015 responden los puntos abiertos 1-4 con evidencia, y ninguno contradice la spec sin una tarea que la ajuste.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado de la fase + `/ponytail-debt` + listado de `test-debt:` nuevos.
- **Desbloquea:** Fase 1

---

# Fase 1 — Núcleo: eventos, máquina de estados y proceso por run

> Objetivo: un run con fases falsas recorre todos los estados, se detiene, se retoma y llega al final con el mismo log que sin cortes.

### T1.1 · Store del run: `events.jsonl` y lock por repo
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: tratar la corrupción del medio como la del final pone en rojo su test; decidir el lock solo por el pid pone en rojo el caso del run en espera.
- **Criterio de aprobación:** un log escrito, cortado con `kill -9` a mitad de un append, se relee sin perder eventos completos.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T1.2

### T1.2 · Máquina de estados pura
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: un off-by-one en el tope de vueltas pone en rojo su test; contar los intentos en `changes` pone en rojo el suyo.
- **Criterio de aprobación:** la tabla de transiciones del engine coincide con la sección 3 de la spec, revisada fila por fila.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T1.3

### T1.3 · El loop del run: acciones idempotentes
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/runner/`: lee el log, pide `siguiente`, ejecuta la acción con el módulo de fase que le toca, registra `accion_iniciada` y `accion_terminada`. Al retomar, una acción iniciada y no terminada se rehace; las fases reciben el sha registrado al iniciar para volver su worktree. Las fases se inyectan por registro.
- **Lint:** `pnpm lint`.
- **Test:** con fases falsas que escriben un archivo por ejecución:
  - Un run completo deja exactamente una ejecución por acción.
  - Un corte entre `accion_iniciada` y `accion_terminada` rehace esa acción y solo esa.
  - Un corte después de `accion_terminada` no la repite.
  - Una fase que lanza una excepción no tipada queda como falla de infraestructura, no como gate.
- **Canario:** a comprobar: rehacer también las acciones terminadas pone en rojo el test del corte después de terminar.
- **Criterio de aprobación:** el log de un run falso muestra cada acción con su par de eventos.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T1.4

### T1.4 · CLI: run, status, resume, rerun, abort
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: leer la feature del archivo original en lugar de la copia pone en rojo el test de edición.
- **Criterio de aprobación:** desde una terminal, `flowrunner run` vuelve al prompt al instante y `flowrunner status` muestra el avance.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F1

### Gate Fase 1
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** un run con todas las fases falsas se lanza por CLI, se mata con `kill -9` en tres puntos distintos, se retoma con `resume` cada vez y llega a `entregado`; su log, sin los eventos de reanudación, es igual al de un run sin cortes.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** demo en terminal: lanzar, matar, retomar y ver el estado final con `status`.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 2

---

# Fase 2 — Git, cerebro y preparar

> Objetivo: preparar deja un worktree listo con la base en verde, el índice de graft y el cerebro cargado, o se detiene sin gastar tokens.

### T2.1 · Módulo git
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/git/`: worktree desde `origin/<base>` en una rama nueva, commit con trailer, cherry-pick con detección de conflicto que deja el worktree limpio, reset a un sha, push con `--force-with-lease` que se niega fuera de las ramas `feat/` y `chore/lecciones-` de flowrunner, y diff contra la base con archivos y contenido.
- **Lint:** `pnpm lint`.
- **Test:** con git real y remote bare:
  - El worktree nace en el sha de `origin/<base>` aunque la base local esté atrasada.
  - Un cherry-pick con conflicto devuelve el conflicto y deja el worktree sin cambios.
  - Push a `main` o a una rama ajena → error sin tocar el remote.
  - Push con el remote movido por otro → error de lease.
- **Canario:** a comprobar: sacar la restricción de ramas pone en rojo el test del push a `main`.
- **Criterio de aprobación:** las operaciones corren sobre el repo de juguete sin tocar su checkout principal.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T2.2

### T2.2 · Cerebro: carga, topes y plantillas
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/brain/`: carga `.flowrunner/` desde un worktree según la sección 8 de la spec, con los topes por archivo, rechazo de links, lista de `ejemplos/` y sha256 por archivo. `flowrunner project add <ruta>` registra el repo y dice qué le falta. `flowrunner brain init <ruta>` escribe las plantillas sin commitear y sin pisar archivos existentes.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Un archivo en su tope exacto se carga; uno con un carácter más detiene con archivo, tamaño y tope.
  - Un `convenciones.md` que es un link → error.
  - Un repo sin `.flowrunner/` → error que sugiere `brain init`.
  - `brain init` sobre un repo con `lecciones.md` existente no lo pisa.
  - El sha256 registrado cambia si cambia un byte.
- **Canario:** a comprobar: un `>` por `>=` en el tope pone en rojo el test del tope exacto.
- **Criterio de aprobación:** `brain init` sobre el repo de juguete deja plantillas que `project add` acepta.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T2.3

### T2.3 · Fase preparar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/preparar.ts`: lock del repo, fetch, worktree de la feature, `setup`, `verify` sobre la base y `graft build` según el ADR 0015. Clasifica las fallas: base roja, exit 126 o 127, setup que falla y config inválida son fallas de entorno.
- **Lint:** `pnpm lint`.
- **Test:** con repos de fixture:
  - Base con `verify` en verde → evento de preparado con el sha de la base.
  - Base roja → falla de entorno con la salida de `verify`, sin reintento.
  - Un `setup` que no existe → falla de entorno con exit 127, no de gate.
  - Un segundo `flowrunner run` sobre el mismo repo mientras el primero tiene el lock → se niega y nombra el run que lo tiene.
- **Canario:** a comprobar: clasificar el 127 como falla de gate pone en rojo su test.
- **Criterio de aprobación:** sobre el repo de juguete con un test roto en la base, el run se detiene en preparar con costo cero.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F2

### Gate Fase 2
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** un run por CLI con preparar real y el resto de las fases falsas: con base verde llega a `entregado` y deja el worktree con el índice de graft; con base roja termina `detenido` en preparar, sin eventos de uso.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** demo con el repo de juguete en los dos casos.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 3

---

# Fase 3 — Agente y tripwires

> Objetivo: una sesión del SDK corre aislada, con su salida validada, su costo registrado y los tripwires rechazando en el acto lo que sale del alcance.

### T3.1 · Capa de agente
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/agent/`: arma las opciones de cada sesión según la fase: aislamiento de la sección 4 de la spec, el entorno del ADR 0013, modelo y effort, `outputFormat` desde un schema Zod, `maxBudgetUsd`, timeout con `abortController` y graft como MCP. Copia el stream a `runs/<id>/sesiones/`, emite eventos de uso con costo y tokens por modelo, y clasifica el resultado: éxito, infraestructura, límite, presupuesto o schema agotado. Recibe `query` por parámetro.
- **Lint:** `pnpm lint`.
- **Test:** con los streams grabados en T0.3:
  - Éxito con salida estructurada → devuelve el objeto validado y un evento de uso.
  - `error_max_structured_output_retries` → falla de gate con el motivo.
  - Timeout → falla de infraestructura y el stream parcial queda copiado.
  - Error de límite → evento de pausa.
  - Las opciones construidas para cada fase tienen `settingSources` vacío y un único MCP.
- **Canario:** a comprobar: clasificar el timeout como gate pone en rojo su test; dejar `settingSources` por defecto pone en rojo el de opciones.
- **Criterio de aprobación:** el stream copiado de una sesión se lee como texto con `flowrunner report`.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T3.2

### T3.2 · Reglas de tripwires
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: resolver rutas sin realpath pone en rojo el caso del link.
- **Criterio de aprobación:** cada regla de la sección 4 de la spec tiene al menos un caso permitido y uno rechazado.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T3.3

### T3.3 · Hook `PreToolUse` y deny por defecto
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/tripwires/hook.ts`: el hook que aplica las reglas por fase y devuelve allow o deny con su motivo, y un `canUseTool` que rechaza todo lo que llega sin decidir. Cada rechazo emite un evento `rechazo`.
- **Lint:** `pnpm lint`.
- **Test:** llamando al hook con entradas de la forma del SDK:
  - Write fuera del alcance → deny con el motivo y evento `rechazo`.
  - Una herramienta que ninguna regla menciona → deny.
  - WebFetch en implementar → deny.
  - Read dentro del worktree → allow.
  Smoke `smoke/tripwire.smoke.ts`: una sesión real a la que se le pide escribir fuera del alcance termina sin el archivo y con el motivo en el stream.
- **Canario:** a comprobar: que el `canUseTool` devuelva allow pone en rojo el test de la herramienta no mencionada.
- **Criterio de aprobación:** el smoke verde y el motivo visible en el transcript.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T3.4

### T3.4 · Doble control sobre el diff
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/tripwires/diff.ts`: aplica las mismas reglas de ruta y contenido al diff real de un worktree contra su punto de partida, incluidos los archivos sin seguimiento.
- **Lint:** `pnpm lint`.
- **Test:** con git real:
  - Un archivo fuera del alcance creado por un comando, no por Edit → rechazo.
  - Un test bloqueado modificado → rechazo.
  - Un diff dentro del alcance → aprobado.
  - Un archivo sin seguimiento fuera del alcance → rechazo.
- **Canario:** a comprobar: mirar solo los archivos con seguimiento pone en rojo el último caso.
- **Criterio de aprobación:** el diff de una sub-task falsa que hace trampa por Bash se rechaza con el archivo y la regla.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F3

### Gate Fase 3
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes; `pnpm smoke` verde en local.
- **Test de integración:** una sesión falsa que reproduce un stream grabado con un Edit fuera del alcance, sobre un worktree real: el hook la rechaza, el doble control no encuentra cambios y el run registra el `rechazo` y el uso.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** el smoke del tripwire verde con el SDK real.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 4

---

# Fase 4 — Planificar y aprobar

> Objetivo: un run llega a `esperando_aprobacion` con un plan que pasó su gate, avisa y espera sin procesos vivos; `approve` y `changes` lo destraban.

### T4.1 · Schemas del plan y gate de planificar
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: comparar rutas por igualdad y no por prefijo pone en rojo el caso de `src/a/b.ts`.
- **Criterio de aprobación:** cada rechazo nombra la sub-task, el criterio o la ruta, en un texto que sirve como motivo de reintento.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T4.2

### T4.2 · Fase planificar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/planificar.ts` y `prompts/planificar.md`: sesión de Opus 5.5 con la feature, el cerebro, graft y el subagente explorador de Haiku 5.5; escritura limitada a `tests_globs` y sin Bash. Si el gate pasa: commit de los tests y `locked.json`. Si falla: reintento con el motivo. Una instrucción de `changes` entra en el prompt.
- **Lint:** `pnpm lint`.
- **Test:** con `query` falsa que devuelve planes grabados y escribe tests en el worktree:
  - Plan válido → commit con los tests y `locked.json` con un hash por archivo.
  - Plan rechazado → reintento cuyo prompt contiene el motivo del gate.
  - Con una instrucción de `changes` → el prompt la contiene.
  - Un test escrito fuera de `tests_globs` → rechazado por el tripwire.
- **Canario:** a comprobar: commitear antes de pasar el gate pone en rojo el test del plan rechazado.
- **Criterio de aprobación:** smoke manual sobre el repo de juguete: el plan real pasa el gate o se rechaza con un motivo comprensible.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T4.3

### T4.3 · Aprobar: espera sin proceso, approve, changes
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/notify/` con `osascript` y la fase aprobar: registra la espera, avisa con un texto que dice qué pedirle a Claude, como *"SHOP-214: el plan espera tu aprobación. Pedile a Claude que te lo muestre."*, y termina el proceso. `flowrunner plan <run>` muestra plan, sub-tasks con alcance y diff de los tests. `approve` relanza hacia implementar; `changes <run> "<motivo>"` relanza hacia planificar con la instrucción.
- **Lint:** `pnpm lint`.
- **Test:** sobre el CLI real:
  - Al llegar a la espera, el proceso del run termina y el `osascript` falso registró el aviso con la clave.
  - `approve` sobre un run que no espera → sale 1 con el estado actual.
  - `changes` sin motivo → sale 1.
  - `changes` con motivo → planificar corre otra vez con el motivo y los intentos no suben.
- **Canario:** a comprobar: dejar el proceso vivo esperando pone en rojo el primer test.
- **Criterio de aprobación:** demo: el aviso de macOS llega, `flowrunner plan` se lee bien en la terminal y `approve` sigue.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F4

### Gate Fase 4
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** un run por CLI con preparar y planificar reales, la `query` falsa y el resto falso: llega a la espera sin proceso vivo, `changes` lo devuelve a planificar, el segundo plan pasa, `approve` lo lleva a `entregado`.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** smoke real de punta a punta hasta la espera sobre el repo de juguete.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 5

---

# Fase 5 — Implementar en paralelo y verificar

> Objetivo: las sub-tasks corren en paralelo en sus worktrees, se integran por cherry-pick y la rama de la feature pasa sus criterios y sus tests bloqueados intactos.

### T5.1 · Programador de sub-tasks
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/engine/scheduler.ts`, puro: dado el grafo de dependencias, las sub-tasks integradas, las en curso y `max_parallel`, devuelve cuáles arrancar.
- **Lint:** `pnpm lint`.
- **Test:** bordes:
  - Tres independientes con `max_parallel` 2 → arranca dos.
  - Una que depende de otra no integrada → no arranca aunque haya lugar.
  - Al integrarse la dependencia → arranca.
  - Una sub-task fallida definitivamente → sus dependientes nunca arrancan y el run se detiene.
- **Canario:** a comprobar: considerar "commiteada" igual que "integrada" pone en rojo el tercer caso.
- **Criterio de aprobación:** el orden de arranque de un plan de fixture con un diamante de dependencias es el esperado.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T5.2

### T5.2 · Fase implementar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/implementar.ts` y `prompts/implementar.md`: por sub-task, worktree en `feat/<clave>/<id>` desde la punta de la feature, `setup`, sesión de Sonnet 5.5 con los tripwires, doble control, un commit con trailer y cherry-pick sobre la feature. Un conflicto rehace la sub-task sobre la punta nueva y cuenta como intento. Las sesiones corren en paralelo según el programador.
- **Lint:** `pnpm lint`.
- **Test:** integración con `query` falsa que edita archivos en el worktree:
  - Dos sub-tasks independientes corren a la vez y quedan dos commits en la feature, uno por sub-task, con su trailer.
  - Una sub-task que choca al integrarse se rehace una vez y después integra.
  - Una sub-task que viola el doble control no se commitea y reintenta con el motivo.
  - Un fallo de una sub-task no corta la otra que está en curso.
- **Canario:** a comprobar: integrar sin cherry-pick, por merge, rompe la aserción de un commit por sub-task.
- **Criterio de aprobación:** el historial de la rama de la feature queda lineal: tests del plan y un commit por sub-task.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T5.3

### T5.3 · Reanudar a mitad de implementar
- **Estado:** `[ ] Pendiente`
- **Descripción:** al retomar en implementar, las sub-tasks integradas se respetan y las que estaban en curso vuelven su worktree al sha de inicio y se rehacen.
- **Lint:** `pnpm lint`.
- **Test:** integración: con tres sub-tasks, se mata el proceso cuando una está integrada, otra commiteada sin integrar y otra a medio editar. Al retomar, la primera no se rehace, la segunda se integra sin otra sesión y la tercera se rehace desde un worktree limpio.
- **Canario:** a comprobar: rehacer todas al retomar pone en rojo la aserción de la primera.
- **Criterio de aprobación:** el informe muestra una sola sesión para la sub-task que ya estaba integrada.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T5.4

### T5.4 · Fase verificar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/verificar.ts`: sobre la feature integrada, `verify`, cada comando del ac-map y los hashes de `locked.json`. Un criterio rojo devuelve a implementar la sub-task que lo cubre con la salida; un test bloqueado cambiado detiene sin reintentar.
- **Lint:** `pnpm lint`.
- **Test:** con repos de fixture:
  - Todo verde → avanza a revisar.
  - AC-2 rojo → vuelve a implementar solo la sub-task de AC-2, con la salida en el motivo.
  - Tercera vuelta → detiene.
  - Un byte cambiado en un test bloqueado → detiene con el archivo.
- **Canario:** a comprobar: devolver todas las sub-tasks y no solo la de AC-2 pone en rojo el segundo caso.
- **Criterio de aprobación:** el motivo de vuelta muestra el criterio, el comando y su salida.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F5

### Gate Fase 5
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** un plan de fixture con tres sub-tasks, dos en paralelo y una dependiente, recorre implementar y verificar con `query` falsa: un criterio falla en la primera pasada, vuelve, se arregla y la rama queda verde con un commit por sub-task.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** smoke real sobre el repo de juguete con una feature de dos sub-tasks paralelas.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 6

---

# Fase 6 — Revisar, entregar e informe

> Objetivo: un run llega a una PR abierta, nunca mergeada, con un informe que explica qué decidió, cuánto costó y qué falló en el camino.

### T6.1 · Fase revisar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/revisar.ts` y `prompts/revisar.md`: sesión de Opus 5.5 de solo lectura con el diff, el plan, convenciones, `que-es-bien.md` con `ejemplos/`, lecciones, graft y la salida de `graft blast`. Schema de `review.json`. Los bloqueantes devuelven su sub-task con el hallazgo; los avisos pasan al informe.
- **Lint:** `pnpm lint`.
- **Test:** con `query` falsa:
  - Un bloqueante en ST-2 → vuelve a implementar solo ST-2 con el hallazgo en el prompt.
  - Solo avisos → avanza y los avisos quedan en eventos.
  - Un hallazgo que nombra una sub-task inexistente → falla de gate y reintento.
  - Tercera vuelta → detiene.
- **Canario:** a comprobar: tratar los avisos como bloqueantes pone en rojo el segundo caso.
- **Criterio de aprobación:** el prompt de revisar recibe la salida de `graft blast` del diff real.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T6.2

### T6.2 · Fase entregar
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/github/` y `src/phases/entregar.ts`: push de la feature, PR con `gh` solo si no existe, título desde la feature y cuerpo desde el resumen del informe. Libera el lock. Nunca mergea.
- **Lint:** `pnpm lint`.
- **Test:** con el `gh` falso:
  - Primera entrega → un `gh pr create` con la rama correcta.
  - Retomar después de crear la PR → ningún segundo `create`.
  - El registro de argumentos de `gh` nunca contiene `merge` en una PR de feature.
  - El lock queda libre al terminar.
- **Canario:** a comprobar: crear la PR sin chequear si existe pone en rojo el segundo caso.
- **Criterio de aprobación:** la PR aparece en el remote bare de prueba con la rama y el título esperados.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T6.3

### T6.3 · Informe del run
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/report/`: `informe.md` desde los eventos según la sección 6 de la spec, también parcial cuando el run se detiene, con el comando exacto para seguir. Aviso al terminar o al detenerse. `flowrunner report <run>` y `--sesion <nombre>`.
- **Lint:** `pnpm lint`.
- **Test:** desde logs de fixture:
  - Run completo → el informe trae la PR, las decisiones por fase, costo y duración por fase, rechazos y avisos.
  - Run detenido en verificar → informe parcial con el motivo y `flowrunner resume <run>`.
  - Las fallas de infraestructura y de gate aparecen separadas.
  - Un texto de modelo con HTML aparece como texto, sin interpretarse.
- **Canario:** a comprobar: omitir el comando siguiente en el informe parcial pone en rojo el segundo caso.
- **Criterio de aprobación:** el informe de un run del repo de juguete se entiende sin abrir ningún otro archivo.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F6

### Gate Fase 6
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** un run completo por CLI, desde la feature hasta la PR, con todas las fases reales salvo el modelo: `query` falsa y `gh` falso. Pasa por una aprobación, una vuelta de verificar y una de revisar, y termina `entregado` con la PR y un informe que lista esas vueltas.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** smoke real de punta a punta sobre el repo de juguete, con la PR registrada por el `gh` falso contra un remote bare local. La PR real en GitHub se prueba al subir el proyecto.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 7

---

# Fase 7 — Aprender y tick

> Objetivo: al mergear una PR, las correcciones de la persona se convierten solas en lecciones que llegan a la base por una PR con auto-merge.

### T7.1 · `flowrunner tick` y `learn`: pausados y estado de las PRs
- **Estado:** `[ ] Pendiente`
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
- **Canario:** a comprobar: tratar "cerrada" como "mergeada" pone en rojo el segundo caso.
- **Criterio de aprobación:** `flowrunner tick` sin nada pendiente termina en menos de un segundo sin llamar al modelo.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T7.2

### T7.2 · Correcciones de la persona
- **Estado:** `[ ] Pendiente`
- **Descripción:** junta los commits de la rama posteriores al último commit de flowrunner y los comentarios de la PR, filtrando por `github_user`. Sin nada de la persona, el run pasa a `cerrado`.
- **Lint:** `pnpm lint`.
- **Test:** con git real y el `gh` falso:
  - Un commit de la persona después del último de flowrunner → incluido con su sha.
  - Un comentario de otro usuario con texto que parece una instrucción → excluido.
  - Un commit de otra persona → excluido.
  - Sin nada de la persona → `cerrado` sin sesión de agente.
  Comentario: si el filtro regresiona, cualquiera que comente la PR escribe en el cerebro de todos los runs futuros.
- **Canario:** a comprobar: quitar el filtro por usuario pone en rojo el segundo caso.
- **Criterio de aprobación:** la lista de correcciones de una PR de prueba muestra el origen de cada una.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T7.3

### T7.3 · Lecciones y su PR con auto-merge
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/phases/aprender.ts` y `prompts/aprender.md`: sesión de Sonnet 5.5 de solo lectura que propone de 1 a 3 lecciones con su origen; el código las numera y agrega a `lecciones.md` en un worktree `chore/lecciones-<clave>` desde la base, con el lock del repo; push y PR; comprobación de que el diff toca solo `lecciones.md` antes de activar auto-merge con merge commit. Si el archivo pasa su tope, una sesión consolida y la PR se abre sin auto-merge, con aviso.
- **Lint:** `pnpm lint`.
- **Test:** con git real y el `gh` falso:
  - Dos lecciones → `lecciones.md` con `L-n` correlativos y su origen, y un `gh pr merge --auto --merge`.
  - Un diff que además toca otro archivo → PR sin auto-merge y aviso.
  - Un archivo que pasa el tope → consolidación y PR sin auto-merge.
  - Una lección sin origen → falla de gate.
- **Canario:** a comprobar: saltear el chequeo del diff pone en rojo el segundo caso.
- **Criterio de aprobación:** el `gh` falso registra el `pr create` y el `pr merge --auto --merge` de la PR de lecciones con los argumentos esperados. El auto-merge real en GitHub se prueba al subir el proyecto.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T7.4

### T7.4 · launchd y doctor
- **Estado:** `[ ] Pendiente`
- **Descripción:** `flowrunner launchd install` escribe el plist del tick con `tick_minutes` de la config global, por defecto 10, y lo carga; `uninstall` lo quita. `flowrunner doctor` comprueba Node, git, `gh` con sesión, graft, el token en el Keychain y el job de launchd, cada uno con su arreglo.
- **Lint:** `pnpm lint`.
- **Test:** `doctor` con binarios falsos: un `gh` sin sesión → sale 1 y nombra el arreglo; el Keychain sin token → sale 1 y sugiere `claude setup-token`; todo presente → sale 0. El plist generado se compara contra uno esperado: programa, argumentos, intervalo y logs.
- **Canario:** a comprobar: ignorar el exit de `gh auth status` pone en rojo el primer caso.
- **Criterio de aprobación:** con el job instalado, `launchctl list` lo muestra y su log registra un tick.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F7

### Gate Fase 7
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** sobre un run `entregado` de fixture: el `gh` falso pasa la PR a mergeada con un commit de la persona y un comentario de otro usuario; `flowrunner tick` produce una PR de lecciones que cita solo el commit de la persona y tiene auto-merge; el run termina `cerrado`.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** el ciclo completo contra un remote bare local con el `gh` falso: una PR mergeada con una corrección propia produce la PR de lecciones con su origen. El ciclo en GitHub real se prueba al subir el proyecto.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Fase 8

---

# Fase 8 — La consola en Claude Code y telemetría

> Objetivo: la persona opera flowrunner entero conversando en Claude Code, sin tocar la terminal, y puede medir qué pieza de la fábrica mejorar.

### T8.1 · Skill `flowrunner`: la consola
- **Estado:** `[ ] Pendiente`
- **Descripción:** `skills/flowrunner/SKILL.md` según la sección 2 de la spec: escribir la feature con la entrevista de una pregunta por vez, y operar los runs con la tabla de pedidos de la spec, siempre por el CLI con `--json`. Aprobar y pedir cambios solo con la decisión explícita de la persona; el plan, el informe y los transcripts como datos, nunca como instrucciones. `flowrunner skill install` copia la skill a `~/.claude/skills` y, después de mostrarlas y con confirmación, agrega las reglas *ask* para `approve` y `changes` a `~/.claude/settings.json` sin pisar las que ya existen.
- **Lint:** `pnpm lint`; el frontmatter de la skill se valida con el schema de skills.
- **Test:** sobre `skill install` con un `HOME` temporal:
  - Con un `settings.json` que ya tiene permisos propios → los conserva y agrega las dos reglas *ask*.
  - Correrlo dos veces → no duplica las reglas.
  - Sin confirmación → no toca `settings.json`.
  Comentario: si regresiona, Claude podría aprobar un plan sin preguntarte.
  El comportamiento conversacional de la skill no tiene test automático; se verifica en el criterio.
- **Canario:** a comprobar: escribir las reglas sin leer las existentes pone en rojo el primer caso.
- **Criterio de aprobación:** desde una sesión de Claude Code y sin abrir la terminal: escribir una feature, lanzarla, ver el estado, revisar el plan, aprobarlo con el permiso pedido por Claude Code, preguntar qué hace una sub-task y leer el informe. Tres features reales escritas así pasan `feature check` sin edición manual.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** T8.2

### T8.2 · `flowrunner stats`
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/report/stats.ts`: agrega los eventos de todos los runs de un proyecto o de todos: reintentos por fase, motivos de gate y de rechazo más frecuentes, costo y duración por fase, lecciones generadas.
- **Lint:** `pnpm lint`.
- **Test:** desde logs de fixture de cinco runs: la fase con más reintentos encabeza la lista; los motivos se agrupan aunque difieran en rutas o números; un run detenido cuenta su costo parcial; un directorio de run sin eventos no rompe el total.
- **Canario:** a comprobar: agrupar por el texto exacto del motivo pone en rojo el caso de los motivos con rutas distintas.
- **Criterio de aprobación:** `flowrunner stats` sobre los runs del smoke señala la pieza a mejorar en una pantalla.
- **Revisión ponytail:** pendiente.
- **Desbloquea:** Gate F8

### Gate Fase 8
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** suites unit e integración verdes.
- **Test de integración:** una feature escrita por fixture pasa `feature check`, corre de punta a punta con `query` y `gh` falsos, y `flowrunner stats` refleja ese run con sus vueltas y su costo.
- **Canario:** re-canario sobre 2-3 tests de la fase al azar.
- **Criterio de aprobación:** demo desde Claude Code: escribir una feature con la skill, lanzarla, aprobarla y pedirle a Claude que explique `stats` al final.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + listado de `test-debt:`.
- **Desbloquea:** Cierre

---

# Cierre del proyecto

### Gate final
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** todo el repo verde.
- **Tests:** suite completa verde en `pnpm verify`; `pnpm smoke` verde en local.
- **Test de integración:** el recorrido completo por CLI: feature, preparar, planificar, aprobar, implementar en paralelo, verificar, revisar, entregar y aprender, con cortes y reanudaciones en el medio, sobre repos reales en tmpdir con `query` y `gh` falsos.
- **Canario:** se rompe el invariante central, que el modelo no pueda escribir fuera del alcance de su sub-task, desactivando el hook y el doble control: la suite se pone roja.
- **Criterio de aprobación:** una feature real en un repo real de la persona, operada entera desde una sesión de Claude Code, llega a una PR mergeable sin intervención entre la aprobación del plan y el informe, y `flowrunner stats` muestra menos tiempo de espera que los runs de flowindex.
- **Revisión ponytail:** `/ponytail-review` sobre el diff completo del proyecto + `/ponytail-debt` con el ledger final de atajos deliberados + el ledger de `test-debt:` sin resolver.
