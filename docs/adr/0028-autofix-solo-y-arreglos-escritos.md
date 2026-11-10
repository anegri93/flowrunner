# 0028 · Autofix corre solo y la detención trae los arreglos escritos

Estado: Aceptada · 2026-11-10 · Amplía 0023 y 0026

## Contexto

En PIZ-3, revisar frenó 7 veces por el mismo bloqueante: `unpdf@2.1.0` pedía Node ≥24 y el repo
prometía ≥20.6. Cada detención ofrecía `fix --unidad ST-2 "<qué cambiar>"`, con el texto vacío para
completar, Autofix, `fix --yo`, `accept`, replanificar y abortar. La persona eligió Autofix 3 veces
desde Orca, cada una de unos 8 minutos y USD 1,1, y no sirvió: Autofix formatea y vuelve a intentar, y
el bloqueante no era de formato. La revisión ya sabía qué cambiar (subir `engines.node` o usar otra
versión de unpdf), pero eso quedaba en el motivo y no en una respuesta.

Lo que la persona pidió: que Autofix corra solo cuando la traba cumple sus criterios, y que al sugerir
una sub-task la detención sugiera también la solución, para elegirla con un toque.

## Decisión

1. **Autofix corre solo** al detenerse en verificar, revisar o probar con sub-tasks, sin un arreglo a
   mano esperando ni criterios sin probar: donde ADR 0026 lo ofrece a la persona. Es el mismo Autofix,
   con sus negativas (cambios sin commitear, la config que no carga): si se niega, el run se detiene
   como antes, y un `aviso` «Autofix no corrió solo: …» dice por qué.
2. **Una vez por detención.** `autofixCorrio`, en el estado, se prende con cualquier `autofix` y se
   apaga con una respuesta de la persona que manda el run a trabajar (`arreglo_pedido`,
   `arreglo_manual`, `aceptado`, `sin_probar_aceptado`, `rehacer`). Si después de Autofix sigue en
   rojo, la detención siguiente pregunta como hoy, y Autofix sigue entre las opciones. Un Autofix que
   eligió la persona también cuenta: repetirlo solo daría el mismo resultado.
3. **El motor sigue siendo un reductor puro.** `correAutofixSolo(state)` decide; el proceso del run
   (`runUntilStop`, con `autofixSolo` desde `runProcess`) hace lo mecánico con `aplicarAutofix`, la
   misma función que `fix --auto`, y con el Node del repo. Solo en una detención a la que llegó ese
   proceso: un run que ya esperaba a la persona no cambia al actualizar flowrunner.
4. **El evento `autofix` suma el origen `flowrunner`.** El reductor lo aplica igual que el de la
   persona. No es un `--origen` del CLI. El informe lo cuenta en «Tus decisiones», en orden y sin
   demora: «flowrunner corrió Autofix solo, sin esperarte».
5. **El revisor escribe los arreglos.** Cada bloqueante trae de 1 a 3 `arreglos`, cada uno una
   instrucción para la sub-task, en imperativo y en una línea. Viajan en el outcome `vuelve`
   (`arreglos`, opcional) hasta `opcionesDe`, que ofrece uno por arreglo antes del `fix --unidad`
   genérico, que se queda para escribir otro: `flowrunner fix <R> --unidad ST-n '<arreglo>'`, con un
   `que` legible y el arreglo aparte en la opción (`arreglo`). El texto va entre comillas simples de
   shell: lo escribe un modelo, y entre comillas dobles un `` `engines.node` `` se ejecutaría al copiar
   el comando. Lo que el diagnóstico de verificar le pide a una sub-task también viaja como arreglo.
   Probar no propone arreglos: su evidencia dice qué falló, no cómo arreglarlo.
6. **La vuelta que nadie eligió también los recibe:** la que sigue a Autofix y las automáticas de
   `vueltas` llevan el motivo y, debajo, «Arreglos propuestos». Sin arreglos, el motivo solo, como
   antes.
7. **Elegir un arreglo es un `fix --unidad`.** Comparten prefijo, así que `offersFix` acepta el ofrecido
   con su texto y el genérico con cualquiera, sin cambios en el CLI ni en el reductor.
8. **Orca** muestra cada arreglo como un botón, arriba de «Arreglar ST-n», y tocarlo lo manda sin
   confirmar: elegirlo es la decisión.

## Alternativas descartadas

- **Autofix solo dentro del reductor**, como una transición de `vuelve`. Necesita correr las
  herramientas y commitear antes de verificar, y un reductor con efectos deja de poder reproducir un
  log.
- **Correrlo solo si el repo tiene `format` o `lint_fix`.** Sin herramientas, Autofix se reduce a
  devolverle el rojo a las sub-tasks con el motivo, que es la vuelta automática que ADR 0023 apagó por
  defecto. Se descartó porque la persona lo pidió sin esa condición; queda como la primera palanca si
  el costo de esas vueltas pesa.
- **Correrlo en cada detención.** Es lo que hizo PIZ-3 a mano, tres veces, sin resultado.
- **Que la opción con el arreglo reemplace al `fix --unidad` genérico.** Un log viejo, sin arreglos,
  dejaría de ofrecer lo que ofrecía (C8), y la persona no podría escribir otro arreglo.

## Consecuencias

- Una detención con sub-tasks llega a la persona después de Autofix y de una vuelta de implementar
  que nadie pidió: más tiempo y una sesión más antes de la pregunta. Con `vueltas: 0`, ya no toda
  reentrada a implementar viene de un `fix` de la persona (ADR 0023).
- La primera opción de una detención de la revisión, y por eso `siguiente`, el aviso y watch, pasa a
  ser el arreglo recomendado.
- Un log sin arreglos se reduce exactamente igual: sus opciones, su `siguiente` y las respuestas que
  valen no cambian.

## Verificación

- `src/engine/engine.test.ts`, «arreglos escritos y Autofix solo (ADR 0028)»: las opciones con el
  arreglo, antes del genérico y con comillas seguras; elegir el ofrecido o escribir otro; un log como el
  de PIZ-3, sin arreglos, se reduce igual; dónde corre Autofix solo, y una vez por detención.
- `src/runner/runner.test.ts`, «Autofix solo»: lo corre una vez y avisa una vez, si se niega deja el
  aviso, y no corre donde no se ofrece ni en una detención que el proceso no causó.
- `src/phases/revisar.test.ts`: los arreglos en el outcome y en el schema del revisor.
- `src/report/report.test.ts`: «flowrunner corrió Autofix solo» entre tus decisiones.
- `test/autofix.int.test.ts`, con el CLI real y git: Autofix solo formatea la rama en su commit, una
  vez, y la detención siguiente pregunta. `test/pregunta.int.test.ts`: el arreglo ofrecido, copiado a un
  shell, anda como un `fix`. `test/diagnosticar.int.test.ts`: el diagnóstico viaja como arreglo.
- Orca: `orca/src/runs.test.ts` y `estado.test.ts`.
