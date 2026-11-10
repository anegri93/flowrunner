# 0024 · El replan conserva el código que no cambia

Estado: Aceptada · 2026-11-10

## Contexto

Cada planificar volvía la rama de la feature a la base (`resetHard(worktree, base_sha)`). En VF-6,
tres `rerun --desde planificar` reimplementaron ST-1 a ST-5 cuatro veces: implementar costó
US$ 13,01, y unos US$ 9 fueron código que el plan nuevo no cambiaba. El planificador, además, nunca
veía lo ya implementado: planificaba sobre la base, sin el código que la persona ya había visto
funcionar.

## Decisión

1. **Lo que se conserva lo decide el plan, con el código a la vista,** en dos pasadas sobre git:
   - **antes de la sesión,** la rama se rearma con **todas** las sub-tasks integradas de antes (las
     «candidatas») y el planificador ve su código;
   - **después de la sesión,** se rearma solo con las que el plan marcó `conserva: true` y pasaron
     las validaciones. Recién ahí corre el rojo de los criterios.
2. **Las candidatas salen de git, no del log:** los commits de `base..HEAD` con el trailer
   `Flowrunner-Subtask: ST-n`, que pone `commitAll` en implementar y conserva el cherry-pick. Un
   replan anterior pudo haber descartado commits que el log todavía nombra. Un commit de «lo arreglo
   yo» (`Flowrunner-Manual`), y cualquiera sin trailers de flowrunner, que `resume` acepta como
   commit propio de la persona, se reaplica siempre, al final; si choca, se descarta con un aviso que
   dice cómo recuperarlo. Solo se descarta lo que flowrunner commiteó sin ser una sub-task: los tests
   del plan, que el plan nuevo reescribe.
3. **`conserva: true` se valida en el gate** (`src/gates/conserva.ts`, puro). No se conserva una
   sub-task que no estaba implementada, que cambió de alcance, que nombran los pedidos o el motivo del
   replan, que tiene en su alcance un llamador de un `simbolo` que el plan cambia (la unión de graft y
   del grep del gate de llamadores, porque graft no ve una llamada a través de una variable sin tipo),
   que depende, en el plan nuevo o en el anterior, de una que no se conserva, o cuyos criterios no
   pasan con su código. **Si graft no puede decir quién llama a un símbolo** (un `GraftError` de
   `llamadoresDe`, como el grep cortado de un nombre muy usado, o un índice que no se pudo
   reconstruir), ninguna sub-task se conserva: no saber no es «nadie lo llama». Un `conserva` inválido
   rechaza el plan; no se ignora en silencio. Los pedidos y el motivo con que empezó el replan se
   guardan con las candidatas: el engine reemplaza la instrucción por el motivo del gate en cada
   reintento, y sin eso el segundo intento podía conservar justo lo que motivó el replan.
4. **El índice de graft se reconstruye antes de la sesión** cuando la rama trae código de antes, como
   revisar lo reconstruye antes de revisar (ADR 0015: segundos). Sin eso, el planificador y
   `llamadoresDe` verían la API de la base y no la del código conservado.
5. **Implementar marca las conservadas con el evento que ya existe:**
   `unidad { estado: "integrada", sha, motivo: "conservada del plan anterior" }`, al empezar la
   primera entrada después de aprobar. No hay estado de unidad nuevo: watch y Orca ya muestran
   «integrada». Los SHAs nuevos pasan de planificar a implementar por `conservadas.json`, no por el
   log, y una conservada cuyo commit ya no está en la rama se implementa.
6. **El orden de la rama nueva** es: la base, los commits de las conservadas en el orden en que
   aparece cada sub-task en la rama vieja, los manuales, y al final el commit de los tests del plan.
   Si un cherry-pick choca, esa sub-task y lo que depende de ella se reimplementan, con un aviso.
7. **Nada se pierde a mitad de camino:** antes de tocar la rama, la punta vieja queda apuntada por
   `refs/flowrunner/<run>/anterior` y las candidatas en `runs/<id>/candidatas.json`, con la
   preparación a la que pertenecen. Un gate rechazado, o un proceso cortado en pleno rearmado, retoma
   desde ahí, y los tests bloqueados del plan anterior se leen de la punta vieja si ya no están en el
   worktree. Otra preparación (`rerun --desde preparar`), u otra fase o un arreglo a mano en el medio,
   invalidan lo guardado: la rama de ahora es la que vale. Las dos se borran recién
   cuando el plan pasa el gate, antes de escribir los artefactos del plan nuevo.

## Consecuencias

- Un replan cuesta en implementar lo que cuesta lo nuevo o cambiado. Se ve en `stats --runs`.
- Un `changes` antes de implementar no tiene candidatas: es el comportamiento de antes.
- Un test nuevo del plan puede romper código conservado. Verificar lo ve como cualquier rojo, y
  pregunta (ADR 0023).
- Un run abortado en pleno replan deja la ref `refs/flowrunner/<run>/anterior` en el repo: mantiene
  vivos commits que ya no sirven hasta que se borra a mano.

## Tests

- `src/gates/conserva.test.ts`: cada regla de `checkConserva`, y un `GraftError` que no conserva nada.
- `src/phases/replan.test.ts`: el replan de VF-6 con dos sesiones de implementar en vez de siete, el
  código a la vista del planificador, un `conserva` inválido que no toca la rama, y un `changes`
  antes de implementar que planifica como antes.
