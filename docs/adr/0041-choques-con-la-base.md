# 0041 · Los choques con la base se resuelven en la entrega

Estado: Aceptada · 2026-11-18

## Contexto

Mientras un run trabaja, o mientras su PR espera el merge, se mergean otras PRs en la base. Si tocan
los mismos archivos, la PR deja de poder mergearse en GitHub y el choque lo resolvía la persona a
mano, con el run ya entregado.

## Decisión

1. **Se detecta en memoria**, con `git merge-tree` de la rama contra `origin/<base>`, sin tocar el
   worktree ni preguntarle a GitHub: el `mergeable` de GitHub se calcula tarde y a veces dice
   `UNKNOWN`, y el merge local da la misma respuesta.
2. **Dónde**: entregar, antes de proponer lecciones y de empujar, con `HEAD`; y aprender, en cada
   chequeo con la PR abierta y sin feedback pendiente, con la rama de GitHub. Si aprender ve un choque,
   primero trae al worktree lo que la persona empujó (como con el feedback, ADR 0038), y el lease
   protege el push de la entrega que sigue.
3. **Cómo**: `git merge --no-ff --no-commit origin/<base>`. Una sesión (el modelo de implementar, con
   Read, Edit, Write, Grep y Glob, sin Bash) solo puede escribir los archivos que quedaron sin fusionar.
   Si no quedan marcas de conflicto, flowrunner commitea el merge.
4. **Después**: el código cambió, así que el run vuelve a verificar, y desde ahí pasa otra vez por
   revisar, probar y entregar. Es `reentrar` con `desde: verificar`, que solo pueden devolver entregar
   y aprender, sin feedback. Un tick que lo ve lanza el run en su proceso, o lo encola.
5. **Si no se puede**: un choque en un test bloqueado no lo resuelve un agente; tampoco una sesión que
   deja marcas de conflicto. flowrunner deshace el merge, el worktree queda como estaba y el run se
   detiene con una pregunta: resolverlo en el worktree y seguir con `resume`. Si lo resolviste ahí,
   aprender lo ve y vuelve a entregar.

## Consecuencias

- Un rebase reescribiría la rama de una PR abierta: se usa merge, como en el resto del repo.
- Un choque resuelto vuelve a correr la revisión y probar, que cuestan; es lo que pasa con cualquier
  cambio al código.
- Cada chequeo con la PR abierta hace un `git fetch` del repo.
