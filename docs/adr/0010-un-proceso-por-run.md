# 0010 · Un proceso por run, con el estado en un log de eventos

Estado: Aceptada · 2026-11-07

## Decisión
Cada run es un proceso separado con su estado en events.jsonl, de solo agregar. La máquina de estados es una función pura sobre el log. No hay daemon.

## Alternativas descartadas
- Daemon con SQLite: es la infraestructura de la que se sale.
- Un agente orquestador: el modelo decidiría las transiciones.
