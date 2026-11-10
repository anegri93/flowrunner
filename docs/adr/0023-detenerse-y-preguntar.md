# 0023 · Un run trabado se detiene y pregunta

Estado: Aceptada · 2026-11-10

## Contexto

En VF-6, verificar devolvió trabajo una y otra vez: el máximo era 2 vueltas por fase
(`MAX_ROUNDS`), y cada `rerun` lo volvía a cero. Diagnosticar y reparar adivinaban de quién era el
rojo, y cada replan arrancaba de cero. Una traba de cinco minutos (un `CLAUDE.md` que ningún agente
puede escribir, un script que faltaba y AC-12 atribuido a la sub-task equivocada) se convirtió en 70
minutos, 9 entradas a implementar, 9 a verificar y US$ 17. Cuando el run se detenía, decía un solo
comando para seguir, casi siempre `resume`, que repetía lo mismo.

## Decisión

Ante el primer rojo, el run se detiene con **una** pregunta y sus respuestas posibles como comandos.
Recién sigue cuando la persona elige una. Es el contrato C1 a C5 del plan de raíz.

1. **La pregunta vive en `detenido` (D1).** No hay estado nuevo. `Halt` suma `opciones` (nunca vacía,
   en orden de preferencia) y `unidades` (a qué sub-tasks se atribuye). `siguiente` se queda, y es
   siempre `opciones[0].comando`, para lo que ya lo leía.
2. **Solo el engine arma las opciones,** con una función pura, `opcionesDe`, en `halt()`, que es la
   única forma de detener un run. Como se calculan al reducir, un run viejo detenido también las tiene.
   Según la detención:
   - verificar, revisar o probar con sub-tasks: `fix --unidad` por cada una, `fix --yo`, `accept`,
     `rerun --desde planificar` y `abort`;
   - implementar con sub-tasks (el outcome `pregunta`): lo mismo sin `accept`, porque no se entrega
     una sub-task sin hacer;
   - criterios sin probar: `rerun --desde probar`, `accept`, `fix --yo` y `abort`;
   - esperando un arreglo a mano: `resume` y `abort`;
   - cualquier otra (entorno, invariante, infraestructura agotada, presupuesto): el `siguiente` de
     siempre y `abort`.
3. **Un comando de la persona vale solo si el halt actual lo ofrece.** `fix --unidad` (con cada
   sub-task entera entre las del halt), `fix --yo` y `accept` lo comprueban en el CLI, con un turno
   propio del run para que dos respuestas a la vez no se validen contra el mismo halt, y otra vez en el
   reductor: un evento que no se ofreció no hace nada. Si el engine no tomó la respuesta, porque otro
   comando escribió antes, el comando lo dice y no lanza nada, y el informe no la lista. `resume` y `rerun` siguen como antes, salvo
   durante un arreglo a mano (abajo).
4. **Las vueltas automáticas son 0 por defecto (D4).** Cada repo puede pedir de 0 a 3 con `vueltas` en
   su config. El valor se congela en `run_creado`: un run sin el campo es de antes y vale 2, así que
   los runs en curso no cambian a mitad de camino. Con 0, el primer `vuelve` ya es una pregunta.
5. **Diagnosticar y reparar corren solos solo con vueltas (D5).** Con 0, verificar no los llama: el
   que decide es la persona.
6. **El outcome `pregunta`:** una fase que sabe que reintentar solo no sirve devuelve
   `{ tipo: "pregunta", motivo, unidades? }`. Detiene sin sumar intentos ni vueltas.
7. **Los eventos nuevos** (solo de agregar: un log viejo se lee igual):
   - `arreglo_pedido`: vuelve a implementar con esas sub-tasks y esa instrucción, sin sumar vueltas.
     Desde una pregunta de implementar entran también las que quedaron bloqueadas, con la instrucción
     prefijada `Para ST-n: …`; si no, una sub-task que depende de la arreglada no arrancaría nunca;
   - `arreglo_manual_iniciado` y `arreglo_manual`: lo arreglás a mano (D2), ver abajo;
   - `aceptado`: sigue a la fase siguiente, solo desde verificar, revisar o probar, y solo en la fase
     del halt. Generaliza `sin_probar_aceptado`, que se sigue leyendo igual. Lo aceptado y los
     arreglos a mano van al informe y a la PR, en «Lo que aceptaste al seguir».
8. **`fix --yo` y `resume` (D2).** `fix --yo` deja el run esperando, guarda en el evento el HEAD del
   worktree de la feature (`base`) y dice su ruta, sin lanzar nada. `resume` chequea todo lo que
   cambió desde `base`: los commits que la persona hizo por su cuenta, uno por uno (un secreto que un
   commit agrega y otro borra sigue en la rama), y lo que no commiteó. Lo sin commitear lo commitea
   con el trailer `Flowrunner-Manual: <run>`; si solo hay commits propios, `arreglo_manual` lleva su
   HEAD, sin un commit vacío. No pasa nada que toque `.git`, cambie un test bloqueado del plan (por
   su hash) o agregue un secreto (un repo git embebido cuenta como `.git`). Si `base` ya no es
   ancestro de HEAD, por un reset o un rebase, lo que salió de la rama no se puede chequear, y se
   rechaza. Si algo de eso pasa, no commitea ni escribe nada, sale con 1 y lista los problemas. Mientras el arreglo espera, `accept-untested` y
   un `rerun` con cambios sin commitear se niegan: entregarían una rama sin el cambio que se
   verificó. Las rutas protegidas (`ALWAYS_PROTECTED`) no se chequean: protegen de los agentes, no de
   la persona, y arreglar a mano el `CLAUDE.md` de VF-6 es para lo que existe `fix --yo`.
9. **`--origen terminal|claude|orca`** en `fix` y `accept`, y desde la PR 08 también en `approve` y
   `changes`, por defecto `terminal`: la skill pasa `claude` y el panel de Orca, `orca`. Queda en el
   evento.
10. **`accept-untested` queda como comando propio:** sigue escribiendo `sin_probar_aceptado`, con el
    mismo efecto que `accept` sobre una detención por criterios sin probar.

Detalle en `docs/plan-de-raiz/pr-05-detenido-con-pregunta.md`.

### Sub-tasks trabadas

Una sub-task que terminaba sin cambios se reintentaba con el motivo, y recién al segundo intento sin
avanzar fallaba. En los runs de la línea de base ningún reintento sin cambios salió bien: en PIZ-2,
ST-1 hizo tres intentos y ninguno cambió nada; en VF-1, ST-5 hizo dos, frenados por el bloqueo de
formato; en VF-6, ST-6 cerró cuatro veces «sin cambios» sobre `CLAUDE.md`, y ST-7 hizo dos intentos.
Cada intento es una sesión entera. Ahora implementar no paga el segundo a ciegas:

- **Se detiene al primer intento** una sub-task en su primera pasada que no cambió ningún archivo, y
  una devuelta (por verificar o por un `fix`) que no cambió nada y tuvo escrituras rechazadas. El
  motivo dice lo último que dijo el agente y lo que le rechazó el bloqueo. El segundo intento de #70,
  para un rechazo que pudo ser error del agente, lo reemplaza `fix --unidad`: la misma sesión, con la
  instrucción de la persona en vez del motivo genérico.
- **Una devuelta sin cambios y sin rechazos** sigue cerrando `sin_cambios` como éxito: su código ya
  está integrado, y verificar decide.
- **Los reintentos mecánicos se quedan,** hasta `MAX_UNIT_ATTEMPTS`: el diff que rompe una regla del
  doble control, el commit que choca al integrarse y el «no dejó nada para commitear». No piden
  criterio humano.
- **Las demás sub-tasks se integran igual.** Al final de la fase, cualquier sub-task fallida da una
  `pregunta`, nunca una falla de gate, con `unidades` en las fallidas, en el orden del plan, más las
  que quedaron sin arrancar porque dependen de ellas. Las fallas de entorno y el límite siguen como
  antes.
- **`resume` se niega sobre una pregunta con sub-tasks,** de implementar o de una fase con vueltas
  agotadas, y lista sus opciones: rehacía la fase entera a ciegas, también lo ya integrado. Las demás
  detenciones se retoman como antes, aunque ofrezcan `rerun`. La regla vive solo en el CLI: el
  reductor no puede ignorar un `reanudado` viejo sin cambiar cómo se lee un log ya escrito (C8).

Detalle en `docs/plan-de-raiz/pr-06-subtask-trabada-pregunta.md`.

### La infraestructura sí reintenta

Preguntar en vez de reintentar vale para lo que reintentar no arregla. Un corte de red sí se arregla
solo, y esperar es lo único que sirve: el primer VF-6 (`VF-6-20261109-210425`) murió en preparar en
25 segundos, porque `git fetch` falló tres veces con «Could not resolve host: github.com» y los
reintentos de infraestructura esperaban 5 y 20 s.

- **Qué es una falla de red** lo decide el texto del motivo, con una lista cerrada de patrones en
  `src/engine/motivos.ts` (git, Node y la API de Anthropic). No hay clase nueva en el outcome: ninguna
  fase cambia cómo propaga `clase`. Un rojo de código no entra en la lista.
- **Una falla de red** se reintenta 3 veces, a los 30 s, 2 min y 5 min: unos 7,5 minutos. Después se
  detiene con el motivo y `resume`. **El resto de la infraestructura** sigue con 2 reintentos, a los 5
  y 20 s. La falla que agota los reintentos ya no espera su backoff antes de detenerse.
- **Se congela al crear el run,** como las vueltas: `run_creado` suma `reintentos_red`. Un run creado
  antes, sin el campo, trata un corte de red como cualquier otra infraestructura. Si no, un log viejo
  detenido por tres cortes se leería en curso, sin proceso ni opciones (C8).
- **La lista deja afuera** el «unable to access» de git, que también precede a un 403 o a un error de
  TLS, y `EPIPE`, que es un pipe local. Esperar no arregla ninguno.
- **Mientras espera, el run conserva su lugar** del repo (ADR 0019): sigue en curso, con su proceso
  vivo. Los lugares y la cola no cambian (C8).
- **Una credencial rechazada no reintenta:** sigue siendo `entorno`, pero su primera opción pasa a
  `flowrunner doctor`, y las opciones quedan `doctor`, `resume` y `abort`. En VF-3 y VF-4 el «para
  seguir» decía `resume`, y retomar sin arreglar la credencial vuelve a fallar. Los dos textos de
  credencial viven en `motivos.ts`, para que el engine los reconozca sin comparar strings sueltos.
- **En implementar, el corte sube al engine.** Una sesión de sub-task cortada por la red deja su
  `unidad` `fallida` con `corte_de_red: true` y la fase devuelve `falla infra`: el engine espera y la
  reintenta como en las otras fases. Antes se reintentaba dentro de la sub-task, sin espera, y tres
  cortes seguidos gastaban sus intentos en segundos y terminaban en una pregunta sobre una sub-task que
  no estaba trabada. Las demás fallas de infraestructura de una sesión se siguen reintentando adentro,
  y un run creado antes de `reintentos_red` también.
- **El reintento sigue la misma entrada a implementar,** como en el engine: lo integrado antes del
  corte no se rehace, y un intento cortado no cuenta para `MAX_UNIT_ATTEMPTS`. Retomar una detención a
  la que se llegó con reintentos de infraestructura, como la de cuatro cortes, también la sigue. Un
  run creado antes de `reintentos_red` abre una entrada en cada acción, como antes.
- **Un intento que terminó con la acción sin cerrarse** (un corte, un límite, el entorno) no cuenta
  para `MAX_UNIT_ATTEMPTS`: cuentan los que la sub-task reintentó en la misma acción, y el que dejó
  abierto un proceso que murió.
- **Una detención le gana a un corte:** si en la misma vuelta una sub-task se corta y otra choca con
  el límite o el entorno, la fase devuelve la detención, con su hora o su motivo, y no el corte.
- **watch y Orca muestran la sub-task cortada como «cortada»**, y `flowrunner etapa`, como pendiente,
  sin contar sus cortes como intentos.

Detalle en `docs/plan-de-raiz/pr-07-reintentos-de-red.md`.

### De dónde vino cada decisión

En VF-6 hubo cuatro aprobaciones, entre 6 y 64 segundos después de que el plan quedó listo, y ninguna
salió del chat de Claude Code; `aprobado` no decía de dónde venía. El origen de cada decisión queda en
el evento y en el informe: `aprobado` y `cambios_pedidos` suman `origen`, opcional para que un log
viejo se lea igual (C8), y el informe suma «Tus decisiones», con la hora, el origen y cuánto tardó
cada una desde que el run esperó, solo con las que el engine aplicó. Un evento sin `origen` se muestra
como «desde un origen desconocido». No va a la PR. En Orca, Aprobar se habilita recién después de
abrir en el panel el plan de ese run, en su versión de ahora: un pedido de cambios vuelve a correr
planificar, y el plan nuevo se abre otra vez (D3).

Detalle en `docs/plan-de-raiz/pr-08-origen-y-boton-orca.md`.

## Alternativas descartadas

- **Un estado nuevo, `pregunta`.** Todo lo que lee el estado (Orca, la skill, `tick`, el aviso, la
  cola) ya sabe qué hacer con `detenido`. Un estado más obligaba a enseñárselo a cada uno sin ganar
  nada: lo distinto son las respuestas, y viven en el halt.
- **Las vueltas por defecto en 2.** Es el comportamiento que produjo VF-6: cada vuelta es otra sesión
  de implementar sin el criterio de nadie. Un repo que las quiera las pide (D4).
- **Que `resume` aplique las rutas protegidas al arreglo a mano.** Dejaba sin salida justo el caso que
  motivó D2.

## Consecuencias

- Toda reentrada a implementar de un repo con `vueltas: 0` viene de un `fix` de la persona. La
  métrica es esa: sesiones de implementar disparadas por una vuelta automática, por run.
- El run espera más a la persona, y le pide decidir en el primer rojo. A cambio, cada respuesta es un
  comando que el run ya validó.
- **Una desviación menor de C4:** `arreglo_manual_iniciado` suma `base`, obligatorio, que C4 no
  tenía. Sin él, `resume` solo veía lo sin commitear, y un secreto que la persona, o Claude en el
  worktree, commiteaba por su cuenta llegaba a la PR. El evento nace en esta PR, así que no hay logs
  viejos con él y C8 se cumple.

## Verificación

- `src/engine/engine.test.ts`, «detenerse y preguntar»: el primer rojo con 0 vueltas, el orden de las
  opciones, un run viejo con dos vueltas, `arreglo_pedido` (con las bloqueadas, y el que el halt no
  ofrece), el arreglo a mano, `aceptado`, `sin_probar_aceptado`, que toda detención tenga opciones y
  `siguiente` sea la primera, la secuencia de VF-6 y un log viejo.
- `src/cli/manual.test.ts`: lo que `resume` no commitea y lo que sí.
- `test/pregunta.int.test.ts`: `fix --unidad`, `fix --yo` con `resume`, `accept` y un comando que el
  run no ofrece, con el CLI real.
- `src/phases/verificar.test.ts`: con 0 vueltas no se diagnostica.
- `src/phases/implementar.test.ts`: una sub-task sin cambios, o devuelta y frenada por el bloqueo,
  pregunta al primer intento; las demás se integran, y las que dependen de ella entran en la pregunta.
- Orca: `orca/src/runs.test.ts`, `worker.test.ts` y `panel.test.tsx`.
- `src/engine/motivos.test.ts`: qué motivos son de red y cuáles no, y las dos credenciales.
- `src/engine/engine.test.ts`, «reintentos de red y credenciales», y `src/runner/runner.test.ts`: tres
  reintentos de red con sus esperas, dos para el resto, y `doctor` primero ante una credencial.
- `src/phases/implementar.test.ts`, «cortes de red en implementar»: la sub-task cortada espera sin
  gastar sus intentos, cuatro cortes detienen con `resume`, lo integrado no se rehace al reintentar ni
  al retomar, un límite le gana a un corte, un límite no gasta intentos, la entrada sigue a través de
  la cola, y un run viejo reintenta como antes.
- `test/approval.int.test.ts`: `approve` y `changes` guardan su origen, y un origen inválido sale 1;
  `src/report/report.test.ts`: «Tus decisiones», con su origen y su demora, solo con las aplicadas.
- Orca, `panel.test.tsx`: Aprobar deshabilitado hasta abrir el plan, otra vez después de un replan,
  y recordado al recargar el panel; `runs.test.ts`, la versión del plan.
