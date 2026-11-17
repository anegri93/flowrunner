# 0033 · El planificador escribe el plan una sola vez

Estado: Aceptada · 2026-11-17 · Amplía 0025

## Contexto

El prompt pedía pasar el plan por `validar_plan` «con el mismo JSON que vas a devolver», y después
devolverlo en la salida estructurada. En PIZ-9 a PIZ-16 (2026-11-12) los dos eran idénticos, de 13 a 20
mil caracteres: Opus escribía el mismo plan dos veces, unos 50 a 60 segundos por run (en PIZ-16, 63
segundos antes del `StructuredOutput`). Planificar es la fase más larga: 25% del tiempo de esos runs.

## Decisión

1. **`validar_plan` guarda el último plan que recibe** (`alValidar`), uno por intento.
2. **La salida de la sesión es el plan entero o `{}`** (`salidaPlanSchema`, el plan con todo opcional).
   Con `{}`, flowrunner usa el último que pasó por `validar_plan`. El prompt pide `{}` cuando ese es el
   definitivo, y el plan entero solo si cambió después de validarlo.
3. **Sin ninguno, o con un plan a medias, es un problema del gate** con qué hacer: el intento se rechaza
   y se retoma la misma sesión (ADR 0025), como cualquier otro rechazo.
4. **El gate de afuera no cambia**: corre todo sobre el plan que quedó, venga de la salida o de
   `validar_plan`.

## Alternativas descartadas

- **Que la salida sea solo `{ listo: true }`.** Un planificador que cambió el plan después de validarlo
  no tendría cómo devolverlo.
- **Sacar la salida estructurada y usar solo `validar_plan`.** Sin una salida que cierre la sesión, no
  hay cómo saber cuál de los planes validados es el final.

## Verificación

- `src/phases/planificar.test.ts`, «el plan se escribe una sola vez (ADR 0033)»: una salida vacía usa
  el último plan que pasó por `validar_plan`; vacía sin haber validado, o un plan a medias, es un
  rechazo del gate que deja la sesión para retomar.
