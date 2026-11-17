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
   detenerse. Una vez por respuesta de la persona: lo marca `autofixCorrio`, que ahora significa
   «flowrunner ya respondió solo». Si la revisión siguiente vuelve a frenar, el run se detiene y
   pregunta.
2. **Autofix queda para verificar.** Ahí sí sirve: un rojo de formato o lint lo arreglan las
   herramientas sin gastar una sesión. En revisar y probar no se ofrece ni corre solo.
3. **Lo congela `run_creado`** con `vuelta_directa: true`. Un run creado antes sigue el camino de ADR
   0028: su log se reduce igual (C8), y un run que ya esperaba a la persona no cambia al actualizar.
4. **La revisión recibe qué comprobó verify**: si pasó o si la persona aceptó el rojo, y el script que
   corre (sin seguir links). Formato, lint y tipos no son hallazgos: los decide verify.
5. **La revisión recibe las vueltas anteriores** desde la última aprobación: cada motivo y lo que hizo
   cada sub-task (cambió su código, con el commit, o no cambió nada y lo que dijo). Comprueba cada
   bloqueante anterior, y repite uno que la sub-task explicó que no hacía falta solo si leyó algo que
   muestre que la explicación está mal.
6. **`sin_cambios` guarda lo que dijo la sub-task** en `motivo`, hasta 400 caracteres.
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
- Si verify sale en rojo después de la vuelta directa, la detención pregunta sin correr Autofix solo:
  flowrunner ya respondió una vez. Las sub-tasks ya pasan el formateador por lo que cambian antes de
  commitear.
- El prompt de revisar crece con el script de verify (hasta 2000 caracteres) y los motivos anteriores.

## Verificación

- `src/engine/engine.test.ts`, «un bloqueante de revisar o probar va directo a la sub-task (ADR
  0030)»: revisar y probar van a implementar con el motivo y los arreglos; una vez por respuesta, y la
  siguiente pregunta sin ofrecer Autofix; verificar sigue igual; un run sin `vuelta_directa` sigue
  como antes.
- `src/phases/revisar.test.ts`, «lo que revisar sabe de antes (ADR 0030)»: las vueltas anteriores con
  lo que hizo cada sub-task, el texto de verify y las secciones del prompt.
- `src/phases/implementar.test.ts`: `sin_cambios` guarda lo que dijo la sub-task.
- `src/report/report.test.ts`: el informe cuenta las devueltas sin nada que cambiar.
