# Varios runs por repo

Estado: diseño aprobado en la conversación · 2026-11-09 · ADR 0019

## Problema

Hoy un repo admite un run a la vez (`src/store/lock.ts`). El lock se toma al lanzar y se suelta al
llegar a `entregado` o a un estado terminal. Un run en `esperando_aprobacion` o `pausado_por_limite`
lo conserva aunque no tenga proceso. Eso trae dos problemas:

1. **Un run que espera bloquea el repo.** Mientras un plan espera aprobación, no se puede lanzar
   ninguna otra feature, aunque no se esté gastando nada.
2. **No se pueden avanzar dos o tres features del mismo repo a la vez.**

El lock no garantiza que las lecciones de un run lleguen antes de que planifique el siguiente: se
suelta en `entregado`, antes del merge, y cada run lee las lecciones de su worktree desde
`origin/<base>`. Relajarlo no empeora eso.

Lo que el lock sí evita hoy, y este diseño tiene que seguir evitando:

- **El entorno compartido.** `verify` y los comandos de criterio pueden usar puertos fijos o una base
  local como el Supabase del ADR 0018. `probar` levanta el entorno en las `probar.urls` de la config y
  se detiene si ya responden (`src/probar/entorno.ts:57`).
- **El `.git` compartido.** `fetch`, `worktree add`, `worktree remove` y `worktree prune` corren sobre
  el checkout de la persona.
- **La PR de lecciones.** `aprender` toma el lock del repo con el id `<run>-lecciones`
  (`src/phases/aprender.ts:159`). Dos publicaciones a la vez se pisarían en `.flowrunner/lecciones.md`.

## Decisión

Lugares por repo con tope y cola, más turnos cortos con nombre para lo compartido. No hay proceso
nuevo: cada run sigue siendo su propio proceso (ADR 0010) y `tick` sigue siendo el respaldo.

Alternativas descartadas:

- **Un planificador de larga vida por repo.** Es una pieza que tiene que estar viva siempre, y
  contradice el ADR 0010.
- **Un solo lock, tomado solo en las fases que chocan.** No da tope ni cola.
- **Un entorno por run, con puertos asignados.** Obliga a cada repo a adaptar su config, y una base
  local tipo Supabase en general no se duplica. Lo caro de un run son los agentes, no `verify` ni
  `probar`, así que hacer fila en esas fases cuesta poco.

## 1. Lugares

- **`max_runs`** en `.flowrunner/config.yaml`: entero de 1 a 8, por defecto 2. Con 1 hay un solo run
  activo como hoy, pero los runs en espera no ocupan lugar y el que no entra queda en cola en vez de
  negarse. `max_parallel` no cambia.
- **Ocupa lugar** un run cuyo `holderStatus` (`src/store/runs.ts:66`) es `activo`. No lo ocupan los
  que están `esperando` (`esperando_aprobacion`, `pausado_por_limite`), `en_cola`, los terminados ni
  los `entregado`. `holderStatus` devuelve `esperando` para `en_cola`.
- **Un lugar vale solo si su run está `activo` y su pid vive.** Cualquier otro se borra al contar. Es
  más estricto que el `isStale` de hoy, que conserva el lock de un run en espera: con esta regla, un
  proceso que se corta justo antes de soltar el lugar al pasar a esperar no lo deja tomado.
- **En disco:** `~/.flowrunner/locks/<proyecto>/lugares/<runId>.json`, con `{ run_id, pid }` (el
  esquema de hoy).
- **Tomar un lugar** pasa bajo un lock corto, `locks/<proyecto>/lugares.lock` (`wx` con el pid; se
  pisa si su pid murió o el archivo no se lee). Adentro: se borran los lugares que no valen, se
  cuentan los demás, y si son menos que `max_runs` se escribe el propio. Un run
  que ya tiene su lugar lo reescribe con el pid nuevo, que es lo que hace `handOver` hoy.
- **Soltar un lugar:** `runProcess` lo suelta al terminar si el run no quedó `activo` (pasó a esperar,
  se entregó, terminó o se detuvo), y `abort` lo suelta siempre. Son los dos lugares donde hoy se
  llama a `releaseLock` (`src/cli/runs.ts:231`, `:251`); cambia la condición de `:251`, que hoy solo
  suelta si el run terminó.
- **Volver de una espera** (`approve`, `changes`, el `tick` que retoma una pausa) pide lugar de nuevo.
  Si no hay, el run va a la cola.
- **Migración:** si existe el archivo viejo `locks/<proyecto>.lock`, se convierte en un lugar con el
  mismo contenido la primera vez que se toca el directorio del proyecto, y se borra.

## 2. Cola

- **Estado `en_cola`**, que sale del evento nuevo `encolado` (con `at`). Termina con `reanudado`, que
  ya existe, cuando el run consigue lugar. El reductor del engine y todo lo que enumera estados lo
  incorpora: `src/engine/engine.ts`, `src/store/runs.ts`, `src/cli/contracts.ts`, `src/cli/runs.ts`,
  `src/cli/tick.ts`, `src/watch/render.ts`, `orca/src/runs.ts` y la skill.
- **Entran en la cola** los comandos que lanzan o retoman el proceso de un run y no encuentran
  lugar: `run`, `approve`, `changes`, `resume`, `rerun` y la reanudación de `tick`. Anotan
  `encolado` y responden con `ok: true`, la acción `en cola, <n>.º — corren <ids>` y el campo
  `cola: { posicion, corriendo }`.
- **Orden:** primero el run en cola con el `run_creado` más viejo. Un run que ya pasó por
  planificar y vuelve a la cola pasa antes que uno recién lanzado.
- **`despacharCola(home, proyecto)`:** bajo `lugares.lock`, recorre los runs en cola del más viejo
  al más nuevo mientras haya lugar; a cada uno le reserva el lugar con su propio pid, anota
  `reanudado` y lo lanza con `handOver`. Se llama:
  1. en un `finally` al final de `runProcess`, salga como salga;
  2. en `abort`, después de soltar el lugar;
  3. en cada `tick`, como respaldo: la cola nunca queda trabada más de `tick_minutes`.
- **Un run en cola no tiene proceso.** Es un estado en su log, como `esperando_aprobacion`.
- **Abortar un run en cola** lo deja `abortado`. No tiene worktrees que borrar.

## 3. Turnos

Una primitiva, `conTurno(home, proyecto, nombre, runId, fn)`:

- Toma `locks/<proyecto>/<nombre>.lock` con `wx` y `{ run_id, pid }`, corre `fn` y suelta en un
  `finally`.
- El turno está vencido si su pid murió o el archivo no se lee. Quien espera un turno siempre tiene
  un proceso vivo, así que no hay espera sin proceso.
- Mientras espera, revisa con un intervalo que crece de 2 a 15 segundos, y anota **un** `aviso` con
  la fase: `esperando el turno de <nombre>: lo tiene <runId>`.
- **La espera tiene un límite de 2 horas.** Cumplido, la fase devuelve
  `{ tipo: "falla", clase: "entorno" }` con el motivo y `flowrunner resume <run>`. El reloj y el
  límite se inyectan para los tests.

| Turno | Cubre | Por qué |
|---|---|---|
| `entorno` | `runVerify` en preparar (`src/phases/preparar.ts:59`), en verificar (`src/phases/verificar.ts:206`) y en init (`src/setup/init.ts:221`); cada llamada a `runCriteria` en verificar; la fase `probar` desde antes de `levantarEntorno` hasta después de bajar | puertos fijos, base local, URLs de `probar` |
| `git` | `fetchOrigin`, `addWorktree` y `removeWorktree` (`src/git/git.ts`) | `.git/worktrees` y los refs son del checkout compartido; dura segundos |
| `lecciones` | la publicación de `aprender`: worktree, commit, push y PR | dos PRs de lecciones se pisarían en `lecciones.md` |

- En verificar, el turno va alrededor de cada tanda de comandos y no de la fase entera: entre tanda
  y tanda pueden correr las sesiones de diagnosticar y reparar, que son de agente y largas.
- `aprender` deja de tomar el lock del repo y toma el turno `lecciones`. Si está ocupado, devuelve
  `espera` sin esperar, como hoy, y el próximo `tick` reintenta.
- El chequeo de `probar` de "ya hay algo respondiendo antes de levantar" se queda. Con el turno ya
  no lo dispara otro run, solo un entorno de la persona que quedó prendido.
- `git` es el turno más interno: ningún código que tenga el turno `git` pide otro. Así no hay un
  orden de toma que pueda trabarse.

Quedan afuera a propósito:

- **Los comandos de criterio de implementar.** Ya corren en paralelo entre sub-tasks del mismo run
  (`max_parallel`). Un repo donde esos comandos chocan ya está roto hoy.
- **`setup`.** Instala en el `node_modules` de cada worktree; el store de pnpm o npm tolera la
  concurrencia.

## 4. Aviso al aprobar el plan

- **`se_pisa_con`** en `planViewSchema` (`src/cli/approval.ts:21`):
  `Array<{ run: string; status: string; pr: number | null; archivos: string[] }>`.
- **Se compara** el alcance efectivo de cada sub-task (`effectiveScope`, `src/gates/plan.ts:94`)
  con el de los otros runs del mismo proyecto que tienen `plan.md` y no están `cerrado` ni
  `abortado`. Eso incluye `entregado`: soltó su lugar, pero su PR puede seguir abierta. Para la
  comparación se exporta `overlaps` de `src/gates/plan.ts` y se reusa.
- **`archivos`** son las rutas del plan que se está mirando que se pisan con alguna del otro run.
- **Se muestra** en `describePlan`, en la skill y en el panel de Orca, antes de aprobar.
- **No bloquea** ni pide un flag. Es otra cosa que `cambia_lo_existente`, que pide
  `--acepto-cambios`.
- El aviso sale en el plan que se aprueba segundo; no se vuelve a avisar sobre un plan ya aprobado.

## 5. Fallas

- **Muere un proceso con lugar o turno:** su pid queda muerto y el próximo que intenta tomar ese
  lugar o turno lo da por vencido. La cola se despacha en el próximo `tick` aunque nadie lo haya
  hecho.
- **Archivo de lugar, de turno o `lugares.lock` corrupto:** `readLock` devuelve `undefined` y se
  trata como vencido.
- **Bajar `max_runs` con runs corriendo:** los que tienen lugar lo conservan; los nuevos esperan a
  que el conteo baje.
- **Abortar un run que espera un turno:** recibe SIGTERM como hoy y el `finally` suelta el turno.
- **Dos tomas de lugar simultáneas:** `lugares.lock` las serializa; nunca entran más de `max_runs`.

## 6. Tests

Cada test nuevo se muestra fallando contra `main` antes del cambio.

Unitarios:

- `src/store/lugares.test.ts`: con tope 2 el tercero no consigue lugar; un lugar con pid muerto se
  libera; un lugar de un run `esperando` o `en_cola` se libera aunque su pid viva; dos tomas concurrentes con un lugar libre dejan entrar
  exactamente una; el lock viejo se migra a un lugar.
- `src/store/turno.test.ts`: espera mientras el dueño vive; toma si el dueño murió; suelta aunque
  `fn` tire; falla al cumplirse el límite, con reloj inyectado; anota un solo aviso.
- `src/cli/approval.test.ts` o el del módulo que calcule `se_pisa_con`: archivo igual, carpeta que
  contiene, sin choque; `entregado` incluido, `cerrado` y `abortado` excluidos.

Integración (`test/varios-runs.int.test.ts`, con `test/hooks/fake-phases.ts`):

- Dos runs del mismo repo llegan los dos a `esperando_aprobacion`. Contra `main`, el segundo se
  niega.
- Con `max_runs: 1`, el segundo queda `en_cola` y arranca solo cuando el primero se entrega.
- Un run en `esperando_aprobacion` no bloquea a otro con `max_runs: 1`.
- Dos runs en verificar nunca tienen el turno `entorno` a la vez: las fases falsas anotan su
  intervalo y el test comprueba que no se superponen.
- `tick` despacha la cola cuando el proceso que tenía que hacerlo murió.

Cambio de contrato: los tests de `test/cli-runs.int.test.ts` que esperan "ya tiene un run en curso"
pasan a esperar `en_cola`. No es un test debilitado; la PR lo nombra así.

## Fuera de alcance

- Puertos o entornos por run.
- Avisar sobre el choque de alcances en el plan aprobado primero.
- Un tope global de runs entre repos.
- Orden de lecciones entre runs (no lo garantizaba el lock y sigue sin garantizarse).
