# El recorrido de un run, en Orca y en watch

Estado: diseño aprobado en la conversación · 2026-11-12

## Problema

Lo que pasó en un run queda entero en `events.jsonl` y en `sesiones/`, pero las dos vistas lo
muestran como una foto: nueve etapas, cada una con su último estado. Se pierde la historia. En PIZ-9,
verificar volvió dos veces, autofix corrió en el medio, implementar se detuvo, la persona arregló a
mano, revisar volvió una vez y probar se aceptó sin probar. La tarjeta solo mostraba «Verificar ✓
2:20».

`runTree` (`src/watch/tree.ts`) colapsa cada fase a su última corrida. `watch` y Orca (que corre
`flowrunner watch --json`) dibujan ese árbol, así que ninguno de los dos puede mostrar las vueltas.

## Decisión

flowrunner calcula **el recorrido**: la lista ordenada de lo que pasó, con las vueltas agrupadas.
`watch` y Orca lo dibujan con la misma forma, una línea de tiempo, y todo nodo con hijos se pliega y
se despliega igual que la tarjeta de un run.

Alternativas descartadas:

- **Que Orca lea `events.jsonl`.** Ata el plugin al formato del log y duplica la lógica.
- **Mandar los eventos crudos en `watch --json`.** Cada vista tendría que agrupar las vueltas y
  cerrar los intentos por su cuenta.
- **Una pestaña Etapas / Recorrido.** Una decisión más en cada tarjeta, y dos vistas para mantener.

## El modelo

`recorridoOf(input)`, en `src/watch/recorrido.ts`, es una función pura que recorre los eventos una
vez. `runTree` la llama con su mismo `TreeInput` y suma `recorrido: Paso[]` al `RunTree`. `fases`
queda igual: el titular, las decisiones y el bloque «ahora» de Orca la siguen usando.

```ts
type Paso =
  | {
      tipo: "etapa";
      clave: string;            // estable: `p<índice>`
      fase: Phase;
      inicio: string;           // ISO, del accion_iniciada
      segundos: number | undefined;
      costoUsd: number;         // los `uso` de esta corrida
      resultado: "ok" | "vuelve" | "falla" | "pregunta" | "pausa" | "espera" | "corriendo" | "cortada" | "salteada";
      motivo: string | undefined;
      unidades: readonly string[];  // a quién devolvió trabajo
      pr: number | undefined;   // solo entregar
      sesiones: SessionNode[];
      subtareas: UnitNode[];    // solo implementar: las que corrieron en esta corrida
      vuelta: number | undefined;
      abierto: boolean;
      chequeos: number;         // cuántas corridas junta (regla 9)
    }
  | { tipo: "tuyo"; clave: string; at: string; que: TuyoQue; detalle: string | undefined; vuelta: number | undefined }
  | { tipo: "auto"; clave: string; at: string; que: "autofix"; vuelta: number | undefined }
  | { tipo: "pendiente"; clave: string; fases: readonly Phase[] };

type TuyoQue =
  | "aprobaste" | "pediste cambios" | "arreglaste a mano" | "pediste un arreglo"
  | "aceptaste" | "aceptaste sin probar" | "rehiciste" | "reanudaste" | "abortaste";

interface Vuelta { numero: number; fase: Phase; veces: number; abierta: boolean; abierto: boolean }
```

`RunTree` suma `recorrido: Paso[]` y `vueltas: Vuelta[]`.

### Reglas

1. **Una etapa por corrida.** `accion_iniciada` abre un paso y `accion_terminada` lo cierra con su
   resultado. Si el run terminó con un paso abierto, ese paso queda `cortada`. Si no terminó, queda
   `corriendo`.
2. **Costo y sesiones por corrida.** Un `uso` suma al paso abierto de su fase. Una sesión es del paso
   en el que cayeron sus `uso`, por el nombre de `sesion`. Una sesión que todavía no tiene `uso` es
   del paso abierto de su fase.
3. **Sub-tasks por corrida.** En implementar, `subtareas` lista solo las sub-tasks con eventos
   `unidad` dentro de esa corrida, con el último estado que tuvieron en ella.
4. **Aprobar no es una etapa.** Su corrida que termina en `espera` se muestra como «te espera»
   mientras no haya respuesta. `aprobado` la reemplaza por el paso tuyo «aprobaste» y `cambios_pedidos`
   por «pediste cambios», con su motivo.
5. **La PR va en entregar.** El evento `pr` llena `pr` en el paso de entregar.
6. **Tus pasos y el autofix.** `cambios_pedidos`, `arreglo_manual`, `arreglo_pedido`, `aceptado`,
   `sin_probar_aceptado`, `rehacer`, `reanudado` y `abortado` son pasos `tuyo`, y `autofix` es un paso
   `auto`.
7. **Las vueltas.** Un paso de etapa que termina en `vuelve`, `falla` o `pregunta` abre una vuelta si
   no hay una abierta. Todos los pasos siguientes llevan ese número hasta que la fase que la abrió
   vuelve a terminar en `ok`; ese paso ya no lleva número y cierra la vuelta. Si dentro de la vuelta
   vuelve otra etapa, sigue la misma vuelta: no se anida. También la cierran un `rehacer` y el
   arranque de una fase posterior a la que la abrió: así probar en rojo, aceptado, no deja la entrega
   adentro de su vuelta.
8. **Lo pendiente.** Si el run no terminó, va un solo paso `pendiente` con las fases posteriores a la
   del último paso de etapa, en el orden de `PHASES`. Si ya terminó, no va ninguno.
9. **Los chequeos que esperan son un paso.** Una corrida que arranca justo después de otra de su
   misma fase que terminó en `espera` sigue ese paso: suma `chequeos`, sus segundos y su costo, y se
   queda con el resultado del último. Aprender chequea el merge cada 10 minutos; sin esto, cada
   chequeo era una fila. `watch` y Orca lo muestran como «Aprender · 9 chequeos».
10. **Lo que no entra.** Los rechazos de tripwires, los avisos, las decisiones internas, `encolado` y
   `lecciones*`. Siguen en el detalle de la etapa (`report --fase`).

### Abierto por defecto

Lo calcula flowrunner, así Orca y `watch` nunca discrepan:

- **Una vuelta** arranca abierta si sigue abierta o si el run está detenido dentro de ella.
- **Un paso de etapa** arranca abierto si está `corriendo` o si es el último paso de un run detenido.
- **Una sub-task** arranca abierta si está corriendo. Eso ya lo dice `UnitNode.estado`, así que no
  necesita un campo nuevo.
- **Todo lo demás** arranca plegado.

## Orca

- **La tarjeta expandida** dibuja el recorrido en lugar de las nueve etapas, como una línea de tiempo
  con un punto de color por resultado: verde ok, amarillo volvió, rojo falla, azul tuyo o en curso,
  gris auto, punteado pendiente. Cada fila lleva la hora, la duración y el costo.
- **La tarjeta plegada** muestra solo el último paso.
- **El bloque «ahora»** (motivo, sub-tasks, actividad, decisiones y aviso) va solo bajo el último paso
  de etapa, que por eso no se pliega. Si su vuelta está plegada, va debajo de la línea de la vuelta:
  las decisiones nunca quedan escondidas. Un run cerrado o abortado no lo lleva.
- **La jerarquía se ve:** una línea une el punto de cada paso con el del siguiente, y lo que cuelga de
  un nodo (los pasos de una vuelta, las sub-tasks, las sesiones) va con una guía bajo su nombre.
- **Una vuelta** se marca con un borde amarillo a la izquierda de sus pasos. Plegada es una línea:
  `↺ Verificar volvió 2 veces → ST-1 · 4 pasos · 6:10 · $0.40`.
- **Se pliegan** la vuelta, el paso de implementar (sus sub-tasks), la sub-task (sus sesiones) y el
  paso con sesiones (sus sesiones). Cada uno usa la `flecha` y el botón de la tarjeta. El estado va en
  el mismo mapa `abiertos`, con claves `<run>:<clave>` (`<run>:v1`, `<run>:p4`, `<run>:p4/ST-1`), y la
  acción `alternar` suma un `nodo` opcional. Lo que la persona toca pisa el defecto y se guarda.
- **Tocar** el nombre de un paso de etapa abre `report --fase` y tocar una sesión abre sus pasos,
  igual que hoy. Los pasos tuyos y el autofix son texto.
- **Los runs cerrados** usan el mismo recorrido al expandirse, sin pendientes.
- **Un flowrunner anterior** que no manda `recorrido`: Orca dibuja la lista de etapas como hoy.

## watch

- **Las columnas** no cambian: tokens, USD, tiempo y estado. Cada paso es una fila con `HH:MM` delante
  del nombre.
- **Una vuelta** lleva una barra `┃` amarilla a la izquierda de sus filas. El motivo va en la línea de
  abajo, como las notas de hoy. Plegada, es la misma línea que en Orca.
- **Los marcadores:** tus pasos van con `◆` en azul, el autofix con `·` apagado y lo pendiente con `·`
  apagado en una sola fila.
- **Implementar** cuelga sus sub-tasks de esa corrida, y cada sub-task sus sesiones.
- **El teclado:**
  - `↑`/`↓` y `k`/`j` recorren las filas con hijos y las sesiones.
  - `→` despliega y `←` pliega. En una fila ya plegada, `←` sube al padre.
  - `Enter` alterna; en una sesión abre sus pasos, como hoy.
  - `Esc` vuelve.
- **El estado plegado** dura mientras corre el proceso. Sin terminal interactiva (`--json`, salida
  redirigida) se usan los valores por defecto.
- **El run** también se pliega, con el defecto de Orca: abierto si te necesita o no terminó.

## Tests

Cada test nuevo se ve fallar antes de existir el código que lo pone en verde.

- `src/watch/recorrido.test.ts`, con un fixture armado con los eventos reales de PIZ-9:
  - El orden y las horas de los pasos.
  - El costo de cada corrida: implementar 1 da $1.57 e implementar 2 da $0.40.
  - La vuelta de verificar va del primer «volvió» al paso anterior al verificar en verde, con el
    autofix y tu arreglo adentro. La de revisar, igual.
  - Aprobar se convierte en «aprobaste» y la PR se pega a entregar.
  - El pendiente va al final, solo si el run no terminó.
  - `abierto` por defecto: la vuelta con el paso en curso está abierta y el implementar terminado
    está plegado.
  - En un run abortado, ningún paso queda `corriendo`.
  - Un `rehacer` cierra la vuelta abierta.
- `src/watch/tree.test.ts`: `runTree` trae `recorrido` y `vueltas`.
- `src/watch/render.test.ts`: la hora delante del nombre, la barra `┃` en las filas de la vuelta, la
  vuelta plegada en una línea y el pendiente agrupado.
- La navegación de `watch` (`src/cli/watch.ts`): `→` y `←` cambian las filas que se dibujan. Si el
  manejo de teclas no se puede probar sin la TTY, se extrae una función pura `foldKey(state, key)` y
  se prueba esa.
- `orca/src/runs.test.ts`:
  - El bloque «ahora» está solo bajo el último paso de etapa.
  - Sin `recorrido`, la tarjeta cae a la lista de etapas.
- `orca/src/estado.test.ts`: `alternar` con `nodo` guarda `<run>:<clave>` en `abiertos`, y el valor
  sobrevive a un refresco.
- `orca/test/recorrido.json`, un fixture nuevo con PIZ-9 en curso y entregado, armado con `runTree`
  sobre los eventos de `src/watch/piz9.fixture.ts`. `orca/test/watch.json` queda sin `recorrido`: es
  el caso de un flowrunner anterior.

## Fuera de alcance

- Los rechazos y los avisos dentro del recorrido: siguen en el detalle de cada etapa.
- La salida completa de los comandos de verificar: hoy se guardan las últimas 20 líneas en el motivo y
  nada más.
- Rehacer `informe.md` con esta forma. Puede reusar `recorridoOf` más adelante.
