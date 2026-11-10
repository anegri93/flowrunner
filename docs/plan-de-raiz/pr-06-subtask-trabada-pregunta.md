# PR 06 · Una sub-task trabada pregunta

Rama: `feat/subtask-trabada-pregunta` · Depende de: PR 05 (el outcome `pregunta` y sus opciones), y de
#70 y #72 mergeadas · Tamaño: chico

## Objetivo

Una sub-task que termina sin cambios reintenta con el motivo, y recién al segundo intento sin
avanzar falla. En los runs de la línea de base **ningún reintento sin cambios salió bien**:

- PIZ-2 · ST-1: tres intentos, ninguno cambió nada.
- VF-1 · ST-5: dos intentos, frenados por el bloqueo de formato.
- VF-6 · ST-6: cuatro veces «sin cambios» sobre `CLAUDE.md`; y ST-7, dos intentos.

Cada intento es una sesión de Sonnet entera. Con esta PR, la primera sesión sin cambios detiene el run
con una pregunta, con lo último que dijo el agente y lo que le rechazó el bloqueo, y las demás
sub-tasks se integran igual.

- **Métrica:** sesiones de implementar sin cambios por sub-task. Hoy son 2 o más; tienen que quedar en
  1 como máximo.

## Decisiones tomadas (no reabrir)

- **El outcome de C2:** implementar devuelve `{ tipo: "pregunta", motivo, unidades }`, y la PR 05 ya
  lo convierte en `detenido` con las opciones de la fila «implementar» de C1: `fix --unidad` por cada
  una, `fix --yo`, `rerun --desde planificar` y `abort`.
- **Qué detiene al primer intento**, sin reintento:
  - una sub-task en su primera pasada que no cambió ningún archivo, con o sin escrituras rechazadas;
  - una sub-task devuelta (por verificar o por un `fix`) que no cambió nada **y** tuvo escrituras
    rechazadas.
- **Lo que no cambia:**
  - una sub-task **devuelta sin rechazos y sin cambios** sigue cerrando `sin_cambios` como éxito.
    Su código ya está integrado y verificar decide; con la PR 05, si verificar sigue en rojo,
    pregunta;
  - **los reintentos mecánicos se quedan**: el diff que rompe una regla del doble control, el commit
    que choca al integrarse y el «no dejó nada para commitear». El agente los corrige con el motivo,
    sin criterio humano, hasta `MAX_UNIT_ATTEMPTS` (3). Si se agotan, la sub-task también termina en
    la pregunta del final de la fase.
- **Cómo convive con #70.** #70 dejaba un segundo intento para una escritura rechazada «porque pudo
  ser un error del agente», como escribir fuera del alcance. Con la PR 05 ese segundo intento lo
  reemplaza `fix --unidad ST-n "<instrucción>"`: es la misma sesión, pero con la instrucción de la
  persona en vez del motivo genérico. Como en los datos ningún reintento sin cambios salió bien,
  pagar el segundo intento a ciegas no vale la pena.
- **Al final de la fase, cualquier sub-task fallida da una `pregunta`**, nunca una `falla gate`.
  `unidades` = las fallidas, en el orden de `todo`, más las que quedaron bloqueadas por ellas. Las
  fallas `fatal` (entorno, límite) siguen como hoy.

## Cambios, archivo por archivo

### `src/phases/implementar.ts`

Sobre la versión con #70 y #72 mergeadas.

- **`UnitResult`:**

```ts
type UnitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly fatal?: Outcome;
      readonly motivo: string;
      /** Se detiene sin reintentar: lo que falta lo decide la persona. */
      readonly pregunta?: true;
    };
```

- **En `runUnit`, la rama `if (changes.length === 0)`** (en #70, desde la línea 322):
  - se queda igual el `if` de «devuelta y sin rechazos → `sin_cambios`, `{ ok: true }`»;
  - se borran la variable `stalled` y su rama («dos intentos seguidos sin avanzar»). En su lugar:

```ts
const said = result.texto.trim();
const blocked =
  rejectedWrites.length === 0
    ? ""
    : `. El bloqueo rechazó lo que intentó escribir: ${[...new Set(rejectedWrites)].join("; ")}`;
const stop = `${task.id} no cambió ningún archivo${blocked}${said === "" ? "" : `. Lo último que dijo: ${said.slice(0, 400)}`}`;
emit({ tipo: "unidad", fase: "implementar", unidad: task.id, estado: "fallida", motivo: stop });
// El worktree queda, como el de toda sub-task fallida, para mirarlo; `abort` lo borra.
return { ok: false, motivo: stop, pregunta: true };
```

  - se borra la línea `stalled = false;` que viene después.
- **El final de la fase**, desde el `const blocked = blockedByFailure(...)` (en #70, desde la línea 443):

```ts
if (failed.size > 0) {
  const ids = todo.map((t) => t.id).filter((id) => failed.has(id));
  const reasons = ids.map((id) => {
    const r = failed.get(id);
    return `- ${r !== undefined && !r.ok ? r.motivo : id}`;
  });
  const tail_ = blocked.length > 0 ? `\nQuedaron sin arrancar, porque dependen de esas: ${blocked.join(", ")}` : "";
  return {
    tipo: "pregunta",
    motivo: `${ids.length === 1 ? "una sub-task no pudo terminar" : `${String(ids.length)} sub-tasks no pudieron terminar`}:\n${reasons.join("\n")}${tail_}`,
    unidades: [...ids, ...blocked],
  };
}
```

- **La ruta de los intentos agotados** (en #70, línea 408: `no salió en ${MAX_UNIT_ATTEMPTS} intentos`)
  se queda igual: devuelve `{ ok: false, motivo }` sin `pregunta`, y la recoge el bloque de arriba.
- **El comentario de la cabecera** del archivo suma: «Una sub-task sin cambios no reintenta: la fase
  termina en una pregunta (ADR 0023)».

### `prompts/implementar.md`

Sin cambios: el `instruccion` de un `fix` ya llega por el bloque «# Atención: esto ya se intentó».

## Tests (escribir primero y verlos fallar)

En `src/phases/implementar.test.ts`:

| Nombre | Afirma | Por qué falla hoy |
|---|---|---|
| «una sub-task sin cambios pregunta al primer intento, con lo último que dijo» | reemplaza a «una sub-task que no avanza dos intentos seguidos se corta con lo último que dijo» (línea 144): outcome `{ tipo: "pregunta", unidades: ["ST-1"] }`, el motivo contiene «No pude instalar jsqr», y hay **un** `ST-1:iniciada` y un `ST-1:fallida` | hoy son dos intentos, y el outcome es `falla gate` |
| «una sub-task devuelta que no cambió nada porque el bloqueo la frenó pregunta y dice qué rechazó» | reemplaza al test de #70 con el nombre parecido: outcome `pregunta` con el texto «El bloqueo rechazó lo que intentó escribir: CLAUDE.md es parte de CLAUDE.md…», `sim.records` de largo 1 y sin `ST-1:sin_cambios` | hoy reintenta, y es `falla gate` |
| «una sub-task devuelta sin cambios y sin rechazos sigue cerrando sin cambios» | con `unidades: ["ST-1"]`, una sesión que no escribe da outcome `ok` y `ST-1:sin_cambios` | pasa hoy: fija lo que no cambia |
| «una sub-task que falla no corta la otra, que se integra, y la fase pregunta por la fallida» | reemplaza a «una sub-task que falla definitivamente no corta la otra, que se integra» (línea 304): outcome `pregunta` con `unidades: ["ST-1"]` y `ST-2:integrada` | hoy es `falla gate` |
| «las que dependen de una sub-task trabada entran en la pregunta» | con ST-1 sin cambios y ST-2 que depende de ST-1: `unidades: ["ST-1", "ST-2"]`, y el motivo dice «Quedaron sin arrancar, porque dependen de esas: ST-2» | — |
| «un diff que rompe las reglas sigue reintentando con el motivo» | el test de hoy de la línea 271 («una sub-task que viola el doble control…») pasa sin cambios | fija lo que no cambia |

En `src/engine/engine.test.ts` (sobre la PR 05):

- «una pregunta de implementar detiene sin accept y con fix por cada sub-task». Con
  `done("implementar", { tipo: "pregunta", motivo: "x", unidades: ["ST-1", "ST-2"] })`, las opciones
  son `fix --unidad ST-1`, `fix --unidad ST-2`, `fix --yo`, `rerun --desde planificar` y `abort`,
  ninguna con `accept`.

## Docs a actualizar

- **`docs/adr/0023-detenerse-y-preguntar.md`**, el de la PR 05: suma un párrafo «Sub-tasks
  trabadas», con los datos de PIZ-2, VF-1 y VF-6 de arriba. No hace falta un ADR propio.
- **`README.md`:** en la sección de la PR 05, una línea: «una sub-task que no puede avanzar también
  te pregunta, y las demás se integran igual».

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

`pnpm orca:test` no cambia: hay un test que ya falla en `main` y es el único.

## Fuera de alcance

- Cambiar `MAX_UNIT_ATTEMPTS` o la lógica de los reintentos mecánicos.
- Reintentos con otra instrucción automática.
- Que `fix --unidad` agrande el alcance de la sub-task (`--alcance`): queda para otra tanda. Con esta
  PR, lo que está fuera del alcance se resuelve con `fix --yo` o replanificando.

## Riesgos y cómo se detectan

- **Un test de integración que esperaba `falla gate` de implementar.** `git grep -n "no avanzó\|no salió en" test/`
  no encuentra ninguno hoy. Si la suite de integración se pone en rojo en `fase1`, `fase5` o
  `implementar-resume`, es por esto: actualizar el `expect` a `pregunta`.
- **Retomar a mitad de implementar.** `implementar-resume.test.ts` cuenta `iniciada` por sub-task con
  `tried`. Con un solo intento sin cambios, una sub-task retomada que ya tenía un `fallida` no vuelve
  a correr, porque no está en `todo` del retome. Lo cubren los tests de `implementar-resume.test.ts`
  que ya existen: si alguno falla, revisar que `tried` siga contando solo los `iniciada` de la
  entrada actual.

## Conflicto con contratos

Ninguno. Usa C1 (fila «implementar») y C2 tal como están.
