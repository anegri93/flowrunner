# 0036 · La persona puede saltear probar antes de que arranque

Estado: Aceptada · 2026-11-17 · Amplía 0017 y 0032

## Contexto

Probar se saltea sola cuando el repo no configuró `probar` o cuando ningún criterio se ve en el
entorno (ADR 0032). Fuera de eso corre siempre: levanta el entorno, abre una sesión y, si deja
criterios sin probar, detiene el run hasta que la persona decide entregar igual con `accept-untested`
(ADR 0017). Hay features en las que la persona ya sabe, con el plan a la vista, que no vale la pena
probar en el entorno: un cambio de docs, uno de la CLI, un entorno que hoy no levanta. Probar gasta la
sesión y los minutos, y a veces frena el run para preguntar lo que la persona ya sabía.

## Decisión

1. **Saltear probar es una decisión de la persona, con motivo**, como entregar sin probar: el motivo
   queda en el informe y en la PR («⚠️ No se probó en el entorno, por decisión de la persona: …»).
2. **Solo antes de que probar arranque**: al aprobar (`approve --sin-probar "<por qué>"`) o con
   `skip-probar <run> "<por qué>"` mientras el run está antes de probar, o en probar en cola o pausado.
   Si probar ya arrancó, se espera su resultado y, si se detiene, vale `accept-untested`.
3. **Son eventos del log**, `probar_salteado` y `probar_restaurado` (`skip-probar --deshacer`). El
   reductor los ignora si probar ya arrancó; el CLI relee el estado después de escribir y, si el run
   entró a probar mientras tanto, lo dice en vez de confirmar algo que no pasó.
4. **El runner no corre la fase**: deja el aviso y `ok` con `salteada: "la salteó la persona: …"`, el
   mismo resultado que cuando probar se saltea sola. No levanta el entorno, no toma su turno ni abre
   sesión.
5. **`rerun --desde probar` borra la marca**, porque pedir rehacer probar es pedir probar. Un replan,
   `changes` o `rerun` desde una fase anterior la mantienen.
6. **`approve --sin-probar` valida todo antes de escribir**: si la aprobación no pasa (sin motivo, sin
   `--acepto-cambios`, una dependencia sin versión), no queda la marca suelta.

## Alternativas descartadas

- **Solo como opción de `approve`.** No cubre un run que ya pasó la aprobación.
- **Cortar probar mientras corre.** Corta una sesión con el entorno levantado y fallas puestas; la
  persona no lo pidió.
- **Un flag en la feature, al lanzarla.** La persona prefirió decidirlo con el plan a la vista.
