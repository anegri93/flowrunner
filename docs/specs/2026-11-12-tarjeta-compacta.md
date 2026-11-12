# La tarjeta compacta del panel de Orca

Estado: diseño aprobado en la conversación · 2026-11-12

## Problema

Con tres runs vivos, el panel de Orca ya no entra en la pantalla. Cada tarjeta gasta líneas en cosas
que no ayudan a decidir:

- el rótulo «TIEMPO» con el reloj grande abajo;
- el id largo (`PIZ-14-20261112-140655`) repetido debajo de la clave;
- la lista de etapas pendientes («Aprobar · Implementar · Verificar · …») en dos líneas.

Al mismo tiempo, no se ve qué te necesita: «te espera», «trabajando» y «en cola» tienen el mismo peso
y el orden es solo por fecha. «Abortar el run», la acción más rara y más peligrosa, es lo más
llamativo de cada tarjeta.

## Decisión

Cada run es una tarjeta compacta de 3 o 4 líneas (la opción A de las maquetas), y el panel se ordena
por lo que te necesita. Solo cambia `orca/`: todo lo que la tarjeta muestra ya viene en
`flowrunner watch --json`. `flowrunner watch` en la terminal queda igual.

Alternativas descartadas:

- **Lista densa, una fila por run.** Entra más, pero el título se corta siempre y las decisiones
  quedan a un toque de distancia.
- **Secciones con rótulo («Te necesita», «Trabajando», «En cola»).** Ordena bien, pero suma rótulos
  y tres estilos de fila. El orden de esta spec da lo mismo sin rótulos.

## El orden del panel

De arriba hacia abajo, y dentro de cada grupo el que arrancó último primero:

1. **Te necesita:** `esperando_aprobacion` y `detenido`.
2. **Trabaja:** `en_curso` y `pausado_por_limite`.
3. **En cola:** `en_cola`.
4. **PR abierta:** `entregado`, con la PR sin mergear o ya mergeada esperando aprender.
5. **Cerrados:** la sección de hoy, plegada.

`sortRuns` pasa a ordenar por grupo y después por fecha.

## La tarjeta plegada

```
[CHIP]  PIZ-14 · 2:36 · $0.45                 ⋯  ⌄
Indicador discreto de guardado y salir de la app
sin perder lo último
▬▬▬▬▬▬▬▬▬  (9 segmentos)
▸ Read .flowrunner/verify.sh · ctx 52k
```

- **La primera línea:** la etiqueta, `CLAVE · reloj · costo`, el menú `⋯` y la flecha.
  - Mientras trabaja, la etiqueta es la etapa actual en mayúsculas («PLANIFICAR»), en azul.
  - Si no, el estado de hoy (`RUN_CHIP`), con estos dos cambios: `detenido` dice «SE DETUVO» y todo lo
    que te necesita va en amarillo.
  - El costo falta si es cero, y lleva `≥` mientras una sesión corre, como hoy.
- **El título:** dos líneas como máximo, cortado con `…`. Entero en el `title` del elemento.
- **La barra:** un segmento por cada una de las nueve etapas, en el orden de `PHASES`. El color sale
  del estado de la etapa (`stationsOf`):
  - verde, lista; gris con rayas, salteada;
  - azul, la que trabaja, latiendo; azul quieto, la que espera (aprobar, el merge);
  - amarillo, volvió; rojo, falló o se detuvo;
  - gris oscuro, pendiente.

  Cada segmento lleva `aria-label` con la etapa y su estado. Con movimiento reducido, no late.
- **La línea «ahora»**, según el estado:
  - trabajando: lo que hace la sesión que corre (`nowOf(run).actividad`, la primera);
  - esperando aprobación: «Aprobar el plan · N sub-tasks», y si cambia lo que existe, «· cambia N
    cosas que ya existen» en amarillo;
  - detenido: el motivo, dos líneas como máximo, con «más» si pasa de 140 caracteres o tiene saltos de
    línea, para verlo entero (qué motivos están
    abiertos vive en `Estado`, como el menú: no se guarda);
  - en cola: «Espera un lugar en el repo»;
  - PR abierta: «Espera tu merge · PR #85» con el link, o «Mergeada: aprende al próximo chequeo».
- **Las decisiones**, en un run que te necesita, se ven aunque la tarjeta esté plegada: los botones de
  hoy (`decisiones`), con los arreglos ya escritos arriba, uno por botón.
- **Lo que se va:** el id largo, el rótulo «TIEMPO», la lista de etapas pendientes, el costo suelto
  al pie, «Abrir la PR» y «Abortar el run» al pie (pasan al menú).

## La tarjeta abierta

Toda tarjeta arranca plegada, también la de un run vivo: lo que importa ya está en sus cuatro líneas,
y las decisiones se ven igual. Lo que la persona abre se guarda en `abiertos`, como hoy.

Abierta es lo mismo que la plegada, y debajo, separado por una línea, el recorrido que ya existe, sin el paso `pendiente`: lo que falta ya lo dice la barra. El bloque
«ahora» de hoy sigue bajo el paso actual, sin repetir la línea «ahora» de arriba.

En un run detenido, el recorrido arranca plegado en una línea: «Recorrido · 11 pasos · 1 vuelta».
Tocarla lo abre, con la misma flecha y el mismo mapa `abiertos` (clave `<run>:recorrido`).

## El menú ⋯

Un botón con `aria-haspopup="menu"` que abre una lista debajo, dentro del frame:

- «Ver el plan», si planificar ya terminó;
- «Ver el informe» (`flowrunner report <run>`, que sirve también con el run vivo);
- «Abrir la PR», si hay una;
- una línea, y «Abortar el run…» en rojo, si el run se puede abortar (`canAbort`).

Abortar sigue pidiendo la confirmación de hoy, que se dibuja en la tarjeta. El menú se cierra al
elegir, al tocar afuera o con Escape. Hay un solo menú abierto a la vez, guardado en `Estado` (no en
el storage).

## Los cerrados

Una línea cada uno: el ícono (✓ o ✕), `CLAVE · título` cortado, y `reloj · costo` a la derecha. Al
tocarlo se abre como tarjeta, sin línea «ahora», sin decisiones y con el recorrido abierto. Esto
reemplaza lo de la PR #102.

## Tests

Cada test nuevo se ve fallar antes del código que lo pone en verde.

- `orca/src/runs.test.ts`:
  - `sortRuns` pone lo que te necesita arriba, después lo que trabaja, lo que está en cola y la PR
    abierta, y por fecha dentro de cada grupo.
  - El color de cada segmento de la barra según el estado de su etapa.
  - La línea «ahora» de cada estado.
- `orca/src/estado.test.ts`:
  - La tarjeta plegada no lleva el id largo, «TIEMPO» ni las etapas pendientes, y sí la barra.
  - Un run que te necesita muestra sus decisiones plegado.
  - El menú abre, ofrece abortar solo si se puede, y abortar sigue pidiendo confirmación.
  - Un detenido abierto muestra el recorrido plegado en una línea, y se abre.
- Capturas del panel con los runs reales de pizarra-en-vivo y con `orca/test/recorrido.json`, como en
  las PRs del recorrido: lo visual (alto, colores, la barra) no tiene test.

## Fuera de alcance

- `flowrunner watch` en la terminal.
- Copiar la clave al portapapeles: el frame de Orca puede no permitirlo, y nadie lo pidió.
- Cambios en `flowrunner watch --json`.
