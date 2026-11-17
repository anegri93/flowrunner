# 0032 · Probar ejercita solo los criterios que se ven en el entorno

Estado: Aceptada · 2026-11-17 · Amplía 0016 y 0017

## Contexto

Entre PIZ-9 y PIZ-16 (pizarra-en-vivo, 2026-11-12), 7 de 8 runs terminaron probar con «N criterios
sin probar», y la persona aceptó entregar igual en todos. Los motivos se repetían: el entorno corre
con el generador de prueba y no lanza Claude, no puede armar la app de Mac, no puede mandar SIGTERM a
un proceso, no corre vitest. Esos criterios ya los cubría su test de aceptación, en verde en
verificar. Probar gastó 36 minutos en los 8 runs sin encontrar un bug, y cada «sin probar» frenó el run
hasta que la persona respondió.

## Decisión

1. **Cada criterio del plan lleva `en_entorno`**: `true` si una persona lo comprueba usando la app
   levantada, en una pantalla o con un pedido a la API; `false` si solo lo comprueba su test.
2. **Lo exige el gate solo si el repo configuró `probar`**, y no para los criterios del run (el verify).
   El campo es opcional en el schema: un plan de antes, o de un repo sin `probar`, no lo dice, y probar
   lo intenta como siempre.
3. **Probar no prueba los `false`**: el prompt los nombra como «solo lo prueba su test», y un
   `no_probado` de ellos no detiene el run, como el criterio que es el verify del repo.
4. **Si ninguno queda para probar** (todos son `false` o el verify del repo), probar se saltea sin
   levantar el entorno ni abrir sesión, con un aviso y la etapa «salteada» con su motivo. Después de
   un salto, el informe, la PR y la vista de la etapa no muestran pruebas de una corrida anterior.
5. **Con una instrucción de la persona** (`rerun --desde probar "…"`) probar no se saltea y prueba todos
   los criterios: puede estar pidiendo justo uno mal marcado.
6. **Un `no_probado` de un criterio que no se prueba acá no llega a `pruebas.json`** ni a la PR.
7. **El plan que se aprueba lo muestra**: «· solo su test, probar no lo prueba» al lado de cada
   criterio `false`, en `flowrunner plan` y en la vista de la etapa.

## Alternativas descartadas

- **Que un `no_probado` con test en verde no frene, sin tocar el plan.** Saca la detención pero no el
  tiempo: probar seguiría levantando el entorno e intentando lo que no puede ver.
- **Que probar decida solo qué se puede ver.** Lo intenta igual y gasta la sesión; el planificador, que
  escribió el test, es quien mejor sabe qué comprueba.

Una revisión con `/code-review high` de la PR #111 encontró los casos de los puntos 4 a 7.

## Verificación

- `src/gates/plan.test.ts`: con `probar` configurado, un criterio de sub-task sin `en_entorno` no pasa
  el gate; sin `probar`, no hace falta.
- `src/phases/probar.test.ts`: un criterio que solo prueba su test no se prueba ni frena el run como
  sin probar; si ningún criterio se ve, probar se saltea sin levantar el entorno ni abrir sesión,
  también si los que quedan son el verify; con una instrucción no se saltea; un `no_probado` de uno
  que no se prueba acá no llega a `pruebas.json`.
- `src/cli/approval.test.ts`: el plan que se aprueba dice qué criterios solo prueba su test.
- `src/report/report.test.ts`: si la última vez probar se salteó, el informe y la PR no muestran pruebas
  de antes.
