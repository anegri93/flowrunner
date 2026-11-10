# 00 · Guía para implementar el plan de raíz

Para la sesión que implementa, con Opus 5.5 y esfuerzo alto en Claude Code. El porqué está en
`docs/specs/2026-11-09-por-que-falla-y-tarda.md` y `docs/specs/2026-11-09-plan-de-raiz.md`. Los
contratos que comparten las PRs están en `01-contratos.md`. Cada PR tiene su spec, `pr-NN-*.md`.

**Las specs ya tomaron todas las decisiones de diseño.** El trabajo es implementarlas tal cual. Si
algo de una spec no cierra con el código, se detiene y se pregunta (regla 6); no se improvisa.

## Antes de empezar (lo hace la persona)

1. **Mergear las PRs abiertas, en este orden:** #70, #71, #72, #69 (reapuntada a `main`) y la PR de
   `docs/diagnostico-runs`, que trae estas specs. Las specs están escritas contra `main` con esas
   cuatro adentro.
2. **No lanzar runs de flowrunner** hasta que la PR 01 esté mergeada y se haya corrido
   `flowrunner self-update`. Hasta entonces, los runs corren desde el checkout de desarrollo, y
   cambiar de rama ahí los rompe (ML-1).
3. **Opcional:** `max_runs: 1` en los repos, hasta que se mergee la PR 05.

## Reglas para quien implementa

1. **Nunca cambies de rama en `~/Documents/PersonalProjects/flowrunner`.** Trabajá en un worktree
   aparte:

   ```sh
   git -C ~/Documents/PersonalProjects/flowrunner fetch origin
   git -C ~/Documents/PersonalProjects/flowrunner worktree add ~/Documents/PersonalProjects/flowrunner-impl -b feat/instalacion-separada origin/main
   cd ~/Documents/PersonalProjects/flowrunner-impl && pnpm install --frozen-lockfile
   ```

2. **Una PR, una rama.** Cada rama sale de la rama de la PR anterior, en el orden de la tabla de
   abajo, y su PR apunta a esa rama como base. Así ninguna PR espera a que se mergee la anterior.
   Cuando la persona mergea una, GitHub reapunta la siguiente a `main`.

   ```sh
   git switch -c <rama de la PR NN> <rama de la PR NN-1>
   ```

3. **Primero los tests, y verlos fallar.** Por cada PR:
   1. Leé la spec entera y los archivos que nombra.
   2. Escribí los tests de su sección «Tests», con el nombre exacto que dice ahí.
   3. Corrélos, y confirmá que fallan por el motivo que dice la spec, no por un error de sintaxis o
      de import.
   4. Implementá los cambios de «Cambios, archivo por archivo».
   5. Corré la verificación (regla 4) hasta que todo esté en verde.

4. **La verificación de cada PR:**

   ```sh
   pnpm lint            # eslint + prettier --check + tsc
   pnpm test            # unit
   pnpm test:integration
   pnpm orca:test       # solo si la PR toca orca/
   ```

   - **Orca:** en `pnpm orca:test`, el test «lee solo los runs del proyecto enfocado en Orca y cuenta
     los demás; sin permiso, todos» ya falla en `main`. Cualquier otra falla es tuya.
   - **Fallas intermitentes:** si un test de integración falla de a ratos, corré la suite 3 veces. Si
     viene de tu cambio, arreglalo; si ya fallaba así, anotalo en la PR. No cambies tiempos ni
     esperas de un test para que pase.
   - **No corras `pnpm smoke`:** usa la suscripción y cuesta plata.

5. **No uses flowrunner para implementar esto, ni lances runs** contra repos reales.
6. **Cuándo detenerse y preguntar.** Si una spec pide algo que el código no permite (una función que
   no existe o hace otra cosa, un contrato de `01-contratos.md` que no se puede cumplir, dos specs que
   se contradicen), **detenete y preguntá**, con la cita exacta de la spec y del código. Un número de
   línea corrido, con la función igual, no es motivo para detenerse.
7. **Los commits:** formato Conventional Commits (`feat(scope): …`, `fix(scope): …`), con el asunto
   en inglés, como el historial del repo, y el cuerpo diciendo por qué. Al final de cada commit:

   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```

8. **Antes de abrir cada PR:** revisá el diff con el agente `harness-engineering-code-reviewer`, con Opus y esfuerzo alto, y
   corregí lo que confirme. Después abrí la PR con `gh pr create --base <rama anterior>`.
9. **El cuerpo de la PR, en español:**
   - qué pasaba, con el incidente que cita la spec;
   - qué cambia;
   - la sección **Tests**: cada test nuevo o cambiado por su nombre, con una línea sobre qué afirma
     y qué comportamiento roto atraparía, confirmado fallando antes del cambio;
   - lo que no cubre ningún test, y por qué;
   - las cuentas de la suite, al final;
   - la línea `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## El orden

| Orden | Spec | Rama | Base de la PR |
|---|---|---|---|
| 1 | `pr-01-instalacion-separada.md` | `feat/instalacion-separada` | `main` |
| 2 | `pr-02-stats-runs.md` | `feat/stats-por-run` | `feat/instalacion-separada` |
| 3 | `pr-03-politica-de-comandos.md` | `feat/politica-de-comandos` | `feat/stats-por-run` |
| 4 | `pr-04-contexto-graft-subtasks.md` | `feat/contexto-graft` | `feat/politica-de-comandos` |
| 5 | `pr-05-detenido-con-pregunta.md` | `feat/detenido-con-pregunta` | `feat/contexto-graft` |
| 6 | `pr-06-subtask-trabada-pregunta.md` | `feat/subtask-trabada-pregunta` | `feat/detenido-con-pregunta` |
| 7 | `pr-07-reintentos-de-red.md` | `fix/reintentos-de-red` | `feat/subtask-trabada-pregunta` |
| 8 | `pr-08-origen-y-boton-orca.md` | `feat/origen-y-boton-orca` | `fix/reintentos-de-red` |
| 9 | `pr-09-replan-conserva-codigo.md` | `feat/replan-conserva-codigo` | `feat/origen-y-boton-orca` |
| 10 | `pr-10-gate-rechazado-resume.md` | `perf/gate-rechazado-resume` | `feat/replan-conserva-codigo` |
| 11 | `pr-14-imposibles-antes.md` | `feat/imposibles-antes` | `perf/gate-rechazado-resume` |
| 12 | `pr-11-validar-plan.md` | `perf/validar-plan` | `feat/imposibles-antes` |
| 13 | `pr-12-contexto-del-planificador.md` | `feat/contexto-del-planificador` | `perf/validar-plan` |
| 14 | `pr-13-explorar-antes.md` | `feat/explorar-antes` | `feat/contexto-del-planificador` |

**La PR 14 va antes que la 11:** así `validar_plan` nace llamando igual que el gate de afuera, con
`delRun` y `esVerify`, y la spec 11 se aplica en su variante «con la PR 14 mergeada».

**Dependencias reales,** para no tropezar si se cambia el orden:

- 04 (`contextoGraft`, `llamadoresDe`) la usan 09, 12 y 13.
- 05 (`detenido` con pregunta, `opcionesDe`) la usan 06, 07 y 08.
- 14 cambia `checkPlanShape` y suma `delRun`: 11 tiene que llamar igual que el gate de afuera.
- 03 y 04 reescriben `prompts/implementar.md`: 04 va después de 03.
- **Números de línea que se corren:** la 10 parte `planificar.ts` en `intentoNuevo`,
  `intentoRetomado` y `gateYCierre`. Lo que la 14 dice para las líneas 175, 197 y 228 de
  `planificar.ts` se aplica dentro de `gateYCierre`. Lo que la 11 saca a `chequeosEstaticos`
  (`src/gates/estaticos.ts`) se lleva el cambio de la 14 con él. Las specs 06 y 07 citan
  `implementar.ts` en la versión de #70: con #72 adentro, ubicá cada cambio por el fragmento de código
  que citan, no por el número.

**Los ADR,** por orden de PR:

| PR | ADR |
|---|---|
| 01 | 0020 · flowrunner corre desde un worktree fijo |
| 03 | 0021 · política de comandos |
| 04 | 0022 · contexto de graft calculado |
| 05 | 0023 · detenerse y preguntar (06, 07 y 08 le suman párrafos) |
| 09 | 0024 · el replan conserva código |
| 10 | 0025 · planificar retoma tras el gate |
| 11 | sin ADR: suma una línea a «Consecuencias» del 0011 |

## Al terminar

- Las 14 PRs abiertas, apiladas, cada una en verde.
- **Un resumen para la persona:**
  - qué PRs hay y en qué orden se mergean;
  - qué quedó fuera de cada una;
  - cualquier decisión que se haya tenido que preguntar.
- **Después de mergear,** la persona corre `flowrunner self-update`, lanza 5 features reales y
  compara con `flowrunner stats --runs` contra la línea de base del plan. Eso es la fase 6.

## El prompt para la sesión que implementa

> Implementá el plan de raíz de flowrunner. Leé primero
> `docs/plan-de-raiz/00-guia.md` y `docs/plan-de-raiz/01-contratos.md`, y seguí la guía al pie de
> la letra: una PR por spec, en el orden de la tabla, cada rama sobre la anterior, en un worktree en
> `~/Documents/PersonalProjects/flowrunner-impl`. Nunca cambies de rama en
> `~/Documents/PersonalProjects/flowrunner`. Por cada spec: los tests primero, verlos fallar por el
> motivo que dice la spec, implementar, y `pnpm lint && pnpm test && pnpm test:integration` en
> verde. Revisá el diff con el agente `harness-engineering-code-reviewer` y abrí la PR. Las specs ya
> decidieron el diseño: si algo no cierra con el código, detenete y preguntame, con la cita de la
> spec y del código. Al terminar, resumime las PRs y el orden de merge.
