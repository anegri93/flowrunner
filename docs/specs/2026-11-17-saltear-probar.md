# Saltear probar a pedido

Estado: diseño aprobado en la conversación · 2026-11-17 · ADR 0036

## Problema

Probar se saltea sola en dos casos: el repo no configuró `probar`, o ningún criterio se ve en el
entorno (ADR 0032). Fuera de eso corre siempre, y la única salida es después: si deja criterios sin
probar, el run se detiene y la persona decide `accept-untested`. Hay features en las que la persona ya
sabe, antes de que probar arranque, que no vale la pena levantar el entorno: un cambio de docs, uno que
solo toca la CLI, un entorno que hoy no levanta. Probar gasta igual la sesión y los minutos, o frena el
run para que la persona diga lo que ya sabía.

## Decisión

La persona puede marcar un run para que probar se saltee, **antes de que probar arranque**: al aprobar
el plan o en cualquier momento mientras el run planifica, implementa, verifica o revisa. Es una
decisión de la persona, con motivo obligatorio, que queda en el informe y en la PR, como
`accept-untested` (ADR 0017): solo cambia cuándo se toma.

Alternativas descartadas:

- **Solo como opción de `approve`.** Más chico, pero no cubre un run que ya pasó la aprobación.
- **Cortar probar mientras corre.** La persona no lo pidió, y cortar una sesión a la mitad con el
  entorno levantado es otro problema (bajar el entorno, restaurar fallas). Si probar ya arrancó, se
  espera su resultado y, si se detiene, sigue valiendo `accept-untested`.
- **Un flag en la feature, al lanzarla.** La persona eligió decidirlo con el plan a la vista, no antes.

## El modelo

Dos eventos nuevos en el log del run:

- `probar_salteado { motivo, origen }`: la persona pidió saltear probar.
- `probar_restaurado { origen }`: la persona lo deshizo.

El reductor los aplica solo mientras probar no arrancó: con la fase antes de probar, o en probar con
el run en cola o pausado (ninguno de los dos llegó a correrla). En cualquier otro caso el evento no
hace nada, como todos los de la persona que no aplican. El estado guarda `probarSalteado`, el motivo,
o `undefined`.

- `rerun --desde probar` borra la marca: pedir rehacer probar es pedir probar.
- `rerun` desde una fase anterior, o `changes` al plan, la mantienen: la decisión no era sobre el plan.

## Comandos

- `flowrunner skip-probar <run> "<por qué>" [--origen …]`: marca el run. Sin motivo, sale 1 con el
  mismo error que `accept-untested`. Si probar ya arrancó o pasó, sale 1 diciendo en qué fase está; si
  el run está detenido en probar por criterios sin probar, lo deriva a `accept-untested`.
- `flowrunner skip-probar <run> --deshacer [--origen …]`: vuelve a probar normal, con las mismas
  condiciones. Sin marca, sale 1.
- `flowrunner approve <run> --sin-probar "<por qué>"`: valida todo lo de `approve` (versiones,
  `--acepto-cambios`) antes de escribir; si pasa, escribe `probar_salteado` y después `aprobado`.

## El runner

Cuando la acción que toca es probar y el estado tiene `probarSalteado`, el runner no corre la fase:
escribe el aviso «probar se salteó: la salteó la persona: <motivo>» y el resultado `ok` con
`salteada`, el mismo que deja probar cuando se saltea sola. No levanta el entorno, no toma el turno del
entorno ni abre sesión. Así lo ve igual con fases reales o falsas.

## Lo que se ve

- **Informe y PR:** en «Pruebas en el entorno», «⚠️ No se probó en el entorno, por decisión de la
  persona: <motivo>».
- **watch y Orca:** la etapa Probar pendiente lleva el detalle «se va a saltear: <motivo>»; cuando
  llega, queda «salteada» con su motivo, como hoy.
- **`watch --json`:** cada run suma `saltearProbar` (el motivo, si está marcado) y `puedeSaltearProbar`.
- **Orca:** en el menú ⋯ de un run que todavía no llegó a probar, «Saltear probar…», que pide el
  motivo en línea, o «Volver a probar» si ya está marcado. En la decisión del plan, «Aprobar sin
  probar…», que pide el motivo y después confirma como «Aprobar», incluido «Acepto los cambios y
  apruebo» si el plan cambia lo existente. El worker manda `skip-probar` y `approve --sin-probar` con
  `--origen orca`, con el motivo validado como el resto.
- **Skill de Claude:** el permiso `Bash(flowrunner skip-probar:*)` y cuándo ofrecerlo.

## Tests

- engine: la marca aplica antes de probar y en cola/pausado en probar; no aplica después; `rerun
  --desde probar` la borra; `rerun --desde implementar` la mantiene; `probar_restaurado` la borra.
- runner: con la marca, probar no corre y queda `salteada` con el motivo.
- CLI (integración): `skip-probar` sin motivo sale 1; con motivo el run entrega sin correr probar;
  después de probar sale 1; `approve --sin-probar` no escribe nada si la aprobación falla; `--deshacer`.
- informe: la PR muestra el motivo.
- Orca: el ⋯ ofrece «Saltear probar…» solo si `puedeSaltearProbar`; el worker arma los comandos.
