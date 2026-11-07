# 0014 · Aislamiento de la sesión y señal del límite de la suscripción

Estado: Aceptada · 2026-11-07 · Resuelve los puntos abiertos 2 y 3 de la spec

## Evidencia

Agent SDK 0.3.319, CLI 2.1.319, Haiku 5.5, sobre `test/toy-repo`, que trae un `.mcp.json` con
`repo-mcp`, un hook `SessionStart` en `.claude/settings.json` y un `CLAUDE.md` con una palabra clave.

- **Solo `settingSources: []` no alcanza.** En el experimento del ADR 0013, una sesión con
  `settingSources: []` cargó los conectores de claude.ai de la persona: Slack, Atlassian, n8n y otros.
- **Con `settingSources: []`, `strictMcpConfig: true`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` y graft
  como único servidor**, el mensaje `init` lista exactamente `["graft"]`, el hook del repo no corre y
  la sesión no conoce la palabra clave del `CLAUDE.md`.
- **Con las fuentes por defecto**, entran `repo-mcp`, el hook y la palabra clave. Es el canario del
  smoke `smoke/isolation.smoke.ts`.
- **Señal del límite:** cada sesión emite mensajes `rate_limit_event` con `rate_limit_info`:
  `status` es `allowed`, `allowed_warning` o `rejected`; `rateLimitType` puede ser `five_hour`;
  trae `resetsAt` en segundos epoch y, a veces, `utilization`. Se vio en todas las sesiones grabadas.

## Decisión

- Las opciones de toda sesión de flowrunner llevan `settingSources: []`, `strictMcpConfig: true` y
  solo los servidores que declare la fase. El entorno lleva `ENABLE_CLAUDEAI_MCP_SERVERS=false` y
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- `src/agent/` trata un `rate_limit_event` con `status: "rejected"` como límite: el run pasa a
  `pausado_por_limite` y se retoma después de `resetsAt`. Con `allowed_warning` se registra el evento
  y la fase sigue.
- Los streams grabados quedan en `test/fixtures/streams/` como base de los tests sin modelo.

## Consecuencias

- La pausa por límite se decide con un dato del SDK, no adivinando por el texto de un error.
- El agotamiento de reintentos de schema no se pudo provocar en real; su fixture es sintético y lo dice.
