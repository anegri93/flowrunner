# PR 08 · De dónde vino cada decisión, y Aprobar en Orca recién con el plan abierto

Rama: `feat/origen-y-boton-orca` · Depende de: PR 05 (`origenSchema`, `--origen` en el CLI y las
decisiones nuevas de Orca) · Tamaño: chico

## Objetivo

En VF-6 hubo cuatro aprobaciones, todas con `--acepto-cambios`, entre 6 y 64 segundos después de que
el plan quedó listo. Ninguna salió del chat de Claude Code. Lo más probable es que vinieran del botón
de Orca, pero no se puede confirmar, porque `aprobado` no guarda su origen. La de las 01:08 costó unos
US$ 6. Con esta PR:

- cada aprobación y cada pedido de cambios guarda de dónde vino;
- el informe muestra cuánto tardó cada decisión desde que el run empezó a esperar;
- en Orca, Aprobar se habilita recién después de abrir el plan de ese run (D3).

**Métrica:** el informe de cada run nuevo dice el origen y la demora de cada aprobación. En Orca no
hay aprobaciones de un plan que no se abrió.

## Decisiones tomadas (no reabrir)

- **D3:** el botón Aprobar del panel se habilita recién después de abrir la pestaña del plan de ese
  run **en Orca**. Abrirlo con `flowrunner plan` o desde la skill no cuenta: el botón es del panel.
- **Qué plan se abrió:** la «versión» del plan es la cantidad de sesiones de planificar que tiene el
  run. Un pedido de cambios corre planificar de nuevo, la versión cambia, y hay que abrir el plan
  nuevo antes de aprobar.
- **Dónde se guarda:** en un `atom` con `persist: "plugin"`, como `toggled` en
  `orca/src/panel.tsx:49`. Recargar el panel, o reiniciar Orca, no hace volver a abrir un plan ya
  abierto. En cada lectura se borran las entradas de runs que ya no están activos.
- **`origen`:** opcional en `aprobado` y en `cambios_pedidos`. Un evento viejo sin `origen` se
  muestra como «origen desconocido».
- **Quién pasa cada origen:** el CLI pone `terminal` por defecto; la skill pasa `--origen claude`; el
  worker de Orca, `--origen orca`. Lo valida `parseOrigen` de la PR 05.
- **`--acepto-cambios`** sigue igual. El botón de Orca lo manda solo después de mostrar los cambios,
  como hoy.

## Cambios, archivo por archivo

### `src/store/events.ts`

- `aprobado` (línea 110) suma `origen: origenSchema.optional()`.
- `cambios_pedidos` (línea 115) suma `origen: origenSchema.optional()`.

### `src/cli/approval.ts`

- **`approveRun`** (línea 228) suma un parámetro, `origen: Origen = "terminal"`, después de
  `aceptaCambios`. La línea 243 pasa a
  `appendEvent(run.dir, { tipo: "aprobado", cambios_aceptados: cambios.length, origen })`.
- **`requestChanges`** (línea 252) suma `origen: Origen = "terminal"`. La línea 266 escribe
  `{ tipo: "cambios_pedidos", motivo: motivo.trim(), origen }`.

### `src/cli/main.ts`

- **`case "approve"`** y **`case "changes"`**: les pasan `parseOrigen(values.origen)` (de la PR 05).
- **Ayuda:** en `approve` y en `changes`, `[--origen terminal|claude|orca]`.

### `src/report/report.ts`

- **Función nueva `personDecisions(events)`**, para `buildReport`, debajo de `header`. No va al cuerpo
  de la PR:

```md
## Tus decisiones

- 01:07:51 · aprobaste el plan desde orca, 15 s después de que te esperó (7 cambios aceptados)
- 01:29:31 · pediste cambios desde terminal, 1 s después de que te esperó: «CLAUDE.md queda fuera…»
```

  - La demora es `at` del evento menos `at` del último `accion_terminada` de `aprobar` con
    `resultado.tipo === "espera"` anterior a él.
  - El origen ausente se escribe «desde un origen desconocido».
  - Con la PR 05, la sección suma `arreglo_pedido`, `arreglo_manual_iniciado` y `aceptado`, con su
    origen. Su demora se mide desde el último `accion_terminada` que dejó el run `detenido`, que es
    el que tiene el `at` más cercano anterior.
  - Sin decisiones, la sección no se escribe.

### `skills/flowrunner/SKILL.md`

En la tabla «Operar los runs», los comandos de `aprobar` y `pedir cambios` (y los de `fix` y `accept`
de la PR 05) suman `--origen claude`. Por ejemplo, `flowrunner approve <run> --origen claude --json`.

### `orca/src/runs.ts`

```ts
/** La versión del plan de un run: cambia cada vez que planificar vuelve a correr. */
export const planVersion = (run: Run): string =>
  `${run.id}#${String(run.fases.find((p) => p.fase === "planificar")?.sesiones.length ?? 0)}`;
```

### `orca/src/decisiones.tsx`

- **Estado nuevo:**

```ts
/** El plan que la persona abrió en Orca, por run: Aprobar se habilita recién con el plan visto (D3). */
const plansSeen = atom("planesVistos", {} as Record<string, string>, { persist: "plugin" });

export function markPlanSeen(run: Run): void {
  update(plansSeen, (m) => ({ ...m, [run.id]: planVersion(run) }));
}

export const planSeen = (run: Run): boolean => read(plansSeen)[run.id] === planVersion(run);

/** Los runs que ya no están activos no necesitan recordar su plan. */
export function forgetPlans(activos: readonly string[]): void {
  update(plansSeen, (m) => Object.fromEntries(Object.entries(m).filter(([id]) => activos.includes(id))));
}
```

- **El botón Aprobar** (hoy el `Button` «Aprobar» de la fila): con `!planSeen(run)` sale
  `disabled`, y debajo aparece `<Text size="xs" muted>Abrí el plan para poder aprobar.</Text>`. El
  botón «Plan» de al lado no cambia.
- **El flujo de confirmación** de «aprobar», con y sin cambios a lo existente, queda igual una vez
  habilitado.

### `orca/src/panel.tsx`

- **Marcar el plan como visto:** `open()` (línea 107) suma un tercer parámetro opcional,
  `onOpened?: () => void`, que se llama solo si `answer.ok`.
  - El link «Aprobar» de `Stage` (línea 218) pasa a
    `open(run.id, { tipo: "plan" }, () => markPlanSeen(run))`.
  - El `onPlan` que recibe `Decisions` (línea 188) pasa a
    `() => void open(run.id, { tipo: "plan" }, () => markPlanSeen(run))`.
- **Olvidar los runs que se cierran:** `refresh()` (línea 77), después de guardar un snapshot sin
  error, llama a `forgetPlans(next.runs.map((r) => r.id))`.

### `orca/src/worker.ts`

- **`decisionArgs`** (línea 96), con el sufijo ` --origen orca`:
  - `aprobar`: `approve ${quote(id)}` y `approve ${quote(id)} --acepto-cambios`;
  - `cambios`: `changes ${quote(id)} ${quote(motivo)}`.

  Los de `fix` y `accept` ya lo llevan desde la PR 05.

## Tests (escribir primero y verlos fallar)

`src/cli/approval.test.ts` (o `test/approval.int.test.ts`, que ya lanza runs que esperan aprobación):

| Nombre | Afirma | Por qué falla hoy |
|---|---|---|
| «approve y changes guardan su origen; sin --origen es terminal» | `approve <id> --origen orca` escribe `aprobado` con `origen: "orca"`; `changes <id> "x"` escribe `cambios_pedidos` con `origen: "terminal"` | el campo no existe |
| «un origen inválido sale 1 y dice cuáles valen» | `approve <id> --origen web` sale 1, con «--origen tiene que ser terminal, claude u orca» | — |

`src/report/report.test.ts`:

- «el informe dice de dónde vino cada decisión y cuánto tardó». Con un log que tiene un `aprobar`
  `espera` a las 01:07:36 y un `aprobado` con `origen: "orca"` a las 01:07:51: el informe contiene
  «aprobaste el plan desde orca, 15 s después de que te esperó». Con un `aprobado` sin `origen`,
  contiene «desde un origen desconocido».

`orca/src/runs.test.ts`:

- «la versión del plan cambia cuando planificar vuelve a correr»: un run con una sesión de
  planificar y el mismo run con dos dan versiones distintas.

`orca/src/worker.test.ts`:

- «aprobar y cambios mandan --origen orca».

`orca/src/panel.test.tsx`:

| Nombre | Afirma | Por qué falla hoy |
|---|---|---|
| «Aprobar está deshabilitado hasta abrir el plan de ese run en Orca» | PIZ-3: el botón Aprobar existe con `disabled`, y está el texto «Abrí el plan para poder aprobar.». Después de `press({ role: "button", text: "Plan" })`, con un `flowrunner.abrir` que contesta `ok`, el botón se habilita | hoy está habilitado de entrada |
| «si el plan no se pudo abrir, Aprobar sigue deshabilitado» | con `flowrunner.abrir` que contesta `ok: false` | — |
| «un plan nuevo después de pedir cambios hay que abrirlo de nuevo» | con un snapshot donde PIZ-3 tiene una sesión más de planificar, el botón vuelve a `disabled` | — |

**Tests existentes que cambian** (es un cambio de contrato de la UI):

- «aprobar pide confirmación; Cambios manda el motivo escrito» (línea 139) y «aprobar un plan que
  cambia lo existente muestra los cambios y manda que se aceptaron» (línea 196): antes de
  `press({ role: "button", text: "Aprobar" })`, `press({ role: "button", text: "Plan" })`. Para eso,
  sus `withRuns` suman un `"flowrunner.abrir": () => ({ ok: true, mensaje: "abierto" })`.
- **Recarga del panel:** si `orca/testing` conserva los `atom` con `persist` entre dos `mount`,
  sumar «después de recargar el panel, un plan ya abierto sigue habilitando Aprobar». Si no los
  conserva (hay que mirarlo en el tipo de `mockHost`), no se escribe, y queda en «Riesgos».

## Docs a actualizar

- **`orca/README.md`:** «Aprobar se habilita después de abrir el plan (el botón Plan o el link de la
  etapa Aprobar). Un plan corregido se vuelve a abrir».
- **`README.md`:** en la sección del flujo con Orca, la misma línea.
- **`skills/flowrunner/SKILL.md`:** lo de arriba (`--origen claude`).
- **ADR:** no hace falta uno propio. El ADR 0023 de la PR 05 suma una línea: «el origen de cada
  decisión queda en el evento y en el informe».

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
pnpm orca:test   # 1 test ya falla en main: «lee solo los runs del proyecto enfocado…». Ningún otro.
```

## Fuera de alcance

- Pedir un tiempo mínimo entre que el plan queda listo y la aprobación.
- Que la skill o la terminal exijan haber visto el plan: la skill ya tiene su regla (mostrar
  `cambia_lo_existente` antes de aprobar), y la terminal es de la persona.
- Auditar aprobaciones viejas: sin `origen`, se muestran como desconocidas.

## Riesgos y cómo se detectan

- **La versión por cantidad de sesiones.** Si planificar falla el gate y reintenta antes de esperar,
  la cantidad sube antes de que la persona vea nada. No importa: la versión que cuenta es la del
  momento en que el plan espera, y el plan se abre después de esa espera. Lo cubre «un plan nuevo
  después de pedir cambios…».
- **Persistir del lado del plugin**, sin un test de recarga si `orca/testing` no lo permite. Se
  detecta a mano: abrir el plan, recargar el plugin desde Orca y ver que Aprobar sigue habilitado.
  Si no persiste, el costo es volver a abrir el plan: es seguro, no peligroso.
- **Un snapshot de un flowrunner viejo, sin sesiones de planificar en `fases`:** la versión queda
  `id#0`. Abrir el plan la marca igual y habilita.

## Conflicto con contratos

Ninguno. C4 ya prevé `origen` opcional en `aprobado` y en `cambios_pedidos`, y C5, `--origen` en
`approve` y `changes`.
