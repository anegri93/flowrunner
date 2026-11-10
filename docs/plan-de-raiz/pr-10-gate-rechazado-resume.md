# PR 10 · Si el gate rechaza el plan, seguir en la misma sesión

Rama: `perf/gate-rechazado-resume` · Depende de: nada. Si la PR 09 ya está mergeada, ver la
interacción abajo · Tamaño: mediano

## Objetivo

- **El incidente:** el plan se escribe recién después de pasar el gate (`planificar.ts:252`), y cada
  intento arranca de cero (`resetHard` en `planificar.ts:107`, sesión nueva). Un rechazo por una sola
  declaración faltante vuelve a explorar todo el repo. ML-1 #2 y VF-5 #2 costaron US$ 2,07 y 2,77, y
  9,2 y 10,3 minutos, con 89 y 121 turnos. Un replan con contexto (VF-6 #2 a #8) cuesta entre
  US$ 0,69 y 1,03, en 2,5 a 3,7 minutos.
- **La métrica:** un reintento por el gate cuesta menos de US$ 1 y menos de 4 minutos. Se mide con
  `stats --runs` (PR 02) en runs reales: el test no lo puede medir.

## Decisiones tomadas (no reabrir)

1. **Solo el reintento de planificar por un rechazo del gate** usa `resume`. Un pedido de cambios
   (`cambios_pedidos`), un `rerun` o el primer intento siguen con una sesión nueva, como hoy.
2. **Las sesiones de planificar se persisten**, porque `resume` lee la conversación del disco. Hoy
   `buildOptions` fija `persistSession: false` (`src/agent/session.ts:92`). Planificar pasa un
   `sessionId` propio (un UUID de `randomUUID()`), para conocerlo sin leer el stream. Las demás fases
   siguen sin persistir.
3. **Dónde queda el id:** en un archivo del run, `runs/<id>/planificar-sesion.json`, con
   `{ "sessionId": string, "nombre": string }`. **No en un evento:** es una optimización, y si falta,
   se planifica de cero como hoy. No toca `eventSchema`.
4. **El reintento con `resume` no resetea nada.** El worktree queda como lo dejó el intento rechazado:
   los tests escritos, los fixers ya pasados y lo ajeno ya descartado. El planificador corrige sobre
   eso.
5. **El mensaje del `resume` es uno solo**, con el motivo del gate:

   ```
   El gate rechazó el plan que devolviste:

   <motivo>

   Corregí el plan y los tests en este mismo worktree, sin volver a explorar lo que ya leíste, y
   devolvé el plan completo otra vez.
   ```

6. **Fallback:** si la sesión con `resume` no devuelve `ok` ni `limite` (por ejemplo, «No
   conversation found» o un error del CLI), se emite un aviso y, en la misma llamada a la fase, se
   corre el camino de hoy desde el principio: reset y sesión nueva. Ese aviso es
   `no se pudo retomar la sesión del plan (<motivo>): planifica de cero`.
7. **Los intentos no cambian.** El `resume` es un intento más de planificar, y lo cuenta el engine
   como hoy: `MAX_ATTEMPTS.planificar = 3` (`src/engine/engine.ts:20`). La regla «mismo motivo dos
   veces seguidas se detiene» sigue igual.
8. **El costo:** cada sesión, la del `resume` y la de un fallback, emite su propio evento `uso` con
   su `sesion` (`planificar-N`), como hoy. No hay campos nuevos.
9. **Limpieza:** cuando el gate pasa, se borra `planificar-sesion.json` y se intenta
   `deleteSession(sessionId, { dir: worktree })` del SDK, en un `try/catch` sin propagar. En modo
   token, la conversación queda en `~/.flowrunner/claude/projects/`, que es de flowrunner, y el
   `deleteSession` del proceso puede no encontrarla: se acepta como residuo, y queda dicho en el ADR.

## Cambios, archivo por archivo

### `src/agent/session.ts`

- **`SessionSpec`** (líneas 22–40) suma:

  ```ts
  /** Persiste la sesión con este id (un UUID), para poder retomarla. Sin él, no se persiste. */
  readonly sessionId?: string;
  /** Retoma la sesión persistida con este id, en lugar de empezar una nueva. */
  readonly resume?: string;
  ```

- **`buildOptions`** (líneas 61–95) reemplaza `persistSession: false` por:

  ```ts
  ...(spec.resume !== undefined
    ? { resume: spec.resume, persistSession: true }
    : spec.sessionId !== undefined
      ? { sessionId: spec.sessionId, persistSession: true }
      : { persistSession: false }),
  ```

  Las dos no van juntas: el SDK no acepta `sessionId` con `resume` sin `forkSession`. Si vienen las
  dos, gana `resume`.
- **`runSession`:** sin cambios. El `uso` y el resultado salen igual.

### `src/phases/planificar.ts`

Se parte el cuerpo de `planificar` (líneas 95–254) en tres funciones del mismo archivo, sin cambiar
qué hace cada línea:

```ts
interface Intento {
  readonly result: SessionResult<Plan>;
  /** Los tests restaurados del plan anterior; vacío en un resume. */
  readonly restored: readonly (readonly [string, string])[];
  /** Hay que descartar los tests nuevos que el plan no declara (solo en un resume). */
  readonly limpiarNoDeclarados: boolean;
}

/** El camino de hoy: archiva, resetea, restaura y abre una sesión nueva persistida. */
async function intentoNuevo(ctx: PhaseContext, comun: Comun): Promise<Intento>;

/** Retoma la sesión del intento rechazado con un solo mensaje. Sin reset. */
async function intentoRetomado(
  ctx: PhaseContext,
  comun: Comun,
  sesion: { sessionId: string; nombre: string },
  motivo: string,
): Promise<Intento>;

/** Lo de hoy después de la sesión: descarta lo ajeno, corre el gate, commitea y escribe artefactos. */
async function gateYCierre(ctx: PhaseContext, comun: Comun, intento: Intento): Promise<Outcome>;
```

- **`Comun`** agrupa lo que hoy se calcula una vez: `prep`, `worktree`, `config`, `brain`, `feature`,
  `hook`, y la `SessionSpec` base sin `prompt`, `nombre`, `sessionId` ni `resume`.
- **`intentoNuevo`:** el `sessionId` es `randomUUID()`. Después de la sesión, si el resultado es `ok`,
  escribe `planificar-sesion.json`.
- **`intentoRetomado`:** el `prompt` es el mensaje de la decisión 5, y la spec lleva
  `resume: sesion.sessionId`. **No** llama a `archivePlan`, `resetHard` ni restaura tests.
- **`gateYCierre`:** si `limpiarNoDeclarados`, antes del gate descarta los archivos de
  `changesSince(worktree, base)` con estado `agregado`, que son test (`isTestFile`) y no están en
  `plan.tests`, con
  `discardChanges` y el aviso `se descartaron tests que el plan no declara: …`. Es lo que hoy hace el
  reset entre intentos. Cuando el gate pasa, aplica la limpieza de la decisión 9.

**El cuerpo nuevo de `planificar`:**

```ts
export const planificar: PhaseFn = async (ctx) => {
  const comun = await armarComun(ctx);
  const sesion = sesionAnterior(ctx.run);
  const motivo = gateRechazado(ctx.events, ctx.action.instruccion);
  if (sesion !== undefined && motivo !== undefined) {
    const retomado = await intentoRetomado(ctx, comun, sesion, motivo);
    if (retomado.result.tipo === "ok" || retomado.result.tipo === "limite")
      return gateYCierre(ctx, comun, retomado);
    ctx.emit({
      tipo: "aviso",
      fase: "planificar",
      texto: `no se pudo retomar la sesión del plan (${retomado.result.motivo}): planifica de cero`,
    });
  }
  return gateYCierre(ctx, comun, await intentoNuevo(ctx, comun));
};
```

- **`gateYCierre`** devuelve el `limite` tal cual, como hoy hace planificar en las líneas 171–174.

**Helpers, exportados para los tests:**

```ts
/** El id de la sesión del último intento, o undefined. Un archivo roto cuenta como ausente. */
export function sesionAnterior(run: RunPaths): { sessionId: string; nombre: string } | undefined;

/**
 * El motivo del gate, si este intento es el reintento de un plan rechazado: la última
 * `accion_terminada` de planificar es `falla` de clase `gate`, su motivo es la instrucción de este
 * intento, y después no hubo `rehacer` ni `cambios_pedidos`.
 */
export function gateRechazado(
  events: readonly RunEvent[],
  instruccion: string | undefined,
): string | undefined;
```

**Con la PR 09 mergeada:** `intentoRetomado` no corre los pasos 3 a 6 de la PR 09 (candidatas, refs,
índice). En `gateYCierre`, el paso 9 de la PR 09 lee las candidatas de `candidatas.json`.

### `src/agent/session.test.ts`

- El test existente «las opciones llevan settingSources vacío, solo los MCP declarados, deny por
  defecto y sin persistir» sigue afirmando `persistSession: false` sin `sessionId`: no se toca.

### `test/helpers/sim-sdk.ts`

- **Sin cambios de comportamiento.** `records[n].options` ya guarda `resume` y `sessionId`. Un `resume`
  que falla se simula con un guion de `subtype: "error_during_execution"`, que `runSession`
  convierte en `falla infra`.

## Tests (escribir primero y verlos fallar)

**`src/agent/session.test.ts`:**

1. **«con sessionId la sesión se persiste con ese id; con resume, retoma; sin ninguno, no se
   persiste»:** tres llamadas a `buildOptions`. Comprueba `{ sessionId, persistSession: true }`,
   `{ resume, persistSession: true }` sin `sessionId`, y `{ persistSession: false }`. **Hoy falla:**
   `buildOptions` siempre fija `persistSession: false` y no pasa ni `sessionId` ni `resume`.

**`src/phases/planificar.test.ts`.** Para el reintento, el test escribe con `appendEvent` los eventos
que dejaría el runner: `accion_iniciada planificar`,
`accion_terminada planificar { falla, gate, motivo }`, y otra vez `accion_iniciada`. Después llama con
`contextFor(run, "planificar", deps, { intento: 2, instruccion: motivo })`.

2. **«un plan rechazado por el gate se corrige retomando la misma sesión, con el motivo como único
   mensaje»:**
   - el guion 1 escribe `tests/ac1.mjs` y declara además `tests/ac2.mjs` sin escribirlo, así que el
     gate lo rechaza con «el plan declara el test tests/ac2.mjs, pero no está escrito»;
   - el guion 2 escribe `tests/ac2.mjs` y devuelve el plan.

   **Afirma:**
   - `records[1].options.resume === records[0].options.sessionId`;
   - `records[1].prompt` empieza con «El gate rechazó el plan que devolviste» y contiene el motivo,
     pero **no** «Exportar pedidos a CSV»;
   - `tests/ac1.mjs` del intento 1 sigue en el worktree, y el resultado es `ok`.

   **Hoy falla:** la segunda sesión es nueva, sin `resume`, con el prompt completo.
3. **«si retomar falla, planifica de cero en el mismo intento y lo avisa»:**
   - el guion 2 es `{ subtype: "error_during_execution" }`;
   - el guion 3 es un plan válido.

   **Afirma:**
   - hubo 3 llamadas;
   - `records[2].options.resume` es `undefined` y su prompt contiene «Exportar pedidos a CSV»;
   - hay un aviso que empieza con «no se pudo retomar la sesión del plan»;
   - el resultado es `ok`.

   **Hoy falla:** no hay `resume` ni aviso.
4. **«un pedido de cambios no retoma la sesión»:** después de un plan que pasó el gate, se escribe
   `cambios_pedidos`. La sesión siguiente no lleva `resume`, y `planificar-sesion.json` no existe
   porque se borró al pasar el gate. **Hoy:** pasa lo de no retomar, pero la parte del archivo falla,
   porque el archivo no existe nunca.
5. **«un test que el intento retomado dejó sin declarar se descarta»:**
   - el guion 1 escribe `tests/ac1.mjs` y `tests/sobra.mjs` y declara solo el primero, con otro error
     que hace fallar el gate;
   - el guion 2 corrige y devuelve el plan con solo `tests/ac1.mjs`.

   **Afirma:** `tests/sobra.mjs` no existe, no está en `locked.json`, y hay un aviso de
   descarte.
6. **El existente «un reintento arranca de la base: los tests del intento anterior no quedan»** no
   escribe eventos de un gate rechazado: tiene que seguir pasando sin cambios, por el camino nuevo.

## Docs a actualizar

- **ADR nuevo:** `docs/adr/0025-planificar-retoma-tras-el-gate.md`, con las decisiones 1, 2, 3, 6 y
  9, y el residuo en modo token.
- **`docs/plan-de-raiz/`:** nada; la PR 02 mide el resultado.
- **README y SKILL.md:** sin cambios. Es interno.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

## Fuera de alcance

- Retomar sesiones de otras fases: implementar, revisar o probar.
- Retomar después de un `limite` o de un proceso que murió en medio de la sesión.
- El gate como herramienta (PR 11), que reduce cuántas veces se llega acá.

## Riesgos y cómo se detectan

- **Una versión del SDK cambia la semántica de `resume`.** Lo atrapa el fallback de la decisión 6 y
  queda un aviso visible en el log. `stats --runs` muestra si los reintentos dejan de abaratarse.
- **Las conversaciones persistidas llenan el disco.** Solo de planificar, y se borran al pasar el
  gate. Un run abortado en medio deja una: es un residuo chico, y queda en el ADR.
- **El worktree del intento rechazado tiene basura que el gate no ve.** Lo cubre
  `limpiarNoDeclarados` para los tests. Lo ajeno sigue descartado en `gateYCierre`, como hoy.
