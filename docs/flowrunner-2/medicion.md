# Medición de flowrunner 2.0

Contra qué se compara cada cambio de flowrunner 2.0, y cómo se mide una feature hecha directo en Claude Code
para contestar si el harness rinde más que trabajar sin él. La decisión de qué queda por defecto se escribe en
`resultado.md`, al cerrar la Fase 5.

## Línea de base

La versión actual de flowrunner corrió PIZ-44 a PIZ-53 en pizarra-en-vivo, con `vueltas: 3` y `vuelta_directa: true`.
Los runs anteriores no cuentan: son de versiones con otras reglas de vueltas y de probar. `PIZ-51-20261118-152506` se
abortó antes de planificar y no cuenta; su reintento, `PIZ-51-20261118-152736`, sí.

| Run    | Activo | US$   | Rechazos Bash/escritura | Vueltas | Derecho | Aclaraciones | Lecciones propuestas |
| ------ | ------ | ----- | ----------------------- | ------- | ------- | ------------ | -------------------- |
| PIZ-44 | 38 min | 9.87  | 5/0                     | 3       | no      | 4            | 1                    |
| PIZ-45 | 11 min | 2.63  | 3/0                     | 1       | no      | 5            | 0                    |
| PIZ-46 | 9 min  | 2.29  | 0/0                     | 1       | no      | 3            | 1                    |
| PIZ-47 | 38 min | 10.66 | 6/0                     | 1       | no      | 7            | 2                    |
| PIZ-48 | 18 min | 5.24  | 2/0                     | 1       | no      | 4            | 1                    |
| PIZ-49 | 99 min | 25.71 | 27/0                    | 10      | no      | 6            | 2                    |
| PIZ-50 | 25 min | 6.12  | 5/0                     | 1       | no      | 7            | 2                    |
| PIZ-51 | 22 min | 6.86  | 3/0                     | 0       | sí      | 4            | 0                    |
| PIZ-52 | 25 min | 7.25  | 3/0                     | 0       | sí      | 4            | 0                    |
| PIZ-53 | 6 min  | 1.30  | 0/0                     | 0       | no      | 1            | 0                    |

| Métrica                                | Base                  |
| -------------------------------------- | --------------------- |
| Tiempo activo por run, mediana         | 23,5 min              |
| Tiempo activo, el run más largo        | 99 min (PIZ-49)       |
| Costo por run, mediana                 | US$ 6,49              |
| Vueltas por run                        | 1,8                   |
| Runs sin ninguna vuelta                | 3 de 10               |
| Runs derechos (sin vueltas ni fallas)  | 2 de 10               |
| Rechazos de Bash por run, mediana      | 3                     |
| Aclaraciones por feature, mediana      | 4                     |
| Preguntas del planificador por run     | no existen todavía    |
| Lecciones propuestas por run, promedio | 0,9                   |
| Aprobar el plan                        | 10 de 10, por la persona |

### Cómo se reproduce

- **Activo, US$, rechazos, vueltas y derecho:** `flowrunner stats --runs pizarra-en-vivo`, filas de PIZ-44 a PIZ-53.
  Activo es la suma del tiempo de las fases, sin lo que el run esperó por la persona.
- **Aclaraciones:** `grep -c '^- P:' ~/.flowrunner/features/pizarra-en-vivo/PIZ-<n>.md`.
- **Lecciones propuestas:** el último evento `lecciones_propuestas` de `~/.flowrunner/runs/<run>/events.jsonl`, campo
  `cantidad`.
- **Preguntas del planificador:** desde T1.3, los eventos de detención de planificar con `pregunta` del run.

## Protocolo para una feature hecha directo en Claude Code

1. Escribí la feature con la skill de flowrunner, igual que para un run: el mismo ping pong y el mismo `feature.md`.
   Pasá `flowrunner feature check` hasta que salga `ok`.
2. Abrí una sesión nueva de Claude Code en el repo, en una rama nueva, sin flowrunner. El primer mensaje es el
   contenido del `feature.md` y el pedido de implementarla, con tests de los criterios y la PR abierta.
3. Corregí lo que haga falta conversando, como harías con cualquier sesión. Cada corrección cuenta.
4. Cuando la PR está abierta, anotá en la planilla:
   - **Activo:** el tiempo de la sesión desde el primer mensaje hasta la PR abierta, sin las pausas largas tuyas.
   - **US$:** lo que dice `/cost` al final de la sesión.
   - **Correcciones:** cuántas veces tuviste que pedirle que arregle algo. Es lo comparable a las vueltas.
   - **Bugs después del merge:** los que aparezcan en la semana siguiente, con el commit que los arregla.
5. Para comparar en igualdad, a la PR de una feature hecha con flowrunner también se le anotan los bugs de la
   semana siguiente.

## Planilla

Una fila por feature. `Modo` es `sub_tasks`, `una_sesion` o `directo`. En los runs de flowrunner, `Correcciones`
son las vueltas más tus respuestas que mandaron a arreglar algo.

| Feature | Modo | Activo | US$ | Correcciones | Preguntas del planificador | Aclaraciones | Lecciones | Bugs después del merge |
| ------- | ---- | ------ | --- | ------------ | -------------------------- | ------------ | --------- | ---------------------- |
