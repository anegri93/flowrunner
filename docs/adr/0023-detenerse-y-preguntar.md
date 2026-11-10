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
9. **`--origen terminal|claude|orca`** en `fix` y `accept`, por defecto `terminal`: la skill pasa
   `claude` y el panel de Orca, `orca`. Queda en el evento.
10. **`accept-untested` queda como comando propio:** sigue escribiendo `sin_probar_aceptado`, con el
    mismo efecto que `accept` sobre una detención por criterios sin probar.

Detalle en `docs/plan-de-raiz/pr-05-detenido-con-pregunta.md`.

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
- Orca: `orca/src/runs.test.ts`, `worker.test.ts` y `panel.test.tsx`.
