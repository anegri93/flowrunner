# Tareas de construcción — flowrunner 2.0

Plan de tareas atómicas, secuenciadas y verificables para **flowrunner 2.0**: la conversación de la feature decide, el plan ejecuta, y el run solo te para cuando la decisión es tuya. Fuente: el análisis de los 33 runs de `pizarra-en-vivo` (PIZ-2 a PIZ-53) del 19-11-2026 y la propuesta publicada como artifact «La fábrica flowrunner propuesta».
Cada tarea desbloquea a la siguiente; cada fase cierra con un **gate** que desbloquea la fase posterior.

## Qué entra y qué no

- **Entra:** el ping pong profundo de la skill (Fase 1), que el planificador pregunte en vez de decidir producto (Fase 1), aprobar solo cuando hace falta (Fase 1), tres ajustes chicos (Fase 2), que el aprendizaje salga también de las preguntas y de lo que descubre el que implementa (Fase 3), el experimento de una sola sesión de Opus (Fase 4) y la medición contra la línea de base y contra Claude Code directo (Fases 0 y 5).
- **No entra:** el sandbox del sistema operativo para sacar las reglas de heredoc, `sed`, scripts y variables (ADR 0021 las pone para poder comprobar el alcance; hoy cuestan unos 4 turnos por run), y probar (ya resuelto por ADR 0032 y 0036).

## Cómo usar este documento

- Cada tarea tiene: **Título**, **Descripción**, **Estado**, **Lint**, **Test**, **Canario**, **Criterio de aprobación** y **Revisión ponytail**.
- Una tarea pasa a `Hecho` solo cuando su lint, su test con el **canario** comprobado, su criterio y su revisión ponytail están verdes.
- **Test** = automatizado, corre en `pnpm verify`. **Criterio de aprobación** = condición observable, puede ser manual. Si ambos dicen lo mismo, uno es humo.
- Los tests van sobre **salidas observables**: valor devuelto, estado persistido, evento en el log, efecto real; no sobre "se llamó al mock".
- **Canario** = se rompió el código a propósito y se confirmó que el test se pone **rojo**. En las tareas pendientes el campo dice la mutación prevista; al cerrar la tarea se reemplaza por lo que pasó.
- Si el borde es conocido antes de escribir el código, **el test va primero**.
- **`Test: N/A` es una salida válida** cuando no hay borde que afirmar: se escribe la razón y la verificación alternativa. Máximo uno por fase.
- Cobertura omitida a propósito dentro de una tarea con test → comentario `test-debt:` en el código nombrando el riesgo. El gate los lista.
- **Revisión ponytail** = `/ponytail-review` sobre el diff: abstracción especulativa, dependencia evitable, stdlib reinventada, flexibilidad muerta. Por tarea sobre su diff; por fase sobre el diff acumulado.
- No se arranca una tarea hasta que su predecesora, la que la **desbloquea**, está en `Hecho`.
- El **gate de fase** aporta lo que ninguna tarea puede: un **test de integración** del ensamblado, un **re-canario** sobre 2-3 tests de la fase al azar y la revisión ponytail acumulada.
- Bug de una fase anterior descubierto después → tarea insertada `TX.Yb` con **Regresión de:**.
- Cada tarea es una rama `<tipo>/<slug>` desde `main`, una PR y un merge commit, como las PRs #126 a #128. El `.md` se actualiza en la misma PR de la tarea. Una decisión de diseño lleva su ADR en `docs/adr/` en la misma PR, con Contexto, Decisión, Alternativas descartadas y Verificación.
- Todo comportamiento nuevo entra detrás de una opción de config con el valor de hoy por defecto, o se congela en `run_creado`: un run viejo se reduce igual (C8).

**Decisiones tomadas (19-11-2026):**

- Con `aprobar: si_hace_falta`, los cambios a lo que ya existe no se ven antes de implementar: se aceptan por el criterio de la feature que citan y la persona los ve en la PR. Lo aceptó la persona: lo que se lee y se decide es el ping pong de la feature, no el plan.
- Los criterios de aprobación que piden a la persona o runs reales de pizarra-en-vivo no frenan la fase siguiente: quedan anotados como «criterio de la persona pendiente» y se verifican juntos al cierre. Los tests, el lint, los canarios y la revisión ponytail sí frenan.
- Orca entra en esta versión: `responder` se ofrece en Orca igual que en el CLI y la skill (T1.5).

**Estados:** `[ ] Pendiente` · `[~] En progreso` · `[x] Hecho` · `[!] Bloqueado`

**Verificación (global):** `pnpm verify` = `pnpm lint && pnpm test && pnpm test:integration`, en local.

**Convención de lint (global):** `pnpm lint` = `eslint .` (`typescript-eslint` `strict-type-checked`) + `prettier --check .` + `tsc --noEmit` con `strict`, `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`. Sin `any` sin justificación escrita. Sin warnings nuevos en archivos tocados.

**Convención de test (global):** `pnpm test` = `vitest run --project unit` (`src/**/*.test.ts`), sin red y sin gastar suscripción. **Se mockea solo en los límites de confianza:** la sesión del Agent SDK (`query`, el modelo), `gh`, el registro de npm (`deps.registro`) y el reloj. **No se mockea:** el engine y su reductor, los gates, el parser de la feature, la política de comandos, el filesystem (se usa un `tempDir` real) ni git.

**Convención de integración (global):** `pnpm test:integration` = `vitest run --project integration` (`test/**/*.int.test.ts`): git real en repos temporales (`test/helpers/git.ts`), el CLI como proceso hijo, `query` y `gh` falsos (`test/helpers/project.ts`, `testDeps`). No levanta servicios. Un test de integración de gate recorre el run por el CLI, con el log de eventos como evidencia.

**Medición (global):** `flowrunner stats --runs pizarra-en-vivo`. La línea de base es la versión actual de flowrunner, no los 33 runs: PIZ-44 a PIZ-53 (`vueltas: 3`, `vuelta_directa: true`).

---

# Fase 0 — Línea de base y protocolo

> Objetivo: que haya contra qué medir antes de tocar nada, y una forma de comparar con Claude Code directo.

### T0.1 · Línea de base de la versión actual y protocolo de comparación
- **Estado:** `[x] Hecho`
- **Descripción:** escribir `docs/flowrunner-2/medicion.md` con: (a) la línea de base de PIZ-44 a PIZ-53 sacada de `flowrunner stats --runs` y de los `events.jsonl`: mediana y p90 de punta a punta, vueltas por run, rechazos por run, costo, runs sin vueltas, aclaraciones por feature, preguntas del planificador por run (hoy no existen; en 2.0 tienen que bajar con el tiempo si el aprendizaje funciona) y lecciones nuevas por run; (b) el protocolo para una feature hecha directo en Claude Code: el mismo `feature.md` escrito con la skill, una sesión de Claude Code sin flowrunner, y se anota tiempo hasta la PR, costo de la sesión, cuántas veces hubo que corregirla y los bugs que aparecen en la semana después del merge. La misma planilla sirve para las dos formas.
- **Lint:** `pnpm lint` verde (prettier sobre el `.md`).
- **Test:** N/A — es un documento de medición, sin código; verificación: cada número de la línea de base se reproduce corriendo `flowrunner stats --runs pizarra-en-vivo` y el script de la planilla sobre los mismos runs.
- **Canario:** N/A — sin test; el riesgo de un número mal copiado lo cubre la verificación de arriba.
- **Criterio de aprobación:** `medicion.md` tiene la línea de base de 10 runs y una planilla vacía con las mismas columnas para "flowrunner 2.0" y "Claude Code directo".
- **Revisión ponytail:** revisión a mano contra la escalera: sin scripts nuevos; los números salen de `flowrunner stats --runs`, `grep` y el log de eventos. Se sacó el tiempo de pared, que pedía un script propio y no lo da `stats`. Sin hallazgos abiertos.
- **Desbloquea:** Gate Fase 0

### Gate Fase 0
- **Estado:** `[x] Hecho` — criterio de la persona pendiente
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde (nada cambió en el código).
- **Test de integración:** N/A — la fase no tiene código; el siguiente gate con código es el de la Fase 1.
- **Canario:** N/A — sin tests nuevos.
- **Criterio de aprobación:** la persona lee `medicion.md` y está de acuerdo con las columnas y la línea de base.
- **Revisión ponytail:** igual que T0.1: solo documentación, sin hallazgos.
- **Desbloquea:** Fase 1

---

# Fase 1 — La conversación decide

> Objetivo: que las decisiones de producto se tomen en el ping pong de la feature (funcionalidad, errores, casos borde, lo que cambia y propuestas), que el planificador pregunte en vez de decidir producto, y que aprobar el plan sea opcional.

### T1.1 · Aclaraciones con tema, y feature check avisa lo que faltó preguntar
- **Estado:** `[x] Hecho`
- **Descripción:** el parser de la feature (`src/feature/`) acepta un tema opcional en cada aclaración: `- P (funcionalidad|error|borde|existente|propuesta): … R: …`. Una aclaración sin tema se sigue leyendo igual. `feature check` (`src/cli/feature-check.ts`) suma dos avisos, que no frenan: "no hay ninguna aclaración de errores" y "no hay ninguna aclaración de casos borde". El resumen cuenta las aclaraciones por tema. `src/prompts/render.ts` pasa el tema al planificador.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/cli/feature-check.test.ts` y en el test del parser: (1) una feature sin aclaraciones de `error` ni `borde` da los dos avisos y `ok: true`; (2) una feature con las dos no da avisos; (3) una aclaración vieja sin tema se parsea con tema `null` y no da error; (4) un tema que no existe (`P (otro):`) es un error de `feature check` con el motivo. Afirma sobre la salida JSON de `feature check`.
- **Canario:** hecho: (a) el aviso de casos borde mirando el tema `error` → el test de avisos se puso rojo; (b) aceptar cualquier tema (`else if (true)`) → el test del tema que no existe se puso rojo. Restaurado.
- **Criterio de aprobación:** `flowrunner feature check` sobre PIZ-21 (una sola aclaración) muestra los dos avisos; sobre PIZ-50 cuenta sus 7 aclaraciones.
- **Revisión ponytail:** a mano contra la escalera: el tema es un string de una lista cerrada (`TEMAS`), con un type guard en vez de un cast; `porTema` es la única función nueva fuera de lo pedido y la pide el criterio (el resumen cuenta por tema). Sin hallazgos abiertos. Nota: `test/fase0.int.test.ts` suma dos aclaraciones con tema a su feature para que sus asserts sigan midiendo solo lo suyo.
- **Desbloquea:** T1.2

### T1.2 · La skill recorre los cinco temas en el ping pong
- **Estado:** `[x] Hecho` — criterio de la persona pendiente
- **Descripción:** reescribir el paso 3 de `skills/flowrunner/SKILL.md`. Sigue siendo una pregunta por vez y con una respuesta propuesta, pero recorre los temas en orden: funcionalidad (el camino feliz paso a paso), errores (qué falla y qué ve la persona), casos borde (la skill los arma leyendo el código: lo que ya existe y se cruza con la feature, como grupos, pestaña oculta, datos viejos, otro formato), lo que cambia de lo que ya existe, y propuestas (alternativas con una recomendación). Cada respuesta va a Aclaraciones con su tema y, si se puede comprobar con un comando, también como criterio. Se saca la frase "las dudas de cómo construirlo no se preguntan" y se reemplaza por: "lo técnico lo decide el planificador; lo que cambia lo que la persona ve o usa, se pregunta acá".
- **Lint:** `pnpm lint` verde (prettier sobre el `.md`).
- **Test:** N/A — es texto de la skill que lee un modelo, no hay salida que afirmar sin gastar suscripción; verificación: una conversación real con la skill sobre una feature nueva de pizarra-en-vivo termina en un `feature.md` con aclaraciones de los cinco temas y `feature check` sin los avisos de T1.1.
- **Canario:** N/A — sin test; el aviso de T1.1 es el control automático de que la conversación cubrió errores y casos borde.
- **Criterio de aprobación:** la persona hace el ping pong de una feature real y dice que las preguntas fueron las que importan; `feature check` sale sin avisos de tema.
- **Revisión ponytail:** a mano: el paso 3 crece 11 líneas y se saca la frase «las dudas de cómo construirlo no se preguntan»; el formato de Aclaraciones y los avisos de feature check suman una línea cada uno. Sin hallazgos abiertos.
- **Desbloquea:** T1.3

### T1.3 · El planificador pregunta en vez de decidir producto
- **Estado:** `[x] Hecho`
- **Descripción:** la salida del planificador (`salidaPlanSchema`, `src/gates/plan.ts:119`, que usa `src/phases/planificar.ts`) suma `preguntas: { pregunta, propuesta, tema }[]`, opcional. El prompt dice: si el plan necesita una decisión que cambia lo que la persona ve o usa y las Aclaraciones no la cubren, no la decidas: devolvela en `preguntas` con tu propuesta. Con al menos una pregunta, planificar devuelve el outcome `pregunta` (ADR 0023), el run se detiene antes de aprobar y el plan no se escribe para implementar. ADR nuevo: "La conversación decide, el plan ejecuta".
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/planificar.test.ts`, «el planificador pregunta lo que la feature no cubre», con la sesión falsa: (1) una salida con `preguntas` da `pregunta` con cada una y su propuesta en el motivo, no escribe el plan y deja la sesión marcada para retomar; (2) con preguntas, el plan entero de la misma salida no se usa; (3) con `preguntas: []` el plan sigue como hoy. Una pregunta sin `propuesta` no llega al gate: el schema de la salida estructurada la exige.
- **Canario:** hecho: usar las preguntas solo si no vino plan (`result.output.plan === undefined`) → el test (2) se puso rojo. Restaurado.
- **Criterio de aprobación:** el ADR está en `docs/adr/` y `flowrunner status` de un run detenido así muestra cada pregunta con su propuesta.
- **Revisión ponytail:** a mano: reusa `pregunta`, `halt()` y la marca de sesión de ADR 0025; un schema, un archivo con las preguntas para T1.4 y una función de texto. Sin estado nuevo en el engine. Sin hallazgos abiertos.
- **Desbloquea:** T1.4

### T1.4 · `flowrunner responder` agrega la aclaración y retoma al planificador
- **Estado:** `[x] Hecho`
- **Descripción:** comando nuevo `flowrunner responder <run> "<respuesta>" [--origen]`. Vale solo si el halt actual es una pregunta de planificar (`opcionesDe` lo ofrece primero, junto a `rerun --desde planificar` y `abort`). Escribe un evento `respondido`, agrega la aclaración a la copia de la feature del run (`- P (<tema>): <pregunta> R: <respuesta>`) y vuelve a planificar retomando la misma sesión con la respuesta, como el reintento tras el gate (ADR 0025). Lo respondido aparece en "Tus decisiones" del informe. La skill ofrece la respuesta; Orca, en T1.5.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero: `src/engine/engine.test.ts` «una pregunta de planificar ofrece responder primero…» (las opciones son responder, replanificar y abortar; `respondido` vuelve a planificar con la respuesta como instrucción; fuera de esa detención no hace nada); `src/phases/planificar.test.ts` «con la respuesta, planificar retoma la misma sesión y la suma a la feature del run»; `src/feature/feature.test.ts` «sumarAclaraciones» (una sola vez, en un renglón, crea la sección); `test/pregunta.int.test.ts` «una pregunta de planificar se contesta con responder» (CLI real: respuesta vacía sale 1 y no escribe, `accept` no se ofrece, con respuesta el run llega a entregado y planificar corre dos veces).
- **Canario:** hecho: que el reductor acepte `respondido` en cualquier detención → el test del engine se puso rojo. Restaurado.
- **Criterio de aprobación:** con un run de prueba detenido por una pregunta, `responder` lo destraba y el plan nuevo cita la aclaración.
- **Revisión ponytail:** a mano: reusa `halt`, `offers`, `conTurnoSync`, `launchAnswer` y la sesión marcada de ADR 0025; `intentoRetomado` pasa a recibir el prompt en vez del motivo para servir a los dos casos. La respuesta se suma a la feature en planificar y no en el CLI: así un plan de cero, si la sesión no se puede retomar, también la ve. Sin hallazgos abiertos.
- **Desbloquea:** T1.5

### T1.5 · Orca ofrece responder la pregunta del planificador
- **Estado:** `[x] Hecho` — criterio de la persona pendiente
- **Descripción:** en Orca, un run detenido por una pregunta de planificar muestra el motivo (cada pregunta con su propuesta) y un botón «Responder» que abre un campo para la respuesta. Suma la acción `responder` a `Decision`, a `offers` y a `stoppedDecisions` (`orca/src/runs.ts`), el formulario y el botón en `orca/src/vista.ts`, y la traducción en `orca/src/worker.ts`: `flowrunner responder <run> "<respuesta>" --origen orca`. Simplificación: el campo no viene con la propuesta ya escrita, porque Orca recibe las preguntas solo dentro del motivo; el placeholder dice «va la propuesta». Las otras opciones de esa detención (rehacer, abortar) siguen como hoy.
- **Lint:** `pnpm lint` verde y `orca plugin test` verde (122/122).
- **Test:** test primero: `orca/src/runs.test.ts` «un run detenido por una pregunta del planificador ofrece responder y rehacer, nada más»; `orca/src/worker.test.ts` «responder se traduce a responder con --origen orca, y una respuesta vacía se rechaza».
- **Canario:** hecho: sacar `offers(run, "responder")` de `stoppedDecisions` → el test de runs se puso rojo. Restaurado.
- **Criterio de aprobación:** con un run de prueba detenido por una pregunta, se responde desde Orca y el run sigue a planificar.
- **Revisión ponytail:** a mano: reusa el patrón de `aceptar` (acción, `pedirTexto`, `personText`); sin componentes nuevos. Sin hallazgos abiertos.
- **Desbloquea:** T1.6

### T1.6 · Aprobar solo cuando hace falta
- **Estado:** `[ ] Pendiente`
- **Descripción:** opción `aprobar: siempre | si_hace_falta` en la config del repo (por defecto `siempre`), congelada en `run_creado`. Con `si_hace_falta`, la fase aprobar (`src/phases/aprobar.ts`) sigue fijando versiones y: si alguna dependencia queda sin versión, se detiene con una pregunta (no hay nada que aprobar sin decidirlo); si no, escribe `aprobado` con `origen: "flowrunner"` y sigue a implementar. Hoy `aprobado` solo acepta `terminal`, `claude` u `orca` (`origenSchema`, `src/store/events.ts:88`); se amplía como ya se hizo con `origenAutofixSchema`, sin tocar el `--origen` del CLI. Los cambios a lo que existe se aceptan por el criterio que citan y van, como hoy, en la PR y en el informe con "aceptado por AC-n". `skip-probar` sigue disponible para saltear probar sin aprobar. ADR nuevo.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/aprobar.test.ts` y `src/engine/engine.test.ts`: (1) con `si_hace_falta` y versiones resueltas, el log tiene `aprobado` de origen `flowrunner` y la fase siguiente es implementar; (2) con una dependencia sin versión se detiene y no hay `aprobado`; (3) con `siempre` espera como hoy; (4) un run creado sin el campo espera como hoy.
- **Canario:** mutación prevista: que `si_hace_falta` apruebe también con una dependencia sin versión; el test (2) tiene que ponerse rojo.
- **Criterio de aprobación:** en pizarra-en-vivo con `aprobar: si_hace_falta`, un run pasa de planificar a implementar sin esperar, y el informe dice "aprobado por flowrunner" con los cambios aceptados y su criterio.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; dos valores, sin una política configurable.
- **Desbloquea:** Gate Fase 1

### Gate Fase 1
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** un test nuevo en `test/` que recorre por el CLI: `feature check` de una feature con temas → `run` con `aprobar: si_hace_falta` → el planificador falso devuelve una pregunta → el run se detiene → `responder` → el planificador falso retoma la misma sesión y devuelve un plan sin preguntas → aprobar sigue sola → implementar arranca. Afirma sobre el log de eventos y la feature del run.
- **Canario:** re-canario sobre 3 tests de la fase al azar: se rompieron, se pusieron rojos, se restauraron.
- **Criterio de aprobación:** una feature real de pizarra-en-vivo: ping pong con la skill nueva, el run no espera aprobación y llega a la PR. Si el planificador pregunta, la respuesta destraba el run.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado de la fase + `/ponytail-debt` + listado de `test-debt:` nuevos.
- **Desbloquea:** Fase 2

---

# Fase 2 — Ajustes chicos

> Objetivo: sacar lo que hoy cuesta turnos o vueltas sin proteger nada.

### T2.1 · Sacar el límite de 200 líneas de Read
- **Estado:** `[ ] Pendiente`
- **Descripción:** sacar `LECTURA_ENTERA_MAX` y su chequeo de `src/tripwires/hook.ts:46-71`, y la frase que lo describe en los prompts de las fases. Se queda el resto del hook de Read: rutas fuera del worktree y `env_files`. Fueron 14 rechazos en los 33 runs y 11 en los últimos 10.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en el test del hook: (1) un Read sin `offset` de un archivo de 500 líneas dentro del worktree se permite; (2) un Read de un archivo fuera del worktree se sigue rechazando con su motivo; (3) un Read de un `env_file` se sigue rechazando.
- **Canario:** mutación prevista: volver a poner el chequeo de largo; el test (1) tiene que ponerse rojo. Y sacar el chequeo de worktree; el test (2) tiene que ponerse rojo.
- **Criterio de aprobación:** `grep -rn "LECTURA_ENTERA_MAX\|leé solo el rango" src` no encuentra nada.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; solo borra.
- **Desbloquea:** T2.2

### T2.2 · Revisar pregunta directo cuando el arreglo es una decisión tuya
- **Estado:** `[ ] Pendiente`
- **Descripción:** el hallazgo de revisar (`findingSchema`, `src/phases/revisar.ts:22`) suma `decision: boolean`, opcional. El prompt la define: el arreglo tiene más de una salida razonable y elegir es de la persona (subir el Node mínimo, sumar o cambiar una dependencia, cambiar un contrato o el alcance). Un bloqueante con `decision: true` devuelve `pregunta` sin pasar por la vuelta directa (ADR 0030), con las salidas que propone el revisor en el motivo. Caso de referencia: PIZ-3 y `unpdf`/Node 24. Se agrega al ADR 0030 como enmienda.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/revisar.test.ts`: (1) una revisión con un bloqueante `decision: true` da `pregunta` y no `vuelve`, aunque haya vueltas disponibles; (2) un bloqueante sin el campo vuelve como hoy; (3) una mezcla de un bloqueante de código y uno de decisión da `pregunta` con los dos en el motivo.
- **Canario:** mutación prevista: que `decision` solo cuente si es el único bloqueante; el test (3) tiene que ponerse rojo.
- **Criterio de aprobación:** con la revisión falsa de PIZ-3, `flowrunner status` muestra la pregunta con las dos salidas y `accept` con motivo sigue a probar.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; un booleano, sin una taxonomía de hallazgos.
- **Desbloquea:** T2.3

### T2.3 · pizarra-en-vivo pasa a `vueltas: 1` y `aprobar: si_hace_falta`
- **Estado:** `[ ] Pendiente`
- **Descripción:** PR en `pizarra-en-vivo` que cambia `.flowrunner/config.yaml`: `vueltas: 3` → `1` (la vuelta directa de ADR 0030 ya cubre la primera; con 3 se repiten bloqueantes) y `aprobar: si_hace_falta`. El comentario de cada clave dice por qué, con los runs de evidencia.
- **Lint:** `flowrunner doctor` sobre pizarra-en-vivo sin errores de config.
- **Test:** N/A — es un valor de config en otro repo; verificación: el `run_creado` del próximo run de pizarra lleva `vueltas: 1` y el modo de aprobar nuevo.
- **Canario:** N/A — sin test; el comportamiento de cada valor lo prueban T1.6 y los tests de ADR 0023.
- **Criterio de aprobación:** el próximo run de pizarra-en-vivo arranca con la config nueva y no espera aprobación.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; dos líneas y sus comentarios.
- **Desbloquea:** Gate Fase 2

### Gate Fase 2
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** un test en `test/` donde una sub-task falsa lee un archivo de 500 líneas sin rango (el hook lo deja pasar) y la revisión falsa devuelve un bloqueante de decisión: el run se detiene con `pregunta` en revisar sin haber vuelto a implementar.
- **Canario:** re-canario sobre 2 tests de la fase al azar.
- **Criterio de aprobación:** 3 runs reales de pizarra-en-vivo con la config nueva; ninguno tiene rechazos por largo de lectura.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + `test-debt:` nuevos.
- **Desbloquea:** Fase 3

---

# Fase 3 — Aprender de todo el run, no solo de lo que salió mal

> Objetivo: que el aprendizaje no dependa solo de las vueltas. Hoy un run derecho no aprende nada aunque haya descubierto mucho, e implementar no registra ninguna decisión (0 en 33 runs). Con 2.0 hay menos vueltas, así que hacen falta fuentes nuevas: lo que descubre el que implementa, las preguntas del planificador y las decisiones de revisar. Y cada lección dice para quién es: la conversación, el plan o el código.

### T3.1 · Implementar declara lo que descubrió
- **Estado:** `[ ] Pendiente`
- **Descripción:** la sesión de implementar (`src/phases/implementar.ts`) hoy no tiene salida estructurada: termina con texto. Se le da una herramienta MCP, `anotar_descubrimiento({ que, donde, como })`, como `validar_plan` en planificar, que puede llamar hasta 3 veces por sesión. El prompt pide solo lo que le costó un rojo o un reintento: algo del repo o de una librería que no sabía (por ejemplo, que Excalidraw 0.18.1 descarta un `pointermove` despachado en `window`), incluido un rojo de un test o de `verify.sh` que arregló dentro de la sesión. No es una narración de lo que hizo. Cada uno se escribe como evento `descubrimiento` con su fase y su sub-task. `donde` tiene que ser `archivo:línea` de un archivo que existe en el worktree; uno que no cumple se descarta con un `aviso`.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/implementar.test.ts`, con la sesión falsa: (1) dos llamadas a `anotar_descubrimiento` dejan dos eventos `descubrimiento` en el log con su sub-task, y una cuarta llamada se rechaza con el motivo; (2) uno con `donde` en un archivo que no existe se descarta y deja un `aviso`; (3) una sesión que no la llama sigue como hoy, sin eventos nuevos.
- **Canario:** mutación prevista: no validar `donde`; el test (2) tiene que ponerse rojo.
- **Criterio de aprobación:** en un run real de pizarra, el informe muestra los descubrimientos de implementar en «Decisiones».
- **Revisión ponytail:** `/ponytail-review` sobre el diff; un campo en el schema y un evento, sin un registro aparte.
- **Desbloquea:** T3.2

### T3.2 · Proponer lecciones también de descubrimientos, preguntas y decisiones
- **Estado:** `[ ] Pendiente`
- **Descripción:** `frictions()` (`src/phases/proponer.ts`) suma tres fuentes, con su origen citable: `implementar ST-n, descubrimiento k`; `planificar, pregunta k` (la pregunta del planificador y lo que respondiste con `flowrunner responder`, de T1.4); y `revisar, decisión k` (la pregunta de decisión de T2.2 y cómo la resolviste). Un run sin vueltas pero con alguna de estas fuentes ya no termina en «Nada nuevo para el cerebro». El límite de lecciones por run pasa de 2 a 3, porque hay más fuentes.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/proponer.test.ts`: (1) `frictions()` de un log con un descubrimiento, una pregunta respondida y una decisión de revisar devuelve las tres, en orden y con su origen; (2) un run sin vueltas pero con un descubrimiento abre la sesión de proponer (la sesión falsa se llama) en vez de escribir «Nada nuevo»; (3) una lección que cita un origen que no está entre las fuentes se sigue descartando.
- **Canario:** mutación prevista: que `frictions()` ignore los eventos `respondido`; el test (1) tiene que ponerse rojo.
- **Criterio de aprobación:** la sección de lecciones de la PR de un run sin vueltas pero con un descubrimiento propone una lección que lo cita.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; tres ramas más en `frictions()`, sin un sistema de fuentes.
- **Desbloquea:** T3.3

### T3.3 · Cada lección dice para quién es
- **Estado:** `[ ] Pendiente`
- **Descripción:** `lessonSchema` suma `para: "conversacion" | "plan" | "codigo"`. Conversación: un caso borde o una decisión que la skill tiene que preguntar en este repo. Plan: una regla para planificar o implementar, como L-2. Código: cómo se comporta algo del repo o de una librería. Se sigue usando un solo archivo, `lecciones.md`, con una línea `Para:` en cada lección; aprender la copia al numerarla. Una lección vieja sin `Para:` cuenta como `plan`.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/proponer.test.ts` y `src/phases/aprender.test.ts`: (1) una lección propuesta sin `para` es un error del schema; (2) al mergear, aprender escribe la lección en `lecciones.md` con su número y su línea `Para:`; (3) un `lecciones.md` con lecciones viejas sin `Para:` se lee igual y numera la siguiente bien.
- **Canario:** mutación prevista: que aprender no copie la línea `Para:`; el test (2) tiene que ponerse rojo.
- **Criterio de aprobación:** `lecciones.md` de pizarra-en-vivo, después del primer merge con 2.0, tiene una lección con `Para:`.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; una línea más por lección, sin archivos nuevos.
- **Desbloquea:** T3.4

### T3.4 · La skill pregunta lo que el repo aprendió
- **Estado:** `[ ] Pendiente`
- **Descripción:** el paso 2 de `skills/flowrunner/SKILL.md` dice que lea las lecciones `Para: conversación` de `.flowrunner/lecciones.md` y que, en el tema de casos borde del ping pong, pregunte cada una que se cruce con la feature, citando la lección (`L-n`).
- **Lint:** `pnpm lint` verde (prettier sobre el `.md`).
- **Test:** N/A — es texto de la skill que lee un modelo; verificación: con una lección `Para: conversación` en pizarra-en-vivo, el ping pong de una feature que toca esa parte del repo la pregunta y la cita.
- **Canario:** N/A — sin test; el control es el criterio de aprobación de abajo.
- **Criterio de aprobación:** la persona ve la pregunta de la lección en una conversación real, con su número.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; una o dos frases en la skill.
- **Desbloquea:** T3.5

### T3.5 · El tope de lecciones avisa en vez de cortar el run
- **Estado:** `[ ] Pendiente`
- **Descripción:** hoy, si `lecciones.md` pasa los 12.000 caracteres (`BRAIN_FILES`, `src/brain/brain.ts:21`), `loadBrain` (`src/brain/brain.ts:91`) lo cuenta como problema, preparar falla y el run no arranca (pasó 2 veces en pizarra). `loadBrain` lo usan también planificar, implementar, revisar y explorar, así que el cambio es en el cerebro, no solo en preparar: para `lecciones` el exceso pasa de problema a aviso. Primero se lee ADR 0040 para entender por qué está el tope; si es por el tamaño del prompt, el run sigue con un `aviso` que propone correr la auditoría del cerebro, y el texto llega entero. Si el ADR da una razón que lo impida, la tarea se replantea antes de tocar código.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en el test de `src/brain/brain.ts` y en `src/phases/preparar.test.ts`: (1) con un `lecciones.md` de 15.000 caracteres, `loadBrain` devuelve el texto entero y un aviso, y preparar termina en `ok` con un `aviso` que nombra el archivo y el tamaño; (2) los otros archivos del cerebro con su tope siguen como hoy.
- **Canario:** mutación prevista: devolver otra vez `falla` por el tamaño; el test (1) tiene que ponerse rojo.
- **Criterio de aprobación:** un run de pizarra con un `lecciones.md` largo arranca y el aviso aparece en el informe.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; cambia una rama, sin compactar automático.
- **Desbloquea:** Gate Fase 3

### Gate Fase 3
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** un test en `test/` que recorre el ciclo: un run sin vueltas donde la sesión falsa de implementar declara un descubrimiento → la PR trae la lección propuesta, con `Para: codigo` y el origen citado → se simula el merge → aprender la pasa a `lecciones.md` con su número y su `Para:`. Afirma sobre el archivo de propuestas y sobre `lecciones.md`.
- **Canario:** re-canario sobre 3 tests de la fase al azar.
- **Criterio de aprobación:** dos runs reales de pizarra-en-vivo dejan al menos una lección de una fuente nueva, y el ping pong siguiente pregunta una lección de conversación.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado de la fase + `/ponytail-debt` + `test-debt:` nuevos.
- **Desbloquea:** Fase 4

# Fase 4 — Experimento: una sola sesión de Opus

> Objetivo: que la sesión de Opus que planificó también implemente, con todo el contexto, detrás de una opción. Revisar sigue en otra sesión de Opus; probar sigue con Sonnet.

### T4.1 · Prueba de una hora: ¿se puede retomar la sesión del planificador para implementar?
- **Estado:** `[ ] Pendiente`
- **Descripción:** antes de escribir código del experimento, un script en `smoke/` con el SDK real comprueba: (a) retomar con `resume` una sesión abierta en la carpeta A desde la carpeta B; (b) retomarla en la misma carpeta con otras herramientas (de solo lectura a escritura) y otro hook; (c) cuántos tokens de entrada cuesta el primer turno retomado. Con el resultado se elige el camino de T4.3 y se escribe en el ADR del experimento: **camino A**, `ST-1` sigue en su propio worktree y el mensaje al retomar le da la ruta nueva; **camino B**, con `una_sesion`, `ST-1` corre en el worktree de la feature, sin worktree propio ni cherry-pick, y retoma en la misma carpeta.
- **Lint:** `pnpm lint` verde.
- **Test:** N/A — es una prueba de factibilidad contra el SDK real y gasta suscripción, como los smoke de hoy; verificación: el script corre con `pnpm smoke` y su salida queda pegada en el ADR.
- **Canario:** N/A — sin test; la decisión queda escrita con la evidencia.
- **Criterio de aprobación:** el ADR del experimento dice qué camino se eligió y por qué, con la salida del script.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; un solo archivo de smoke.
- **Desbloquea:** T4.2

### T4.2 · La opción `implementar: una_sesion` y su gate
- **Estado:** `[ ] Pendiente`
- **Descripción:** opción `implementar: sub_tasks | una_sesion` en la config del repo (por defecto `sub_tasks`), congelada en `run_creado`. Con `una_sesion`, el prompt del planificador pide una sola sub-task con todo el alcance, y el gate del plan (`src/gates/plan.ts`) rechaza un plan con más de una. Todo lo que hoy depende de las sub-tasks (`fix --unidad`, conservar al replanificar, el informe, Orca) sigue funcionando sin cambios porque hay una, `ST-1`. ADR nuevo con la hipótesis, el costo esperado y cómo se mide.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/gates/plan.test.ts`: (1) con `una_sesion`, un plan de dos sub-tasks se rechaza con el motivo; (2) con `una_sesion`, un plan de una pasa; (3) con `sub_tasks`, un plan de dos pasa como hoy.
- **Canario:** mutación prevista: que el gate mire la opción del worktree y no la de `run_creado`; o que cuente `<= 2`; el test (1) tiene que ponerse rojo.
- **Criterio de aprobación:** el ADR está en `docs/adr/` y `flowrunner plan` de un run con la opción muestra una sola sub-task.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; sin un modo de implementación abstracto, una rama del gate.
- **Desbloquea:** T4.3

### T4.3 · Implementar retoma la sesión del planificador con Opus
- **Estado:** `[ ] Pendiente`
- **Descripción:** con `una_sesion`, implementar (`src/phases/implementar.ts`) corre `ST-1` retomando la sesión del planificador (el mismo mecanismo de retomar de ADR 0025), con el modelo de planificar y el alcance y la política de comandos de `ST-1`. Si la sesión ya no se puede retomar (expiró o se replanificó), abre una sesión nueva de Opus con el plan y la feature, y deja un aviso. Dónde corre lo decide T4.1: en el camino A, `ST-1` sigue en su propio worktree y el mensaje al retomar dice la ruta nueva y que las rutas relativas son las mismas, y el hook sigue rechazando lo que apunte al worktree viejo; en el camino B, `ST-1` corre en el worktree de la feature y commitea directo en su rama, sin cherry-pick, y el test (4) cambia a «el commit de `ST-1` queda en la rama de la feature sin worktree propio». El commit, los fixers y el doble control del diff no cambian.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/phases/implementar.test.ts`, con la sesión falsa: (1) con `una_sesion`, la sesión de `ST-1` se abre con `resume` igual al id de la sesión de planificar y el modelo de planificar; (2) si `resume` falla, abre una nueva con el mismo modelo y queda un `aviso` en el log; (3) con `sub_tasks`, la sesión es nueva y con el modelo de implementar, como hoy; (4) al retomar, el primer mensaje nombra la ruta del worktree de `ST-1`, y un Edit falso sobre la ruta absoluta del worktree de la feature se rechaza.
- **Canario:** mutación prevista: pasar el modelo de implementar en vez del de planificar; el test (1) tiene que ponerse rojo.
- **Criterio de aprobación:** en el informe de un run con la opción, implementar figura con el modelo de Opus y una sola ejecución.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; reusa el retomar existente.
- **Desbloquea:** T4.4

### T4.4 · Con una sola sub-task, el que implementa puede correr el verify del repo
- **Estado:** `[ ] Pendiente`
- **Descripción:** `unitComandos` (`src/phases/implementar.ts:150-174`) suma el verify del repo (`.flowrunner/verify.sh`) a lo permitido cuando el plan tiene una sola sub-task. Hoy está afuera porque con varias el verify sale rojo por el trabajo pendiente de las otras; con una, ese motivo no existe. El prompt de implementar le pide correrlo antes de terminar. Verificar sigue como control final, igual de estricto.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en el test de `comandos`/`implementar`: (1) con un plan de una sub-task, `./.flowrunner/verify.sh` y `bash .flowrunner/verify.sh` se permiten; (2) con dos sub-tasks se rechazan con el motivo de hoy; (3) `verify.sh` con un argumento que escribe fuera del alcance se sigue rechazando.
- **Canario:** mutación prevista: permitir el verify sin mirar cuántas sub-tasks hay; el test (2) tiene que ponerse rojo.
- **Criterio de aprobación:** en un run real con la opción, la sesión de implementar corre `verify.sh` y verificar no devuelve trabajo por un rojo de verify.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; una condición más en `unitComandos`.
- **Desbloquea:** T4.5

### T4.5 · `stats --runs` dice con qué modo corrió cada run
- **Estado:** `[ ] Pendiente`
- **Descripción:** `src/report/stats.ts` suma la columna `modo` (`sub_tasks` o `una_sesion`, de `run_creado`) y `aprobar` (`vos` o `flowrunner`, del evento `aprobado`), y las medianas por modo al pie. Es lo que la Fase 5 compara.
- **Lint:** `pnpm lint` verde.
- **Test:** test primero en `src/report/stats.test.ts`: con dos runs de cada modo, la tabla muestra la columna y las medianas se calculan por separado; un run viejo sin el campo cuenta como `sub_tasks`.
- **Canario:** mutación prevista: calcular la mediana de `una_sesion` sobre todos los runs; el test tiene que ponerse rojo.
- **Criterio de aprobación:** `flowrunner stats --runs pizarra-en-vivo` muestra la columna con los runs viejos como `sub_tasks`.
- **Revisión ponytail:** `/ponytail-review` sobre el diff; dos columnas, sin un sistema de agrupación.
- **Desbloquea:** Gate Fase 4

### Gate Fase 4
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** un test en `test/` que corre un run con `implementar: una_sesion` por el CLI: el planificador falso devuelve una sub-task, implementar retoma su sesión (se comprueba por el id en el log de la sesión), la sub-task corre `verify.sh` sin rechazo, verificar pasa y `stats --runs` lo cuenta como `una_sesion`.
- **Canario:** re-canario sobre 3 tests de la fase al azar.
- **Criterio de aprobación:** un run real de pizarra-en-vivo con la opción llega a la PR.
- **Revisión ponytail:** `/ponytail-review` sobre el diff acumulado + `/ponytail-debt` + `test-debt:` nuevos.
- **Desbloquea:** Fase 5

---

# Fase 5 — Medir y decidir

> Objetivo: decidir con números qué queda por defecto, y contestar si el harness rinde más que Claude Code directo.

### T5.1 · Correr las features de medición y escribir el resultado
- **Estado:** `[ ] Pendiente`
- **Descripción:** en pizarra-en-vivo, con la config de la Fase 2: 5 features con `implementar: una_sesion` y 5 con `sub_tasks`, alternadas, y 3 features directo en Claude Code con el protocolo de T0.1. Todas con el ping pong nuevo. Llenar la planilla de `medicion.md` y escribir `docs/flowrunner-2/resultado.md`: la tabla contra la línea de base, qué opción queda por defecto y si `aprobar: si_hace_falta` pasa a ser el valor por defecto de flowrunner.
- **Lint:** `pnpm lint` verde (prettier sobre los `.md`).
- **Test:** N/A — son corridas reales y un informe; verificación: los números de `resultado.md` se reproducen con `flowrunner stats --runs` y la planilla de las corridas directas.
- **Canario:** N/A — sin test.
- **Criterio de aprobación:** `resultado.md` dice para cada métrica el valor de base, el de cada modo y el de Claude Code directo, y termina en una decisión por opción.
- **Revisión ponytail:** `/ponytail-review` sobre el diff.
- **Desbloquea:** Gate Fase 5

### Gate Fase 5
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** `pnpm lint` verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** N/A — la fase no tiene código; si la decisión cambia un valor por defecto, ese cambio es una tarea `T5.2` con su test.
- **Canario:** N/A — sin tests nuevos.
- **Criterio de aprobación:** la persona lee `resultado.md` y decide: qué opción queda por defecto, cuál se borra y si el experimento sigue.
- **Revisión ponytail:** `/ponytail-review` sobre el diff + `/ponytail-debt`.
- **Desbloquea:** Cierre

---

# Cierre del proyecto

### Gate final
- **Estado:** `[ ] Pendiente`
- **Validación de lint:** todo el repo verde.
- **Tests:** `pnpm verify` verde.
- **Test de integración:** los tests de integración de los gates 1 a 4 corren juntos en `pnpm test:integration`.
- **Canario:** se rompe el invariante central de 2.0, que el run nunca toma una decisión de producto sin preguntar: el planificador ignora `preguntas`. La suite se tiene que poner roja.
- **Criterio de aprobación:** README, la skill y el artifact «La fábrica flowrunner hoy» describen la línea nueva; la opción que perdió en la Fase 5 está borrada con su código.
- **Revisión ponytail:** `/ponytail-review` sobre el diff completo del proyecto + `/ponytail-debt` con el ledger final + el ledger de `test-debt:` sin resolver.
