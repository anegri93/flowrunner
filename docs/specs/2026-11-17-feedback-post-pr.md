# Rehacer una PR abierta con tu feedback

Estado: implementado · 2026-11-17 · ADR 0038

## Problema

> Cuando una feature ya está en etapa de aprendizaje y no me gusta el resultado, no quiero hacer
> merge; necesito darle feedback a esa feature para que, teniendo en cuenta mi feedback, evalúe desde
> dónde debe recomenzar el proceso.

El run entregado espera el merge en aprender. Hoy, si la PR no te gusta, solo podés mergearla y
corregir, corregir a mano en la rama, o abortar y empezar de cero.

## Lo que hace

1. Con la PR abierta, decís qué no te gustó: `flowrunner feedback <run> "<texto>"`, «Rehacer con
   feedback…» en la tarjeta de Orca (al lado de «Aprender ahora»), o en palabras a la skill de Claude.
2. El run vuelve a aprender y una sesión de solo lectura decide desde dónde rehacer:
   - **implementar**: el plan sirve y lo que falla es el código de algunas sub-tasks. Solo esas se
     corrigen, con tu feedback y la instrucción de la evaluación, y el run sigue por verificar,
     revisar, probar y entregar.
   - **planificar**: tu feedback cambia cómo se resuelve. Se replanifica con tu feedback y el plan te
     vuelve a esperar para aprobarlo.
   - **la feature**: tu feedback cambia lo que se pide. El run se detiene y te pregunta: replanificar
     con tu feedback o abortar y escribir otra feature.
3. Entregar actualiza la misma PR: push a la misma rama y la descripción reescrita, con tu feedback y
   desde dónde se rehízo.
4. Tu feedback cuenta como corrección: entregar propone lecciones con él.

## Decisiones

- **Quién elige la fase: flowrunner, con un por qué.** Pediste que lo evalúe; la persona ve la
  decisión y el porqué en el recorrido (paso «Diste feedback sobre la PR» y aprender «con tu
  feedback»), en `status` y en la PR.
- **Ante la duda, planificar.** Es lo único que vuelve a pasar por vos antes de gastar en implementar.
  Una respuesta del modelo que nombra sub-tasks que no existen, o ninguna, replanifica.
- **Modelo:** el de `models.revisar` (Opus por defecto), como el diagnóstico de verificar: es una
  lectura de juicio sobre código y plan, no un trabajo de escritura. Sin clave nueva en la config.
- **Si empujaste commits a la rama** después de la entrega, entran al worktree antes de rehacer, solo
  si la adelantan. Si la rama se separó, el run se detiene y te dice qué traer. Un test bloqueado que
  corregiste queda como el nuevo bloqueado. Si empujás otra vez mientras se rehace, entregar no lo
  pisa: se detiene y te pide traerlo.
- **PR mergeada o cerrada.** El comando la rechaza si flowrunner ya lo vio. Si se mergea antes de que
  aprender evalúe, queda un aviso y aprender sigue como siempre; si se mergea mientras se rehace,
  entregar no empuja, deja un aviso y vuelve a aprender, que aprende del merge (revisión de la PR).
- **Orca pide el texto en línea**, como «Cambios», sin confirmación aparte: escribir el feedback ya es
  la decisión. La respuesta de flowrunner («evaluando desde dónde rehacer») queda en la tarjeta.
- **La skill pregunta antes**: `flowrunner feedback` es una regla `ask`, como `fix` y `accept`.

## Fuera de alcance

- Editar la feature desde el panel cuando el feedback cambia lo que pide: la salida es abortar y
  escribir otra.
- Rehacer desde verificar, revisar o probar: el feedback de una persona sobre el resultado siempre
  pide cambiar código o plan.

## Cómo se prueba

Ver la sección «Verificación» del ADR 0038.
