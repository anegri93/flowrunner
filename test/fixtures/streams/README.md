# Streams de fixture

Sesiones reales del Agent SDK 0.3.319, CLI 2.1.319, Haiku 5.5 con effort low, grabadas el
2026-11-07 con `scripts/record-streams.ts` sobre `test/toy-repo`. Las rutas del repo se reemplazaron
por `/REPO` y el home por `/HOME`.

| Archivo | Qué tiene |
|---|---|
| `leer-y-editar.jsonl` | Read y Edit permitidos por el hook; termina en `success`. |
| `bash-permitido-y-negado.jsonl` | `node --test` permitido y `rm -rf src` negado con motivo. |
| `salida-estructurada.jsonl` | `outputFormat` con schema; el resultado trae `structured_output`. |
| `cortada-por-timeout.jsonl` | Cortada con `abortController` a mitad de camino; sin mensaje `result`. |
| `schema-agotado.jsonl` | **Sintético:** `salida-estructurada.jsonl` con el `result` cambiado a `error_max_structured_output_retries`, forma tomada de los tipos del SDK. No se logró provocar el agotamiento real con un schema razonable. |

Todos traen al menos un `rate_limit_event` real con `rateLimitType: "five_hour"`.
