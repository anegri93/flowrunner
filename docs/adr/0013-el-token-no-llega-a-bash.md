# 0013 · El token de la sesión no llega a los procesos de Bash

Estado: Aceptada · 2026-11-07 · Resuelve el punto abierto 1 de la spec

## Contexto

Con `claude setup-token`, la sesión del SDK recibe `CLAUDE_CODE_OAUTH_TOKEN` en su entorno. El
agente corre comandos por Bash, y el código y los tests que escribe corren desde ahí.

## Evidencia

Agent SDK 0.3.319 con el CLI 2.1.319, sesión real de Haiku 5.5, `env` de la sesión con un centinela
`FLOWRUNNER_SENTINEL`:

- Sin nada más, el comando `env` lanzado por Bash **ve el centinela**. El entorno de la sesión llega
  completo a los procesos que lanza el agente; un token ahí sería legible por cualquier test.
- Con `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, el centinela **sigue visible**. Ese modo del CLI no limpia
  variables arbitrarias, fuerza el modo de permisos por defecto, y no hay forma de comprobar sin un
  token real qué limpia. No se usa.
- Con `settingSources: []` la sesión igual cargó los conectores de claude.ai de la persona. Lo trata
  el ADR 0014.
- El CLI necesita `USER` en el entorno para encontrar la sesión guardada en el Keychain; sin él
  responde "Not logged in".

## Decisión

- `src/agent/env.ts` arma el entorno de la sesión a mano: `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`,
  `LANG`, `SHELL`, las variables que apagan memoria y conectores, y el token.
- El hook `PreToolUse` reescribe cada comando de Bash permitido como
  `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN sh -c '<comando>'`
  con `updatedInput`. La lista vive en `SECRET_ENV_VARS`.
- Los comandos que corre el propio flowrunner, como `verify` y el ac-map, se lanzan con un entorno
  sin esas variables.

## Verificación

- `src/agent/env.test.ts`: el comando reescrito no ve un token puesto en su entorno, conserva comillas
  y variables que no son secretas, y conserva el código de salida.
- `smoke/env-leak.smoke.ts`: con el SDK real, con la reescritura el centinela no aparece; sin ella sí.
  El segundo caso es el canario del primero.

## Consecuencias

- Toda herramienta que ejecute procesos tiene que pasar por la reescritura; el deny por defecto del
  hook garantiza que no haya otra.
