# 0005 · Autenticación con la suscripción

Estado: Aceptada · 2026-11-07

## Decisión
Las sesiones se autentican con el token de `claude setup-token`, guardado en el Keychain y pasado como variable de entorno. Pasar a API key cambia solo esa variable.

## Consecuencias
- flowrunner es de uso personal. Antes de ofrecerlo a otras personas hay que pasar a API key o confirmarlo con Anthropic.
