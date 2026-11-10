# 0019 · Varios runs por repo, con tope, cola y turnos

Estado: Aceptada · 2026-11-09 · Reemplaza la regla de un run por repo de la spec v0 (Reanudación)

## Contexto

La spec v0 da un lock por repo: `flowrunner run` se niega si otro run lo tiene, y un run en
`esperando_aprobacion` o `pausado_por_limite` lo conserva sin proceso. Un plan que espera aprobación
bloquea el repo, y no se pueden avanzar dos features del mismo repo a la vez. El lock no ordenaba
las lecciones entre runs: se suelta en `entregado`, antes del merge. Lo que sí evitaba es que dos
runs compartan el entorno de `verify` y `probar`, el `.git` del checkout y la PR de lecciones.

## Decisión

- **Hasta `max_runs` runs activos por repo**, por defecto 2. Esperar suelta el lugar.
- **El que no encuentra lugar queda `en_cola`**, sin proceso, y sale el más viejo primero. Lo
  despacha el proceso que suelta un lugar, y `tick` como respaldo.
- **Turnos con nombre** para lo compartido: `entorno` (verify, comandos de criterio en verificar y
  probar, hasta 2 horas de espera), `git` (fetch, push y worktrees, en el `.git` común) y
  `lecciones` (la PR de aprender). Contar lugares y despachar la cola también van con turno.
- **Dos runs vivos de la misma clave no se permiten:** trabajarían en la misma rama.
- **Al aprobar un plan se avisa** si su alcance se pisa con el de otro run cuya PR no se cerró. No
  bloquea.

Detalle en `docs/specs/2026-11-09-varios-runs-por-repo.md`.

## Alternativas descartadas

- Un planificador de larga vida por repo: contradice el ADR 0010.
- Un entorno por run con puertos asignados: cada repo tendría que adaptarse, y una base local como
  la del ADR 0018 no se duplica.
- Bloquear el plan que se pisa con otro: muchos cambios al mismo archivo no chocan.

## Verificación

`src/store/lugares.test.ts`, `src/store/turno.test.ts`, `src/cli/approval.test.ts` y
`test/varios-runs.int.test.ts`, según la spec.
