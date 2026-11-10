# PR 09 · Replanificar sin tirar el código

Rama: `feat/replan-conserva-codigo` · Depende de: PR 04 (`llamadoresDe`, C6). Usa el estado
`detenido` con pregunta de la PR 05, pero no la necesita para compilar · Tamaño: grande

## Objetivo

- **El incidente:** cada planificar vuelve la rama de la feature a la base
  (`resetHard(worktree, prep.base_sha)` en `src/phases/planificar.ts:107`). En VF-6, tres
  `rerun --desde planificar` reimplementaron ST-1 a ST-5 cuatro veces: implementar costó US$ 13,01, de
  los cuales unos US$ 9 fueron código que el plan nuevo no cambiaba.
- **La métrica:** en un replan, las sesiones de implementar son solo las de las sub-tasks nuevas o
  cambiadas. El costo de implementar de un run con replan baja a lo que cuesta implementar lo nuevo.

## Decisiones tomadas (no reabrir)

1. **Lo que se conserva lo decide el plan, sobre el código conservado a la vista.** El orden lo
   resuelve un ciclo de **dos pasadas sobre git**:
   - **antes de la sesión**, el worktree queda con **todas** las sub-tasks integradas de antes
     («candidatas»), para que el planificador vea el código;
   - **después de la sesión**, se rearma la rama solo con las que el plan marcó `conserva: true` y
     pasaron las validaciones.
2. **Las candidatas salen de git, no del log.** Son los commits de `base_sha..HEAD` con el trailer
   `Flowrunner-Subtask: ST-n`. El trailer lo pone `commitAll` en `implementar.ts` y lo conserva
   `cherryPick`. Los eventos `unidad` no alcanzan: un replan anterior pudo haber descartado commits que
   el log todavía nombra.
3. **Un commit de «lo arreglo yo»** (trailer `Flowrunner-Manual`, de la PR 05) se conserva siempre:
   se aplica al final, después de las sub-tasks conservadas. Si choca, se descarta con un aviso. No es
   una sub-task y el plan no lo puede marcar.
4. **`conserva` es opcional en `subtaskSchema`.** Si falta, vale `false`. Un `conserva: true`
   inválido es un **problema del gate**, no se ignora en silencio: con la PR 10, corregirlo cuesta un
   `resume` corto.
5. **Implementar marca las conservadas con el evento que ya existe:**
   `unidad { estado: "integrada", sha, motivo: "conservada del plan anterior" }`, al empezar su
   primera entrada después de la aprobación. **No hay estado de unidad nuevo:** watch y Orca ya
   muestran «integrada».
6. **Los SHAs nuevos de las conservadas pasan de planificar a implementar** por un artefacto del run,
   `conservadas.json`, no por el log.
7. **Los commits viejos no se pierden durante el replan:** antes de resetear, la punta vieja queda
   apuntada por `refs/flowrunner/<run.id>/anterior`.
8. **Si un cherry-pick choca** (no debería, porque se aplican en el mismo orden que antes), esa
   sub-task y todas las que dependen de ella dejan de ser candidatas, con un aviso, y se
   reimplementan.
9. **El orden de los commits en la rama nueva** es: la base, después los commits de las conservadas
   en su orden original, después los manuales, y al final el commit de los tests del plan nuevo.

## Cambios, archivo por archivo

### `src/gates/plan.ts`

- **`subtaskSchema`** (líneas 17–28) suma:

  ```ts
  /** Solo en un replan: la sub-task ya está implementada y su código se conserva tal cual. */
  conserva: z.boolean().optional(),
  ```

- **`effectiveScope`, `scopeOverlap` y `checkPlanShape`** no cambian.

### `src/gates/conserva.ts` (nuevo, puro, sin git ni graft)

```ts
import type { Plan, Subtask } from "./plan.ts";

/** Una sub-task implementada en la rama antes del replan. */
export interface Candidata {
  readonly id: string;
  /** Los commits de la rama vieja con su trailer, en orden. */
  readonly shas: readonly string[];
}

export interface ConservaInput {
  readonly plan: Pick<Plan, "subtareas" | "cambia_lo_existente">;
  /** Las sub-tasks del plan anterior, para comparar alcances. */
  readonly anteriores: readonly Subtask[];
  readonly candidatas: readonly Candidata[];
  /** Los pedidos de cambios y el motivo de este replan (`replanOf`), en texto. */
  readonly pedidos: readonly string[];
  /** Por cada `simbolo` de cambia_lo_existente, los archivos que lo llaman (de `llamadoresDe`). */
  readonly llamadores: ReadonlyMap<string, readonly string[]>;
}

/** Los problemas de cada `conserva: true`, como líneas del gate. Vacío si todo se puede conservar. */
export function checkConserva(input: ConservaInput): string[];

/** Las sub-tasks que se conservan: `conserva: true` y sin problemas. */
export function conservadas(input: ConservaInput): string[];
```

**Las reglas de `checkConserva`**, en este orden. Una sub-task acumula todos sus problemas:

| Regla | Mensaje |
|---|---|
| (a) El id está en `candidatas` | `${id} tiene conserva: true pero no estaba implementada: sacale conserva o dejala como nueva` |
| (b) El mismo id existe en `anteriores`, con el mismo conjunto de alcances, después de `normalize` | `${id} cambió su alcance (antes: ${a}; ahora: ${b}): no se puede conservar` |
| (c) Ningún texto de `pedidos` contiene `\bST-n\b` | `${id} la nombran los pedidos de cambios o el motivo del replan: no se puede conservar` |
| (d) Para cada `simbolo` con llamadores, ningún llamador cae en el alcance de la sub-task (`overlaps` de `plan.ts`) | `${id} llama a ${simbolo}, que el plan cambia (${archivo}): no se puede conservar` |
| (e) No depende, ni directa ni transitivamente (`depende_de`), de una sub-task sin conservar | `${id} depende de ${otra}, que no se conserva: no se puede conservar` |

- **`overlaps` y `normalize`** hoy son privados en `plan.ts`: se exportan, sin cambiarlos.
- **`ancestors`** (privado en `plan.ts`) se exporta para la regla (e).

### `src/phases/plan-anterior.ts`

- **`ARTIFACTS`** (línea 10) suma `"cambios-existentes.json"`, como opcional: `archivePlan` copia lo
  que existe y no falla si no está.
- **Tipo nuevo, para el prompt:**

  ```ts
  export interface Implementada {
    readonly id: string;
    readonly titulo: string;
    readonly alcance: readonly string[];
    readonly commits: number;
  }
  ```

- **`replanText(previous, replan)`** (líneas 56–97) pasa a
  `replanText(previous, replan, implementadas: readonly Implementada[] = [])`. Si `implementadas` no
  está vacía, después de «## El plan anterior» agrega:

  ```
  ## Ya implementado en el worktree

  Estas sub-tasks del plan anterior están implementadas y su código está en el worktree que ves.
  Si una sigue igual (mismo id, mismo alcance, y ni los pedidos ni el motivo de este intento la
  tocan), devolvela con `conserva: true`: su código queda y no se vuelve a implementar. Si cambia,
  devolvela con `conserva: false` o sin el campo: su código se saca antes de implementar.

  - ST-1 · <título> · <alcance, separado por comas> · <n> commits
  ```

### `src/phases/planificar.ts`

**Funciones nuevas en el mismo archivo** (o en `src/phases/conservar.ts` si pasa de 120 líneas;
mismo contrato):

```ts
/** Los commits de base..HEAD con su trailer de sub-task o de arreglo manual, en orden. */
async function commitsDeLaRama(
  worktree: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly subtasks: Candidata[]; readonly manuales: string[] }>;
// git log --reverse --format=%H%x09%(trailers:key=Flowrunner-Subtask,valueonly)%x09%(trailers:key=Flowrunner-Manual,valueonly) <base>..HEAD
// Agrupa por id, en el orden en que aparece cada id por primera vez.

/** Reaplica sobre `base` los commits pedidos; devuelve los SHAs nuevos por id y lo que chocó. */
async function rearmar(
  worktree: string,
  base: string,
  subtasks: readonly Candidata[],
  manuales: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly nuevos: Record<string, string[]>;
  readonly chocaron: string[];
  readonly manualesDescartados: string[];
}>;
// resetHard(base); por cada candidata, cherryPick de sus shas en orden; si uno choca, cherryPick ya
// hace --abort: esa candidata queda en `chocaron` y se saltean las que dependen de ella (lo resuelve
// el llamador con depende_de); después, los manuales.
```

**El flujo de `planificar`**, que reemplaza las líneas 95–111 (de `const previous = …` hasta
restaurar los tests):

1. `previous = archivePlan(run) ? readPlanAt(previousDir(run)) : undefined` (igual que hoy).
2. `restored` = los tests bloqueados del plan anterior que siguen con su hash (igual que hoy).
3. **Si `previous !== undefined`:**
   - `const rama = await commitsDeLaRama(worktree, prep.base_sha, deps.env)`;
   - si hay candidatas o manuales:
     - `git update-ref refs/flowrunner/<run.id>/anterior HEAD`;
     - se escribe `runs/<id>/candidatas.json` con `{ subtasks, manuales }`.
4. `await rearmar(worktree, prep.base_sha, rama.subtasks, rama.manuales, deps.env)`. Con 0
   candidatas es exactamente el `resetHard` de hoy. Por cada `chocaron`:
   `emit({ tipo: "aviso", fase: "planificar", texto: "${id} no se pudo reaplicar sobre la base: se va a reimplementar" })`,
   y se saca de candidatas, junto con lo que depende de ella según `previous.subtareas`.
5. Se restauran los archivos de `restored` en el worktree, sin commitear, igual que hoy.
6. **Si hubo candidatas,** se reconstruye el índice de graft sobre el worktree **antes de abrir la
   sesión del planificador**, igual que revisar lo reconstruye antes de revisar:
   `await buildIndex(worktree, graftIndex(run), deps.env)` (ADR 0015: segundos).
   - Lo usan `llamadoresDe` (paso 8) y el contexto de graft del planificador de la PR 12, que se arma
     con ese índice. Sin esto, el planificador vería la API de la base y no la del código conservado.
   - Si la PR 12 ya está mergeada, este paso va **antes** de que se arme su contexto.
7. `instruccion = replanText(previous, replanOf(...), implementadas)`, con `implementadas` armado de
   las candidatas que quedaron más `previous.subtareas`.

**Después de la sesión**, entre el descarte de lo ajeno (líneas 177–191) y
`const problems = [...]` (línea 193):

8. Si hubo candidatas:
   - `llamadores` = por cada `simbolo` de `plan.cambia_lo_existente`,
     `await llamadoresDe(worktree, graftIndex(run), simbolo, deps.env)`;
   - `problems.push(...checkConserva({ plan, anteriores: previous.subtareas, candidatas, pedidos: [...replan.pedidos, ...(replan.motivo === undefined ? [] : [replan.motivo])], llamadores }))`.
9. **Si no hay problemas de conserva** y hay alguna candidata que no se conserva, se rearma la rama:
   - se guardan en memoria los tests que escribió el planificador:
     `changesSince(worktree, base)` filtrado por `isTestFile`, con su contenido;
   - `rearmar(worktree, base, candidatas ∩ conservadas, manuales, env)`;
   - se vuelven a escribir esos tests.
10. **El gate sigue igual que hoy, con dos cambios:**
    - `changesSince(worktree, prep.base_sha)` (línea 196) pasa a
      `changesSince(worktree, <HEAD después de rearmar>)`. Así `written` son solo los tests del plan, no
      el código conservado. Ese `HEAD` se guarda en una variable, `inicioTests`.
    - `checkCommandsFail(plan, worktree, env, skip)`: `skip` saltea también los comandos que solo
      usan criterios de sub-tasks conservadas. Un comando compartido con una sub-task no conservada
      tiene que fallar, como hoy.
11. **Al pasar el gate:** `commitAll(...)` igual que hoy (queda encima de las conservadas), y
    `writePlanArtifacts` escribe además
    `conservadas.json` = `{ [id]: string[] /* SHAs nuevos */ }`, que es `{}` si no hay.
    `git update-ref -d refs/flowrunner/<run.id>/anterior` y se borra `candidatas.json`.

**Con un gate rechazado**, `anterior` y `candidatas.json` quedan para el próximo intento. Con la PR 10,
el `resume` no vuelve a correr los pasos 3 a 6: lee `candidatas.json` y rearma desde ahí en el paso 9.

**`writePlanArtifacts`** (líneas 57–68) suma un parámetro opcional
`conservadas: Record<string, string[]> = {}` y escribe `conservadas.json`. **`readPlanAt`** suma
`conservadas`, que se lee como `{}` si el archivo no existe.

### `src/phases/implementar.ts`

- Al armar `todo` y `integrated` (hoy, en el bloque que define `integrated` antes del `for (;;)`):
  - si `action.unidades === undefined` (una entrada completa, después de aprobar), por cada `id` de
    `plan.conservadas` que esté en `todo` y no tenga ya un evento `integrada` en `entry`:
    `emit({ tipo: "unidad", fase: "implementar", unidad: id, estado: "integrada", sha: shas.at(-1), motivo: "conservada del plan anterior" })`
    y se suma a `integrated`;
  - con `action.unidades` definido (un `fix` o una vuelta), nada cambia: si nombra una conservada,
    corre como cualquiera, sobre su código.
- `readyToStart` ya cuenta `integrated` para las dependencias: sin cambios.

### `prompts/planificar.md`

- En la regla 3 (sub-tasks), una oración: «En un replan, una sub-task que ya está implementada y no
  cambia lleva `conserva: true` (ver «Ya implementado en el worktree»); el gate rechaza un `conserva`
  que no corresponde».

### Interacciones

| Situación | Qué pasa |
|---|---|
| `rerun --desde planificar` | Hay plan anterior y commits de sub-tasks: se aplica todo lo de arriba |
| `changes` (pedir cambios con el plan esperando aprobación) | Hay plan anterior, pero implementar no corrió: 0 candidatas, y es el comportamiento de hoy |
| `rerun --desde preparar` | Preparar rehace el worktree desde `origin/<base>`: no hay candidatas |
| Un `fix` de la PR 05 | No pasa por planificar: no aplica |
| Varios runs (ADR 0019) | La ref `refs/flowrunner/<run.id>/anterior` es por run, sin conflictos. `git update-ref` va dentro de `conTurnoGit` |

## Tests (escribir primero y verlos fallar)

**`src/gates/conserva.test.ts`** (nuevo, unitario), con `checkConserva` y `conservadas`:

1. «una sub-task con el mismo alcance, sin pedidos ni llamadores, se conserva»: devuelve `[]`, y
   `conservadas` incluye el id.
2. «conserva sin estar implementada es un problema»: regla (a). Hoy el módulo no existe.
3. «un alcance distinto no se conserva»: (b).
4. «una sub-task que nombran los pedidos o el motivo del replan no se conserva»: (c), con
   `"ST-6 no pudo escribir CLAUDE.md"` como motivo.
5. «una sub-task que llama a una función que el plan cambia no se conserva»: (d), con `llamadores`
   `{ tomar: ["src/trabajos/cola.ts"] }` y alcance `["src/trabajos/"]`.
6. «una sub-task que depende de una no conservada no se conserva»: (e).

**`src/phases/replan.test.ts`** (nuevo, unitario con el SDK simulado, como `planificar.test.ts`).
Arma el proyecto con `makeProject` y corre `preparar`, `planificar`, `implementar` y `planificar` de
nuevo, llamando a las fases directamente y escribiendo los eventos que el runner escribiría
(`accion_iniciada`, `accion_terminada`, `aprobado`, `rehacer`).

7. **«un replan conserva el código de ST-1 a ST-5 y solo implementa lo que cambió (VF-6)»:**
   - el primer plan tiene ST-1 a ST-6, cada una con un archivo en `src/s<n>/`;
   - implementar las integra a las 6;
   - `rehacer` desde planificar con el motivo «ST-6 no pudo escribir lo pedido»;
   - el segundo plan devuelve ST-1 a ST-5 con `conserva: true`, ST-6 con otro alcance, y ST-7 nueva.

   **Afirma:**
   - `conservadas.json` tiene ST-1 a ST-5;
   - `git log base..HEAD` tiene sus commits con el trailer, y después el de los tests;
   - el archivo de ST-6 vieja ya no está;
   - el segundo implementar corre **2** sesiones (ST-6 y ST-7, contadas en `sim.records`), y escribe
     `unidad integrada` con `motivo: "conservada del plan anterior"` para ST-1 a ST-5.

   **Hoy falla:** `resetHard` borra todo y el segundo implementar corre 7 sesiones.
8. **«antes de la sesión, el planificador ve el código implementado y la lista de lo ya
   implementado»:** después del `rehacer`, el archivo de ST-1 existe en el worktree durante la sesión
   (lo comprueba el guion con un `Read`), y el prompt contiene «## Ya implementado en el worktree»
   y `ST-1`.
9. **«un conserva inválido rechaza el plan y no toca la rama»:** el segundo plan marca
   `conserva: true` en ST-6 con otro alcance. Planificar devuelve `falla gate` con el mensaje de la
   regla (b), y `refs/flowrunner/<run>/anterior` sigue apuntando a la punta vieja.
10. **«pedir cambios antes de implementar no conserva nada y planifica como hoy»:** un
    `cambios_pedidos` sobre el primer plan. No hay `candidatas.json`, y `conservadas.json` es `{}`.

**`src/phases/planificar.test.ts`:** el test existente «un reintento arranca de la base: los tests del
intento anterior no quedan» tiene que seguir pasando sin cambios. Si no pasa, el `rearmar` con 0
candidatas cambió el comportamiento de hoy.

## Docs a actualizar

- **ADR nuevo:** `docs/adr/0024-replan-conserva-codigo.md`, con las decisiones 1, 2, 5 y 9, y el paso
  6 (el índice se reconstruye antes de la sesión).
- **`README.md`**, en la sección del flujo: un párrafo. «Si un run se replanifica, el código de las
  sub-tasks que el plan nuevo no cambia se conserva».
- **`skills/flowrunner/SKILL.md`**, en «ver el plan»: si una sub-task trae `conserva: true`, decile a
  la persona que su código se conserva.
- **`prompts/planificar.md`:** ver arriba.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

## Fuera de alcance

- Conservar una sub-task con el alcance cambiado: se reimplementa entera.
- Conservar código de un run anterior de la misma clave.
- Mostrar «conservada» como un estado distinto en watch y Orca.

## Riesgos y cómo se detectan

- **Un test nuevo del plan rompe código conservado.** Verificar lo ve como cualquier rojo, y con la
  PR 05 se pregunta. El test 7 corre verificar simulado: no lo cubre.
- **El orden de los cherry-picks no es el que asumían las dependencias.** Se aplican en el orden de la
  rama vieja, que ya era válido. Un choque cae en la decisión 8 y queda un aviso.
- **Un `gc` borra los commits viejos durante un replan largo.** La ref
  `refs/flowrunner/<run>/anterior` los mantiene vivos. El test 9 la comprueba.
- **`written` incluye código conservado y lo bloquea como test.** Lo evita `inicioTests` (cambio 10),
  y lo cubre el test 7: `locked.json` tiene solo los tests.
