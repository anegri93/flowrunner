# PR 05 · Detenerse y preguntar

Rama: `feat/detenido-con-pregunta` · Depende de: #69, #70, #71 y #72 mergeadas · Tamaño: grande (es la
PR más grande de la tanda)

## Objetivo

En VF-6, verificar devolvió trabajo una y otra vez (`MAX_ROUNDS = 2` por fase). Diagnosticar y
reparar adivinaban de quién era el rojo, y cada replan arrancaba de cero: una traba de cinco minutos se
convirtió en 70 minutos y US$ 17. Con esta PR, ante el primer rojo el run se detiene con **una**
pregunta y sus respuestas posibles como comandos. Recién sigue cuando la persona elige una.

- **Métrica:** sesiones de implementar disparadas por una vuelta automática, por run. En la línea de
  base, VF-6 tuvo 9 entradas a implementar y 9 a verificar. Con `vueltas: 0` (el defecto), la
  primera vuelta automática no existe, y toda reentrada a implementar viene de un `fix` de la persona.

## Decisiones tomadas (no reabrir)

- **D1:** la pregunta vive en `detenido`. No hay estado nuevo.
- **D2:** `fix --yo` y `resume` commitean el cambio a mano.
- **D4:** `vueltas` vale 0 por defecto, entre 0 y 3.
- **D5:** diagnosticar y reparar corren solos solo si `vueltasMax > 0`.
- **Contratos:** C1, C2 (el outcome; lo devuelve la PR 06), C3, C4 y C5 de `01-contratos.md`.
- **El comando de la pregunta:** un comando de la persona es válido solo si su prefijo está entre las
  `opciones` del halt actual. Esa regla vale para `fix --unidad`, `fix --yo` y `accept`. `resume` y
  `rerun` siguen como hoy, para no romper nada.
- **`accept-untested` no cambia:** sigue con su validación y escribiendo `sin_probar_aceptado`. Es
  equivalente a `accept` sobre un `detenido` por criterios sin probar. Ver «Conflicto con contratos».
- **`fix` desde una pregunta de implementar:** entran a implementar **todas** las `halt.unidades`
  (las fallidas y las bloqueadas por ellas). La instrucción se prefija con las sub-tasks que eligió la
  persona: `Para ST-2: <instrucción>`. Sin eso, una sub-task bloqueada por la que se arregla no
  arrancaría nunca.
- **`fix` desde verificar, revisar o probar:** entran solo las sub-tasks elegidas. Las demás ya están
  integradas.

## Cambios, archivo por archivo

### `src/store/events.ts`

- `outcomeSchema` (línea 17): suma la variante `pregunta` de C2.
- `eventSchema`:
  - `run_creado` (línea 48) suma `vueltas: z.int().min(0).max(3).optional()`.
  - Se suman `arreglo_pedido`, `arreglo_manual_iniciado`, `arreglo_manual` y `aceptado`, como en C4.
- Exportar `origenSchema = z.enum(["terminal", "claude", "orca"])` y `type Origen`. El `origen` de
  `aprobado` y `cambios_pedidos` lo suma la PR 08: acá **no** se tocan esos dos.

```ts
z.strictObject({
  tipo: z.literal("arreglo_pedido"),
  at,
  unidades: z.array(z.string().min(1)).min(1),
  instruccion: z.string().min(1),
  origen: origenSchema,
}),
z.strictObject({ tipo: z.literal("arreglo_manual_iniciado"), at, origen: origenSchema }),
z.strictObject({ tipo: z.literal("arreglo_manual"), at, sha: z.string().nullable() }),
z.strictObject({
  tipo: z.literal("aceptado"),
  at,
  fase: phaseSchema,
  motivo: z.string().min(1),
  origen: origenSchema,
}),
```

### `src/engine/engine.ts`

- **`Halt`** (línea 53): como en C1. Se exportan `Opcion` y `Halt`.
- **`RunState`** (líneas 58 a 85) suma:
  - `vueltasMax: number`. En `initialState()` vale 2: es el valor de un run viejo sin `vueltas` en
    `run_creado`.
  - `aMano: boolean`, inicial `false`.
- **`MAX_ROUNDS`** (línea 33) se borra. Su único uso es `onOutcome`.
- **`enter()`** (línea 105) suma `aMano: false` al objeto que resetea.
- **`halt()`** (línea 97) cambia a esto. Es la única forma de dejar un run `detenido`:

```ts
function halt(
  state: RunState,
  motivo: string,
  siguiente?: string,
  unidades?: readonly string[],
): RunState {
  const draft: RunState = {
    ...state,
    status: "detenido",
    halt: {
      motivo,
      siguiente: siguiente ?? `flowrunner resume ${state.runId}`,
      opciones: [],
      ...(unidades === undefined ? {} : { unidades }),
    },
  };
  const opciones = opcionesDe(draft, state.fase, unidades);
  return {
    ...draft,
    halt: { ...draft.halt!, siguiente: opciones[0]!.comando, opciones },
  };
}
```

  > El `!` está permitido acá: `draft.halt` se construye dos líneas antes, y `opcionesDe` garantiza
  > al menos una opción (lo pinchan los tests). Si el lint lo rechaza, se reescribe con una variable
  > local `base: Halt` en lugar de `draft.halt!`.

- **`opcionesDe`**, exportada y pura. `R` es `state.runId`; `N` es `NEXT[fase]`:

```ts
export function opcionesDe(
  state: RunState,
  fase: Phase,
  unidades: readonly string[] | undefined,
): Opcion[];
```

| Caso (en este orden de evaluación) | Opciones |
|---|---|
| `state.aMano` | `flowrunner resume R` («commitear tu cambio a mano y volver a verificar»), `flowrunner abort R` |
| `state.sinProbar` | `flowrunner rerun R --desde probar` («rehacer probar después de arreglar lo que faltó»), `flowrunner accept R "<por qué>"` («entregar igual; tu motivo queda en la PR»), `flowrunner fix R --yo`, `flowrunner abort R` |
| `fase` en `ROUND_PHASES` y `unidades` con algo | por cada `u`: `flowrunner fix R --unidad u "<qué cambiar>"` («que u lo corrija con tu instrucción, sobre el código que ya está»); después `fix R --yo` («lo arreglás vos en el worktree; `resume` lo commitea y vuelve a verificar»), `accept R "<por qué>"` («seguir a N igual; tu motivo queda en la PR»), `rerun R --desde planificar` («replanificar»), `abort R` |
| `fase === "implementar"` y `unidades` con algo | `fix --unidad` por cada `u`, `fix --yo`, `rerun --desde planificar`, `abort`. Sin `accept` |
| Cualquier otro | `state.halt.siguiente` («retomar en `fase`» si es `resume`; si no, el texto que corresponda al comando), y `abort R` («cortar el run; la rama queda») |

- **`onOutcome`** (desde la línea 122):
  - **`vuelve`** (líneas 136 a 154). La guarda `!isRoundPhase` queda igual. Si
    `vueltas[fase] > state.vueltasMax`, devuelve:

    ```ts
    halt(
      { ...state, vueltas },
      state.vueltasMax === 0
        ? `${fase}: ${outcome.motivo}`
        : `${fase} devolvió trabajo ${vueltas[fase]} veces; el máximo es ${state.vueltasMax}. Último motivo: ${outcome.motivo}`,
      undefined,
      outcome.unidades,
    )
    ```

  - **`pregunta`** (caso nuevo): `halt(state, `${fase}: ${outcome.motivo}`, undefined, outcome.unidades)`.
    No toca `intentos` ni `vueltas`.
  - **`falla` con clase `sin_probar`** (líneas 158 a 166): el estado se marca **antes** de llamar a
    `halt`, para que `opcionesDe` vea la fila correcta:
    `return halt({ ...state, sinProbar: true }, <motivo de hoy, sin cambios>, `flowrunner rerun ${state.runId} --desde ${fase}`)`.
    El motivo de hoy, que menciona `accept-untested`, se queda igual.
- **`reduce`** (desde la línea 224):
  - `run_creado`: `vueltasMax: event.vueltas ?? 2`.
  - `arreglo_pedido`: solo si `status === "detenido"` y `halt.opciones` tiene un comando que empieza
    con `flowrunner fix ${runId} --unidad`. Si no, devuelve el estado sin cambios.
    - Si `state.fase === "implementar"`: `enter(state, "implementar", { unidades: union(event.unidades, state.halt.unidades ?? []), instruccion: `Para ${event.unidades.join(", ")}: ${event.instruccion}` })`.
    - Si no: `enter(state, "implementar", { unidades: event.unidades, instruccion: event.instruccion })`.
    - En los dos casos, `vueltas` no cambia.
  - `arreglo_manual_iniciado`: solo con `status === "detenido"`.
    `halt({ ...state, aMano: true }, "Esperando tu arreglo a mano en el worktree de la feature. Cuando termines, retomá el run: flowrunner commitea tu cambio y vuelve a verificar.")`.
  - `arreglo_manual`: solo con `state.aMano`. `enter(state, "verificar")`, que pone `aMano: false`.
  - `aceptado`: solo si `status === "detenido"`, `event.fase === state.fase`, la fase es una de
    `ROUND_PHASES` y existe `NEXT[event.fase]`. Entonces `enter(state, NEXT[event.fase])`. Si no,
    devuelve el estado sin cambios.
  - `reanudado` (línea 269): sin cambios de comportamiento. Si `state.aMano`, lo deja en `false` (lo
    hace `enter`).
  - `sin_probar_aceptado`: sin cambios.
  - `uso` con presupuesto superado (línea 254): ya pasa por `halt`, y queda en la fila «cualquier
    otro».

### `src/config/schemas.ts`

- `repoConfigSchema` suma, justo después de `max_runs`:

```ts
/** Vueltas automáticas de verificar, revisar y probar antes de preguntar (ADR 0023). */
vueltas: z.int().min(0).max(3).default(0),
```

### `src/store/runs.ts`

- `NewRun` (línea 20) suma `readonly vueltas?: number | undefined`.
- `createRun` (línea 28): agrega `vueltas` al evento `run_creado` solo si viene definido.

### `src/cli/runs.ts`

- **`startRun`** (línea 148): le pasa a `createRun` `vueltas: checked.repoConfig.vueltas`.
- **Helper nuevo:**

  ```ts
  function offered(state: RunState, prefix: string): boolean {
    return state.status === "detenido" && (state.halt?.opciones ?? []).some((o) => o.comando.startsWith(prefix));
  }
  ```

  Si no lo ofrece, `UserError` con
  `el run ${id} no ofrece eso ahora (está ${state.status} en ${state.fase})`, y como siguiente
  `flowrunner status ${id}`.

- **`fixRun`, nueva:**

  ```ts
  export function fixRun(
    home: string,
    id: string,
    opts: { readonly unidades: readonly string[]; readonly instruccion: string | undefined; readonly yo: boolean; readonly origen: Origen },
    env: NodeJS.ProcessEnv,
  ): RunStarted;
  ```

  - **Con `yo`:** exige `offered(state, `flowrunner fix ${id} --yo`)` y un evento `preparado` en el
    log; si no hay, el error es «el run todavía no tiene worktree». Escribe
    `arreglo_manual_iniciado`, **no lanza nada** y responde con `runStartedSchema`:
    `accion: "editá ${worktree} y después: flowrunner resume ${id}"`. El worktree es el de
    `prepared(readLog(...).events).worktree`.
  - **Sin `yo`:** exige al menos una `unidad`, cada una entre las que ofrece el halt
    (`offered(state, `flowrunner fix ${id} --unidad ${u} `)`), y una `instruccion` no vacía. Escribe
    `arreglo_pedido` y lanza con `lanzamiento(id, "arreglando " + unidades, "arreglo pedido", lanzarOEncolar(...))`.

- **`acceptRun`, nueva:** `acceptRun(home, id, motivo, origen, env)`. Exige
  `offered(state, `flowrunner accept ${id}`)` y un motivo no vacío. Escribe
  `aceptado { fase: state.fase, motivo, origen }` y lanza. La `accion` es
  `aceptado: ${NEXT} arrancó`.
- **`resumeRun`** (línea 194): pasa a ser `async`. Si `state.aMano`:
  1. Calcula el diff sin commitear del worktree de la feature:
     `changesSince(worktree, await headSha(worktree, env), env)`.
  2. Corre `manualChangeProblems(...)` (archivo nuevo, abajo). Si hay problemas, `UserError` con la
     lista y sin escribir nada.
  3. Si hay cambios: `commitAll(worktree, "fix: arreglo a mano", { "Flowrunner-Manual": id }, env)`.
     Si no hay, `sha = null`.
  4. Escribe `arreglo_manual { sha }` (sin `reanudado`) y lanza con
     `lanzamiento(id, "tu arreglo commiteado: verificar arrancó", "tu arreglo commiteado", ...)`.

  Sin `aMano`, igual que hoy.

### `src/cli/manual.ts` (nuevo)

```ts
/**
 * Lo que impide commitear un arreglo a mano: un test bloqueado distinto de su hash, un secreto
 * agregado o algo dentro de `.git`. Ver «Conflicto con contratos» sobre las rutas protegidas.
 */
export function manualChangeProblems(
  root: string,
  changes: readonly FileChange[],
  locked: Readonly<Record<string, string>>,
): string[];
```

- **Arma un `Scope`** con `writable: []`, `writeGlobs: ["**"]`, `locked: Object.keys(locked)`,
  `harness: []`, `lockfiles: []`, `manifests: []`, `depsDeclared: true` y `testGlobs: []`, y llama a
  `checkChanges`.
- **Los tests bloqueados:** además, por cada uno que esté en `changes`, compara su sha256 con
  `locked[path]`. Si cambió: «`<path>` es un test bloqueado del plan: si tiene que cambiar,
  replanificá con `flowrunner rerun <id> --desde planificar`».
- **`locked`** sale de `readPlan(runPaths(home, id)).locked`.

### `src/cli/main.ts`

- **`parseArgs`** (línea 112): `unidad` pasa a `{ type: "string", multiple: true }`. Se suman
  `yo: { type: "boolean", default: false }` y `origen: { type: "string" }`.
  - Donde hoy se usa `values.unidad` como string (el `report --unidad`), se cambia a
    `values.unidad?.[0]`.
- **`parseOrigen(value)`:** devuelve `"terminal"` si no viene. Si viene otra cosa que las tres
  válidas, `UserError("--origen tiene que ser terminal, claude u orca")`.
- **`case "fix"`** y **`case "accept"`** (nuevos): `accept` toma el motivo de `rest.join(" ")`; `fix`,
  la instrucción. `case "resume"` pasa a `await resumeRun(...)`.
- **Ayuda** (línea 48): agregar
  `fix <run> --unidad ST-n "<qué>"   que esa sub-task lo corrija sobre el código que ya está`,
  `fix <run> --yo                    lo arreglás vos en el worktree; después resume`,
  `accept <run> "<por qué>"          seguir a la fase siguiente igual`.
- **`describeStatus`** (líneas 85 a 92): reemplazar «Para seguir» por la lista de opciones:
  `Opciones:` y debajo una línea por opción, `  <comando>  ·  <que>`.

### `src/cli/contracts.ts`

- `runSummarySchema.detenido` (línea 24):

```ts
detenido: z
  .strictObject({
    motivo: z.string(),
    siguiente: z.string(),
    opciones: z.array(z.strictObject({ comando: z.string(), que: z.string() })).min(1),
    unidades: z.array(z.string()).optional(),
  })
  .nullable(),
```

- `summarize`: pasa `halt` entero (sin `unidades` si es `undefined`).
- `steps()` (línea 84): el `motivo` también va para `r.tipo === "pregunta"`.

### `src/cli/skill.ts`

- `ASK_RULES` (línea 10) suma `"Bash(flowrunner fix:*)"` y `"Bash(flowrunner accept:*)"`: son
  decisiones de la persona, como aprobar.

### `src/phases/verificar.ts`

- **D5**, con la versión de #71 (líneas 160 a 200): `const stalled = ...` pasa a ser
  `ctx.state.vueltasMax > 0 && (failing.some(...) || repeated)`. Con 0 vueltas, nunca se diagnostica
  ni se repara.

### `src/report/report.ts`

- **Función nueva `accepted(events)`:** `## Lo que aceptaste al seguir`, con una línea por evento
  `aceptado` (`- en ${fase}: ${motivo}`) y otra por cada `arreglo_manual` con sha
  (`- arreglo a mano: ${sha.slice(0, 7)}`).
- **Dónde va:** en `buildReport` (línea 127), después de `existing`; y en `prBody` (línea 287),
  después de `existingChanges`.
- **Lo que no cambia:** `tested()` (línea 201) sigue leyendo `sin_probar_aceptado`, y además toma el
  `aceptado` con `fase === "probar"`. Gana el último de los dos.

### `src/notify/estado.ts` (de #69)

- `case "detenido"` (línea 51): el body pasa a
  `${halt.motivo}\nPara seguir: ${halt.opciones[0].comando}`. El título no cambia.

### `src/watch/tree.ts` y `src/watch/render.ts`

- **`RunTree`** (línea 78) suma `opciones: readonly Opcion[] | undefined` y
  `unidades: readonly string[] | undefined`, desde `state.halt`. La línea 396 deja `siguiente` igual.
- **El estado de una fase** (desde la línea 330): un `accion_terminada` con `resultado.tipo === "pregunta"`
  se muestra como `"falla"`, con su `motivo` como `detalle`.
- **`render.ts`** (línea 230): con `tree.opciones` presentes, «para seguir: `opciones[0].comando`» y,
  si hay más, «(+N opciones: flowrunner status <id>)».

### `orca/src/runs.ts`

- **`Run`** (línea 47) suma `opciones?` y `unidades?`. El tipo `Opcion` se define localmente: el
  plugin no importa de `src/`.
- **`Decision`** (línea 438) suma:

```ts
| { readonly accion: "arreglar"; readonly unidad: string; readonly instruccion: string }
| { readonly accion: "aMano" }
| { readonly accion: "aceptar"; readonly motivo: string }
```

- **Helpers nuevos**, con tests: `fixUnits(run): string[]`, de los comandos que matchean
  `/--unidad (ST-\d+)/`; `offers(run, comando: "fix --yo" | "accept" | "resume"): boolean`.
- **`decisionsFor`** (línea 451), para `detenido`: arma la lista desde `run.opciones`:
  - un `"arreglar"` si `fixUnits(run)` no está vacío;
  - `"aMano"` si ofrece `fix --yo`;
  - `"aceptar"` si ofrece `accept`;
  - `"reanudar"` si ofrece `resume`;
  - `"rehacer"` si hay un `--desde`, como hoy con `rerunPhase`.

  Sin `opciones` (un snapshot viejo), lo de hoy.

### `orca/src/decisiones.tsx`

- **Un botón por sub-task:** «Arreglar ST-n». Abre el `Input` como hoy `cambios`, con la etiqueta
  «Qué tiene que corregir ST-n», y manda `{ accion: "arreglar", unidad, instruccion }`.
- **«Lo arreglo yo»:** pide confirmación y manda `{ accion: "aMano" }`. La respuesta de flowrunner,
  que trae la ruta del worktree, se muestra con `said` aunque sea `ok`, igual que hoy con
  `aprender`.
- **«Seguir igual»:** abre un `Input` («Por qué seguir así; queda en la PR») y manda
  `{ accion: "aceptar", motivo }`.
- **Arriba de los botones**, con `unidades`: «Parece ser de: ST-n».

### `orca/src/worker.ts`

- **`decisionArgs`** (línea 96) suma:
  - `arreglar`: valida `unidad` contra `/^ST-\d+$/` e `instruccion` como hoy el motivo de `cambios`
    (no vacía, `MAX_MOTIVO`). Devuelve
    `fix ${quote(id)} --unidad ${unidad} ${quote(instruccion)} --origen orca`.
  - `aMano`: `fix ${quote(id)} --yo --origen orca`.
  - `aceptar`: valida `motivo` igual. Devuelve `accept ${quote(id)} ${quote(motivo)} --origen orca`.
- `orca/src/protocol.ts`: actualizar el comentario de `flowrunner.decidir`.

### `test/hooks/fake-phases.ts`

- **`FAKE_VUELVE`:** si vale `ST-n`, verificar devuelve
  `{ tipo: "vuelve", unidades: ["ST-n"], motivo: "AC-1 sigue en rojo" }` solo la **primera** vez.
  Lleva la cuenta en `ejecuciones.txt`, que ya existe: vuelve si la cantidad de `verificar` ya
  anotados es 1.

### Tests de integración existentes que dependen de las vueltas automáticas

En `test/dependencias.int.test.ts`, `test/diagnosticar.int.test.ts`, `test/fase6.int.test.ts` y
`test/fase8.int.test.ts`, la `config` del proyecto suma `vueltas: 2`. Es un cambio de contrato y
corresponde: esos tests fijan el comportamiento de un repo que pide vueltas.
`test/fase5.int.test.ts` no cambia: usa `newRun`, que no escribe `vueltas`, así que el run vale 2.

## Tests (escribir primero y verlos fallar)

`src/engine/engine.test.ts`:

| Nombre | Afirma | Por qué falla hoy |
|---|---|---|
| «con 0 vueltas, el primer rojo de verificar detiene con una pregunta» | `run_creado` con `vueltas: 0` más `verificar vuelve [ST-2]` da `detenido`, con `halt.unidades` en `["ST-2"]` y `vueltas.verificar` en 1 | hoy entra a implementar |
| «las opciones de una pregunta de verificar salen en orden» | los comandos exactos: `fix R --unidad ST-2 "<qué cambiar>"`, `fix R --yo`, `accept R "<por qué>"`, `rerun R --desde planificar`, `abort R`; y `siguiente` igual al primero | `opciones` no existe |
| «un run viejo sin vueltas en run_creado sigue con dos vueltas» | sin el campo, la primera y la segunda `vuelve` entran a implementar; la tercera detiene | protege la migración (pasa también hoy; lo nuevo es la tercera, con su pregunta) |
| «arreglo_pedido vuelve a implementar con las sub-tasks y la instrucción, sin sumar vueltas» | sobre el halt de arriba: `en_curso` en implementar, con las unidades, la instrucción y `vueltas.verificar` en 1 | el evento no existe |
| «arreglo_pedido sobre una pregunta de implementar incluye las bloqueadas» | un halt de implementar con unidades `[ST-2, ST-3]` y `fix --unidad ST-2` da unidades `[ST-2, ST-3]` e instrucción `Para ST-2: …` | — |
| «arreglo_pedido que el halt no ofrece no cambia nada» | sobre un `detenido` por entorno, el estado queda igual | — |
| «fix a mano: espera tu resume y después vuelve a verificar» | `arreglo_manual_iniciado` da `aMano` y las opciones `[resume, abort]`; después `arreglo_manual` da `en_curso` en verificar, con `aMano` en `false` | — |
| «aceptado en verificar sigue a revisar; en implementar no hace nada» | lo que dice el nombre | — |
| «sin_probar_aceptado sigue como antes, y su detención ofrece rerun, accept, fix --yo y abort» | los tests de hoy, más las opciones | `opciones` no existe |
| «toda detención tiene opciones, y siguiente es la primera» | lo comprueba sobre entorno, invariante, infra agotada, presupuesto, el mismo fallo dos veces, `sinProbar`, vuelta agotada y `pregunta` | — |
| «la secuencia de VF-6 se detiene en la primera vuelta de verificar» | `run_creado` con `vueltas: 0`; preparar, planificar y aprobar `ok`; `aprobado`; implementar `ok`; verificar `vuelve` con unidades `[ST-6]` y el motivo de AC-12 tal como quedó en el log de VF-6. Resultado: `detenido` en verificar, con `opciones[0]` en `flowrunner fix R --unidad ST-6 "<qué cambiar>"` y `nextAction` en `fin` | hoy entra a implementar: `en_curso` |

`src/cli/manual.test.ts` (nuevo):

- «un arreglo a mano que cambia un test bloqueado no se commitea y dice cómo replanificar».
- «un arreglo a mano que agrega un secreto no se commitea».
- «un arreglo a mano en el código, sin tocar tests bloqueados, pasa».

`test/pregunta.int.test.ts` (nuevo, con el CLI real y las fases falsas):

| Nombre | Afirma |
|---|---|
| «con 0 vueltas, verificar en rojo detiene; fix --unidad corre solo esa sub-task y vuelve a verificar» | con `FAKE_VUELVE=ST-1`: `detenido`, después `fix <id> --unidad ST-1 "x"` sale 0; al final `ejecuciones.txt` tiene `implementar` dos veces y el run termina `entregado` |
| «fix sobre un run que no ofrece fix sale 1 y lista las opciones» | sobre un run entregado |
| «fix --yo da el worktree; resume commitea el cambio a mano y sigue en verificar» | `FAKE_KEEP_REAL=preparar`, como en `test/fase2.int.test.ts`. Escribe un archivo en el worktree, corre `resume`, y el log tiene `arreglo_manual` con un sha cuyo commit lleva el trailer `Flowrunner-Manual` |
| «accept con motivo sigue a revisar, y el motivo queda en el informe» | — |

`src/report/report.test.ts`:

- «el informe y la PR listan lo que aceptaste, con su fase y su motivo».

`src/notify/estado.test.ts`:

- «el aviso de detenido termina con la primera opción».

`src/watch/tree.test.ts`:

- «el árbol de un run detenido trae sus opciones y sus sub-tasks».
- «una pregunta de implementar se ve como falla de esa fase, con su motivo».

`src/phases/verificar.test.ts`:

- «con 0 vueltas no se diagnostica aunque la sub-task devuelta siga en rojo». Con el SDK simulado
  (`simQuery`), ninguna sesión de diagnosticar: `sim.records` no tiene el prompt «Sos el que
  diagnostica».

`orca/src/runs.test.ts`:

- «un run detenido con opciones ofrece arreglar por sub-task, a mano y seguir igual».
- «fixUnits saca las sub-tasks de las opciones».

`orca/src/worker.test.ts`:

- «arreglar, a mano y aceptar se traducen a fix y accept con --origen orca».
- «un arreglo con una sub-task inválida o sin instrucción se rechaza».

`orca/src/panel.test.tsx`:

- «un run detenido muestra Arreglar ST-n, que pide qué corregir y lo manda». Necesita un fixture con
  un run detenido con `opciones`: se agrega a `orca/test/watch.json` o se arma en el test.

## Docs a actualizar

- **`docs/adr/0023-detenerse-y-preguntar.md`** (nuevo): contexto (VF-6: vueltas, diagnóstico y
  replan); decisión (D1, D2, D4, D5, C1 a C5); alternativas descartadas (un estado nuevo; las vueltas
  por defecto en 2); verificación (los tests de arriba).
- **`README.md`:**
  - en la sección del flujo, «cuando algo sale mal, el run se detiene y te pregunta», con los cuatro
    comandos;
  - en la tabla de comandos, `fix` y `accept`;
  - `vueltas` en la config.
- **`skills/flowrunner/SKILL.md`:**
  - **Regla nueva:** «`fix` y `accept` son de la persona, como aprobar: mostrá `detenido.motivo` y
    `detenido.opciones` y corré la que elija, con `--origen claude`».
  - **Fila nueva** en «Operar los runs»: «el run se detuvo» → `flowrunner status <run> --json` → «Y
    hacé: mostrá el motivo, a quién se atribuye (`unidades`) y cada opción en palabras; nunca elijas
    por la persona».
- **`src/cli/main.ts`:** la ayuda.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
pnpm orca:test   # 1 test ya falla en main: «lee solo los runs del proyecto enfocado…». Ningún otro.
```

## Fuera de alcance

- `flowrunner explain`.
- Que una pregunta de implementar llegue desde la PR 06: acá solo se manejan el outcome y sus
  opciones.
- Conservar código en un replan: PR 09.
- `origen` en `aprobado` y `cambios_pedidos`, y el botón de Orca: PR 08.

## Riesgos y cómo se detectan

- **Un run viejo en curso durante el cambio.** `vueltasMax` vale 2 por defecto, así que el test «un
  run viejo sin vueltas…» lo cubre. Un `detenido` viejo calcula sus opciones al reducir.
- **Opciones que no matchean lo que valida el CLI.** Tanto el engine como el CLI usan el prefijo
  exacto `flowrunner fix ${id} --unidad`. El test de integración de `fix` lo cubre de punta a punta.
- **`unidad` pasa a ser `multiple`.** Rompe `report --unidad` si no se ajusta. Lo cubren los tests de
  `report` que ya existen en `test/report-unidad.int.test.ts`.
- **Orca con un snapshot sin `opciones`** (un flowrunner viejo): `decisionsFor` cae en lo de hoy.

## Conflicto con contratos

1. **C5 dice que `resume` con `aMano` aplica «rutas protegidas».** Pero D2 se eligió para hacer a mano
   justamente lo que ningún agente puede, como el `CLAUDE.md` de VF-6. Si la persona no puede tocar
   `CLAUDE.md`, `fix --yo` no resuelve el caso que lo motivó. Esta spec implementa
   `manualChangeProblems` **sin** el chequeo de `ALWAYS_PROTECTED`: solo `.git`, los tests bloqueados
   por hash y los secretos. **Hay que confirmarlo en `01-contratos.md` C5**: reemplazar «rutas
   protegidas, tests bloqueados por hash, secretos» por «`.git`, tests bloqueados por hash y
   secretos; las rutas protegidas son para los agentes, no para la persona».
2. **C5: «`accept-untested` queda como alias».** Esta spec lo deja intacto, porque sigue escribiendo
   `sin_probar_aceptado`, en vez de convertirlo en un alias que escriba `aceptado`. El efecto es el
   mismo (el reductor de los dos lleva a entregar, y el informe lee los dos) y no rompe
   `test/cli-runs.int.test.ts`. Si se quiere un alias literal, hay que cambiar ese test.
3. **C1, fila «cualquier otra detención».** Para una credencial rechazada, la PR 07 pone
   `siguiente = flowrunner doctor`, y las opciones quedan `[doctor, resume, abort]`. Es compatible
   con «nunca vacía, `siguiente` es la primera», pero tiene una opción más que la fila de C1.
