# 0044 · Aprobar el plan solo cuando hace falta

Estado: Aceptada · 2026-11-19 · Depende de 0043

## Contexto

En los 33 runs de pizarra-en-vivo, la persona aprobó 33 de 33 planes sin pedir cambios, con una mediana
de 27 segundos desde que el plan la esperó, y 23 en menos de un minuto. Leer un plan de 10 mil caracteres
en ese tiempo no se puede: aprobar no estaba decidiendo nada. Con ADR 0043 las decisiones de producto se
toman en la conversación de la feature, y el planificador pregunta las que faltan en vez de tomarlas.
Lo que queda en el plan es técnico.

Los cambios a lo que ya existe sí se aceptaban al aprobar (`--acepto-cambios`), pero los 180 que hubo en
esos runs citaban un criterio de la feature: la persona los había pedido al escribirla.

## Decisión

1. **`aprobar: siempre | si_hace_falta`** en la config del repo, por defecto `siempre`. Se congela en
   `run_creado`: un run sin el campo espera como siempre, y un run en curso no cambia al editar la config.
2. **Con `si_hace_falta`, la fase aprobar sigue sola** después de fijar las versiones de las dependencias
   (ADR 0029): escribe `aprobado` con `origen: "flowrunner"` y los cambios aceptados, y devuelve `ok`.
3. **Una dependencia sin versión que sirva espera a la persona** igual que con `siempre`: elegir otra
   librería o subir el Node del repo es una decisión suya (PIZ-3).
4. **Los cambios a lo que ya existe se aceptan por el criterio que citan** y van en la PR y en el informe
   como hasta ahora. La persona los ve en la PR, no antes de implementar: lo aceptó al pedir esta versión.
5. **El informe lo dice**: «flowrunner aprobó el plan solo: no había nada que decidir, sin esperarte», con
   los cambios aceptados. Watch no lo muestra como una respuesta tuya.

## Alternativas descartadas

- **Sacar aprobar del todo.** Un repo puede seguir queriendo ver cada plan, y una dependencia sin versión
  necesita a la persona.
- **Aprobar solo si el plan no cambia lo que existe.** 30 de los 33 runs cambiaban algo: aprobar seguiría
  esperando casi siempre, por cambios que la feature ya pedía.

## Verificación

- `src/phases/aprobar.test.ts`, «aprobar solo cuando hace falta»: con `si_hace_falta` y versiones
  resueltas sigue sola y deja `aprobado` de flowrunner; con una dependencia sin versión espera; con
  `siempre`, o sin el campo, espera.
- `src/report/report.test.ts`: el informe dice que flowrunner aprobó el plan solo, con los cambios.
