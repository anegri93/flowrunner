# 0004 · TypeScript sobre el Claude Agent SDK

Estado: Aceptada · 2026-11-07

## Contexto
El SDK permite revisar cada herramienta antes de que corra, validar la salida con un schema y aislar la sesión de la configuración del usuario.

## Decisión
TypeScript estricto, Node 24, pnpm 10, Zod y Vitest. Todo el contacto con el SDK pasa por src/agent/.

## Alternativas descartadas
- Go reutilizando flowindex: los tripwires solo podían mirar el diff después de la sub-task.
