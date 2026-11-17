# 0009 · Las lecciones se escriben solas al mergear

Estado: Aceptada · 2026-11-07

## Contexto
En flowindex las lecciones esperaban aprobación una por una y no se generó ninguna.

## Decisión
Al mergear la PR, flowrunner escribe lecciones a partir de los commits y comentarios de la persona, y las lleva a la base por una PR con auto-merge que solo puede tocar lecciones.md.

## Consecuencias
- Lo escrito por otra persona nunca entra al cerebro. Un merge de la persona (traer la base a la rama) tampoco es una corrección.
- Las lecciones que propone el run de una feature van en `.flowrunner/propuestas/<clave>.md` dentro de su PR; al mergear, aprender las numera y las pasa a lecciones.md en la misma PR de lecciones. Una PR de lecciones abierta a la vez: dos features nunca eligen el mismo número.
- Una consolidación por tope se abre sin auto-merge. Si el repo tiene `.flowrunner/lecciones-detalle.md` (el porqué de cada lección, con el mismo número), la consolidación lo reescribe también, y falla si deja entradas de lecciones que ya no están.
