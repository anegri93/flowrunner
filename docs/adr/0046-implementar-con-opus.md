# 0046 · Implementar con Opus por defecto

Estado: Aceptada · 2026-11-19

## Contexto

Hasta ahora planificar y revisar usaban Opus 5.5 y el resto de las fases Sonnet 5.5. En los runs de
pizarra-en-vivo, todo lo que la revisión devolvió lo había escrito Sonnet al implementar, y la persona ve
que falla seguido. No está medido contra Opus implementando: puede venir también del plan, que la sub-task
lee por partes. Pero la persona prefiere calidad a costo en lo que escribe código.

## Decisión

1. **Planificar, implementar y revisar usan Opus 5.5 en esfuerzo alto** por defecto. Implementar es el único
   que cambia.
2. **El resto sigue con Sonnet:** probar (alto) es mecánico y es la fase más larga; explorar, aprender y
   explicar (medio) buscan, resumen o escriben algo que la persona revisa.
3. **Un repo lo cambia en `models` de su config**, fase por fase, como siempre.

## Alternativas descartadas

- **Opus en todas las fases.** Paga varias veces más en probar, la fase más larga, sin que Sonnet haya fallado
  ahí por inteligencia: lo que se le escapaba eran herramientas bloqueadas.
- **Opus solo por repo, en la config de pizarra.** La persona usa flowrunner en tres repos y quiere lo mismo en
  todos.

## Consecuencias

El costo de implementar sube: en PIZ-54, las cuatro sub-tasks con Sonnet costaron US$ 1,04. `stats --runs`
deja ver el costo por run contra la línea de base de `docs/flowrunner-2/medicion.md`. El experimento de una
sola sesión (ADR 0045) sigue aparte: con `implementar: una_sesion`, implementar usa el modelo de planificar.

## Verificación

`src/config/config.test.ts`, «por defecto, planificar, implementar y revisar usan Opus 5.5 alto; el resto,
Sonnet»: rojo con los valores de antes.
