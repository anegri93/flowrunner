# 0009 · Las lecciones se escriben solas al mergear

Estado: Aceptada · 2026-11-07

## Contexto
En flowindex las lecciones esperaban aprobación una por una y no se generó ninguna.

## Decisión
Al mergear la PR, flowrunner escribe lecciones a partir de los commits y comentarios de la persona, y las lleva a la base por una PR con auto-merge que solo puede tocar lecciones.md.

## Consecuencias
- Lo escrito por otra persona nunca entra al cerebro.
- Una consolidación por tope se abre sin auto-merge.
