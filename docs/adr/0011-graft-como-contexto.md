# 0011 · graft como contexto de planificar y revisar

Estado: Aceptada · 2026-11-07

## Decisión
Planificar y revisar reciben el grafo del repo como único servidor MCP.

## Consecuencias
- El tiempo de construir el índice se mide en el ADR 0015.
- Desde la PR 11, planificar también tiene el servidor `gate`, con `validar_plan`.
- Desde la PR 13, con `explorar_antes`, el explorador previo de planificar también tiene graft como
  herramienta, y nada más que leer.
