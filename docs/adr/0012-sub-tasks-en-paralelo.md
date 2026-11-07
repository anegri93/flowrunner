# 0012 · Sub-tasks en paralelo

Estado: Aceptada · 2026-11-07

## Decisión
Las sub-tasks sin dependencia entre sí corren a la vez, cada una en su worktree, si sus alcances de rutas concretas son disjuntos. Se integran por cherry-pick.

## Consecuencias
- El gate de planificar rechaza alcances que se pisan.
- Cada worktree corre el setup del proyecto.
