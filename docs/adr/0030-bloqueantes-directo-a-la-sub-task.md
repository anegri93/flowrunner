# 0030 · Un bloqueante de revisar o probar vuelve directo a su sub-task, y la revisión sabe qué pasó antes

Estado: Aceptada · 2026-11-17 · Modifica 0028

## Contexto

Con ADR 0028, un bloqueante de revisar seguía este camino: el run se detenía, flowrunner corría
Autofix solo (formateador y lint), volvía a verificar y **corría otra revisión entera sobre el mismo
código**. Recién si el bloqueante se repetía, la sub-task lo corregía. Entre PIZ-9 y PIZ-16
(pizarra-en-vivo, 2026-11-12) eso pasó 4 veces, con unos 13 minutos y USD 3,2 de revisiones que no
podían cambiar nada: el formateador no arregla un bloqueante de lógica.

Peor: la revisión no da siempre lo mismo. En PIZ-9 y PIZ-13 el bloqueante desapareció en la segunda
revisión sin que el código cambiara, y llegó a main: el `curl | bash` sin `pipefail` de
`servidor/conexion.ts` y el menú de esfuerzo que recorta `.cuerpo-entrega`.

Además, la revisión no sabía qué había pasado antes. En PIZ-15 frenó tres veces por «Prettier dejaría
esta llamada en una línea»: verify, que corre `prettier --check .`, salía en verde, y la sub-task
contestaba que no había nada que cambiar. Dos vueltas de más, unos 8 minutos y USD 2.

## Decisión

1. **Un bloqueante de revisar o un criterio en rojo de probar vuelve directo a implementar**, con el
   motivo y los arreglos propuestos (la misma instrucción que la vuelta que seguía a Autofix), sin
   detenerse. Una vez por respuesta de la persona: lo marca `directaCorrio`, aparte de
   `autofixCorrio`, así un Autofix por un rojo de verificar anterior no le quita la vuelta directa a
   la revisión, y la vuelta directa no le quita Autofix a un rojo de verificar posterior. Las respuestas
   de la persona que mandan el run a trabajar reinician los dos. Si la revisión siguiente vuelve a
   frenar, el run se detiene y pregunta.
2. **Autofix queda para verificar.** Ahí sí sirve: un rojo de formato o lint lo arreglan las
   herramientas sin gastar una sesión. En revisar y probar no se ofrece ni corre solo.
3. **Lo congela `run_creado`** con `vuelta_directa: true`. Un run creado antes sigue el camino de ADR
   0028: su log se reduce igual (C8), y un run que ya esperaba a la persona no cambia al actualizar.
4. **La revisión recibe qué comprobó verify**: si pasó o si la persona aceptó el rojo, y el script que
   corre (sin seguir links). Lo que corre el script no es hallazgo; lo que no corre, como los tipos en
   un repo sin typecheck, sí se revisa.
5. **La revisión recibe las vueltas anteriores** desde la última aprobación o el último rerun: cada
   motivo y lo que se hizo con él (la sub-task cambió su código, con el commit; no cambió nada y lo que
   dijo, en una línea; la persona lo arregló a mano; Autofix pasó las herramientas). Comprueba cada
   bloqueante anterior, y repite uno que la sub-task explicó que no hacía falta solo si leyó algo que
   muestre que la explicación está mal.
6. **`sin_cambios` guarda lo que dijo la sub-task** en `motivo`: los últimos 400 caracteres, que es
   donde suele estar el porqué, sin partir un carácter.
7. **El informe cuenta las devueltas sin nada que cambiar**, con la fase que las devolvió y lo que
   dijeron: son los bloqueantes que pudieron ser falsos.

## Alternativas descartadas

- **Verificar cada bloqueante con otra sesión antes de devolverlo**, como `/code-review`. Ese día hubo
  6 bloqueantes distintos y 1 falso: el contexto de los puntos 4 y 5 lo evita sin costo. Si el conteo
  del punto 7 muestra que siguen apareciendo, es la próxima palanca.
- **`vueltas: 1` por defecto.** Vale para las tres fases y cuenta por fase: un rojo de formato iría a
  una sub-task en vez de al formateador.
- **Hacerlo en el proceso del run, escribiendo un `arreglo_pedido` de flowrunner.** Necesita igual un
  cambio en el reductor para no repetirse sin fin, y watch y el informe lo contarían como una decisión
  de la persona.

## Consecuencias

- Un bloqueante de la revisión le cuesta a la sub-task una vuelta, no una revisión extra antes.
- Si verify sale en rojo después de la vuelta directa, Autofix corre solo como en cualquier rojo de
  verificar.
- El prompt de revisar crece con el script de verify (hasta 2000 caracteres) y los motivos anteriores.

Una revisión con `/code-review high` de la PR #109 encontró que un solo flag para Autofix y para la
vuelta directa hacía que uno le quitara el otro; de ahí `directaCorrio`.

## Verificación

- `src/engine/engine.test.ts`, «un bloqueante de revisar o probar va directo a la sub-task (ADR
  0030)»: revisar y probar van a implementar con el motivo y los arreglos; una vez por respuesta, y la
  siguiente pregunta sin ofrecer Autofix; después de la vuelta directa, un rojo de verificar corre
  Autofix solo; un Autofix anterior no le quita la vuelta directa a la revisión; verificar sigue igual;
  un run sin `vuelta_directa` sigue como antes.
- `src/phases/revisar.test.ts`, «lo que revisar sabe de antes (ADR 0030)»: las vueltas anteriores con
  lo que hizo cada sub-task, desde el último rerun, con el arreglo a mano y en una línea; el texto de
  verify y las secciones del prompt.
- `src/phases/implementar.test.ts`: `sin_cambios` guarda el final de lo que dijo la sub-task.
- `test/vuelta-directa.int.test.ts`, con el CLI real: un bloqueante de revisar vuelve a implementar
  sin detenerse ni correr Autofix, y el run entrega.
- `src/report/report.test.ts`: el informe cuenta las devueltas sin nada que cambiar.

## Enmienda · 2026-11-19 · Un bloqueante que es una decisión de la persona pregunta

En PIZ-3 la revisión devolvió el mismo bloqueante siete veces: `unpdf` 2.1.0 pide Node 24 y el repo
promete 20.6. El propio revisor escribía «con el visto bueno de la persona»: el arreglo tenía dos
salidas, subir el Node o cambiar de librería, y elegir no era de la sub-task. Se destrabó cuando la
persona aceptó subir a Node 24.

El hallazgo suma `decision: boolean`. Un bloqueante con `decision: true` no pasa por la vuelta directa:
revisar devuelve `pregunta` desde la primera vez, con las salidas que propone el revisor en el motivo
(«Elegí: … · …»), y las respuestas de siempre (arreglar por sub-task, seguir igual, replanificar). Si
hay bloqueantes de código al lado, van en la misma pregunta. Sin el campo, un review.json viejo se lee
igual y el bloqueante vuelve como antes. Verificación: `src/phases/revisar.test.ts`, «un bloqueante que
es una decisión de la persona pregunta en vez de volver».
