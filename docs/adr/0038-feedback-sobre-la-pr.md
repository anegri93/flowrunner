# 0038 · Tu feedback sobre la PR abierta rehace el run desde donde haga falta

Estado: Aceptada · 2026-11-17

## Contexto

Cuando un run entrega, la PR queda abierta y el run espera el merge en aprender. Si a la persona no le
gusta el resultado, tenía tres salidas, y ninguna servía: mergear algo que no quiere y corregirlo a
mano para que aprender lo convierta en lecciones; corregirlo en la rama a mano; o abortar el run y
escribir una feature nueva desde cero, tirando el plan, el código y lo que costó. `rerun --desde`
existe, pero solo en un run detenido, sin el feedback, y le pide a la persona elegir la fase: que sepa
si su queja es de código, de plan o de feature.

## Decisión

1. **`flowrunner feedback <run> "<qué no te gustó>"`**, y «Rehacer con feedback…» en Orca, valen con
   el run entregado y la PR abierta. El texto es obligatorio. Escriben `feedback_pedido` con el texto y
   el origen, con el candado de aprender: un tick que mira la PR en ese momento terminaría con «la PR
   sigue abierta» y se tragaría el feedback.
2. **El reductor lleva el run a aprender, en curso**, con el feedback pendiente en el estado y las
   vueltas en cero, como cualquier respuesta tuya. Un run que no está entregado, o con la PR ya
   mergeada o cerrada (`pr_cerrada`, que ahora deja `prCerrada`), lo ignora.
3. **Aprender evalúa el feedback** si la PR sigue abierta: una sesión de solo lectura (Read, Grep,
   Glob; el modelo de `models.revisar`, Opus por defecto) lee el feedback, la feature, el plan, las
   sub-tasks y el diff, y decide `implementar` con sub-tasks e instrucciones, `planificar`, o
   `feature`, siempre con un `por_que` para la persona. Antes, trae al worktree lo que la persona
   empujó a la rama de la PR, si solo la adelanta: si no, el push de la próxima entrega lo rechazaría o
   lo pisaría. Una rama que se separó detiene el run.
4. **Un outcome nuevo, `reentrar`**, solo de aprender y solo con un feedback pendiente: `planificar`
   replanifica con el feedback como instrucción y vuelve a pasar por tu aprobación; `implementar`
   corre solo esas sub-tasks con la instrucción, como una vuelta. Un `reentrar` de otra fase, o sin
   feedback, detiene el run.
5. **El código decide si la respuesta sirve.** `implementar` con sub-tasks que no son del plan, o sin
   ninguna, replanifica con un aviso: es lo que pasa por la persona. Ante la duda, el prompt también
   pide `planificar`.
6. **`feature` pregunta.** Si el feedback cambia lo que pide la feature, flowrunner no decide: el run
   se detiene con `rerun --desde planificar` (que ahora lleva el feedback pendiente como instrucción) y
   abortar. Rehacer desde aprender lo vuelve a evaluar; desde otra fase, el feedback se descarta.
7. **La misma PR.** Entregar ya reusaba la PR abierta de la rama; ahora, si hubo feedback, reescribe su
   descripción (`gh pr edit --body-file`) con una sección «Feedback de la persona»: cada feedback y
   desde dónde se rehízo. Si la PR se mergeó o se cerró mientras se rehacía, entregar se detiene como
   antes: flowrunner no la reabre.
8. **El feedback es una corrección.** Es una fricción para las lecciones propuestas («tu feedback
   sobre la PR n»), y entregar las vuelve a proponer después de cada feedback, en vez de una vez por
   run. Si la PR ya se mergeó cuando aprender lo ve, queda un aviso y aprender sigue como siempre.

## Alternativas descartadas

- **Que la persona elija la fase**, con `rerun --desde` sobre un run entregado. Le pide saber si la
  queja es de código o de plan, que es justo lo que no quiere pensar; y sin el feedback, la fase
  rehace a ciegas.
- **Una fase nueva para evaluar el feedback.** Suma una etapa a la barra de nueve, al recorrido y a
  Orca para una sesión corta. Aprender es la etapa en la que está el run, la que espera tu merge.
- **Evaluar en el CLI.** La sesión lleva minutos y el panel de Orca corta cada comando a los 20 s; el
  proceso del run ya sabe correr una fase con lugar, pausa por límite y reintento.
- **Usar `vuelve` desde aprender.** Cuenta vueltas y agrupa el recorrido hasta que su fase queda en
  verde, que en aprender es el cierre del run.
- **Abrir otra PR.** La conversación de la revisión queda en la primera, y dos PRs de la misma rama
  no existen en GitHub.

## Verificación

- `src/engine/engine.test.ts`, «el feedback sobre la PR abierta (ADR 0038)»: el feedback lleva a
  aprender solo con la PR abierta; `reentrar` a implementar con las sub-tasks y a planificar con la
  aprobación; `reentrar` fuera de aprender o sin feedback detiene; `feature` se detiene y replanificar
  lleva el feedback; la PR mergeada antes de evaluar descarta el feedback; el run rehecho vuelve a
  esperar el merge y acepta otro feedback.
- `src/phases/feedback.test.ts`: la decisión válida llega al engine con tu feedback; una sin sub-tasks
  del plan replanifica con un aviso; `feature` pregunta.
- `test/feedback.int.test.ts`: con el CLI real, el SDK simulado y gh falso, el feedback rehace la
  sub-task elegida, la sub-task recibe tu texto, `status` dice la decisión, la PR es la misma con la
  descripción nueva, y la rama tiene el commit que empujó la persona y el arreglo. El comando rechaza
  un run que no está entregado y un feedback vacío.
- `src/watch/recorrido.test.ts`, `src/watch/tree.test.ts`, `src/phases/proponer.test.ts` y los tests
  de Orca (`runs`, `estado`, `worker`).
