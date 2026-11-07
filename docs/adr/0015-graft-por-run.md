# 0015 · El índice de graft se construye fuera del repo, una vez por run

Estado: Aceptada · 2026-11-07 · Resuelve el punto abierto 4 de la spec

## Evidencia

graft 0.18.0, medido el 2026-11-07:

- **Tiempo:** `graft build` sobre una copia de flowindex, 426 archivos versionados y 3.060 símbolos,
  tardó 3,6 s reales y dejó un índice de 18 MB. No es un costo que haya que optimizar.
- **Efectos en el repo:** sin `--dir`, en un repo que no ignora `graft/`, `graft build` crea
  `.gitignore` e `.ignore` y el directorio `graft/`. Con `--dir` fuera del repo igual deja
  `graft/.cache/telemetry-repo-id.json`. Con `--dir` y `DO_NOT_TRACK=1` el worktree queda limpio.
- **Portabilidad:** el índice no tiene rutas absolutas. Copiado a otro clon del mismo repo, `graft check`
  lo da por sincronizado y `graft mcp` responde igual.

## Decisión

- El índice vive en `runs/<id>/graft/`, nunca dentro de un worktree. Se construye con
  `graft --dir <índice> build <worktree>` y `DO_NOT_TRACK=1`; el servidor MCP corre con
  `graft --dir <índice> mcp <worktree>` y el mismo entorno. Lo implementa `src/graft/graft.ts`.
- Se construye una vez en preparar, sobre el worktree de la feature, para planificar. Antes de revisar
  se reconstruye, porque implementar cambió el código. Las sub-tasks no usan graft.

## Verificación

`test/graft.int.test.ts`, con el graft real: construir no deja nada en el worktree, el servidor responde
con archivos reales del repo, y un índice copiado responde desde otro clon. Canarios: quitar `--dir` o
quitar `DO_NOT_TRACK` pone en rojo el primer caso.

## Consecuencias

- CI y cualquier máquina que corra flowrunner necesitan `graft` instalado; `flowrunner doctor` lo revisa.
