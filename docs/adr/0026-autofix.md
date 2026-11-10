# 0026 · Autofix: las herramientas del repo y, si no alcanza, las sub-tasks

Estado: Aceptada · 2026-11-10

## Contexto

En PIZ-2 (`PIZ-2-20261110-112604`), verificar se detuvo con los criterios en verde y verify en rojo
solo por formato: prettier marcaba cuatro archivos. El repo no tenía `format` ni `lint_fix` en su
config, así que flowrunner no los había pasado por lo que escribieron las sub-tasks ni por los tests
bloqueados. La persona eligió «Lo arreglo yo», pero no había arreglo posible a mano: uno de los
cuatro, `servidor/api.test.ts`, era un test bloqueado, y formatearlo le cambiaba el hash, que `resume`
rechaza (ADR 0023). Las otras salidas eran escribir una instrucción por sub-task para algo mecánico o
replanificar.

Lo que la persona pidió: un botón que no le haga escribir nada, haga lo que haga falta y reanude solo.

## Decisión

1. **`flowrunner fix <run> --auto`**, con `--origen` como los demás `fix`. Va solo: sin `--yo`, sin
   `--unidad` y sin instrucción.
2. **Se ofrece** en la detención de verificar, revisar o probar con sub-tasks, después de los
   `fix --unidad` (el `siguiente` no cambia), y durante un arreglo a mano, después de `resume`. No se
   ofrece en una pregunta de implementar (no hay nada integrado que formatear) ni ante criterios sin
   probar (lo que falta no lo arreglan las herramientas). Las filas solo suman un comando: un log
   viejo se reduce igual (C8).
3. **El CLI hace lo mecánico,** con el turno de las respuestas, antes de escribir el evento:
   - corre `lint_fix` y `format` (`runFixers`) sobre los archivos que la rama cambió desde
     `preparado.base_sha`, sin los borrados;
   - toma esas dos claves de la **config de hoy del repo** (`state.repo`), no del worktree: un repo
     que las sumó después de lanzar el run, como pizarra-en-vivo para PIZ-2, también se destraba;
   - commitea solo los archivos de esa lista que cambiaron, con el trailer `Flowrunner-Run`, como el
     commit de los tests bloqueados en verificar;
   - un test bloqueado que formatearon queda con su hash nuevo en `locked.json`, con el mismo
     argumento que verificar: las herramientas del repo no cambian lo que prueba;
   - una herramienta que sale distinto de 0 no frena: queda un `aviso` y verificar dice qué quedó.
4. **Se niega sin escribir nada** si el worktree tiene cambios sin commitear (no son de las
   herramientas y no se mezclan en su commit) o, durante un arreglo a mano, si la persona ya tocó algo
   desde `fix --yo`: lo suyo lo commitea `resume`, con sus chequeos.
5. **El evento `autofix`** (`origen`, `sha` del commit o null) vuelve a verificar, sin gastar vueltas,
   y prende `autofix` en el estado. El próximo rojo con sub-tasks de una fase con vueltas
   (`vuelve` con las vueltas agotadas) no pregunta: vuelve a implementar con esas sub-tasks y el motivo
   como instrucción, y apaga `autofix`. Es una sola vez: si sigue en rojo, pregunta como siempre. Sin
   sub-tasks a quién dárselo, pregunta. Cualquier detención y `rehacer` lo apagan.
6. **Orca:** «Autofix» reemplaza a «Lo arreglo yo», con confirmación. Arreglarlo a mano sigue en el
   CLI (`fix --yo`).
7. **El informe** lista «elegiste Autofix», con el commit si hubo. No va a «Lo que aceptaste al
   seguir»: lo que hicieron las herramientas pasa por verificar como cualquier commit.

## Alternativas descartadas

- **Que Autofix haga lo mecánico dentro de verificar,** con una marca en el estado. El commit de las
  herramientas tiene que existir antes de verificar, y hacerlo en el CLI, como `resume` con el arreglo
  a mano, deja la fase igual que antes.
- **Pasar las herramientas por todo el repo.** Formatearía archivos que la feature no tocó y la PR
  sumaría cambios que nadie pidió.
- **Ir directo al agente.** Gasta una sesión en lo que prettier hace en un segundo, y no podía tocar
  el test bloqueado de PIZ-2.
- **Que el agente reintente hasta que verificar pase.** Es lo que el ADR 0023 sacó después de VF-6.

## Consecuencias

- Un rojo de formato o de lint se destraba sin escribir nada, también en un run lanzado antes de que
  el repo configurara sus herramientas.
- Autofix puede gastar una sesión de implementar sin que la persona escriba la instrucción: la eligió
  al apretar el botón, y es una sola.
- El hash de un test bloqueado cambia por una decisión de la persona y no solo dentro de verificar.

## Verificación

- `src/engine/engine.test.ts`, «Autofix (ADR 0026)»: dónde se ofrece y dónde no, que vuelve a
  verificar sin gastar vueltas (también desde un arreglo a mano), que el siguiente rojo con sub-tasks
  vuelve a implementar una sola vez, que vale hasta el próximo rojo aunque sea de revisar, que sin
  sub-tasks, después de otra detención o de rehacer pregunta, y que un `autofix` no ofrecido no hace
  nada.
- `test/autofix.int.test.ts`, con el CLI real y git: formatea lo de la rama en un commit propio,
  actualiza el hash del test bloqueado y vuelve a verificar; se niega con cambios sin commitear o con
  otras opciones; durante un arreglo a mano sirve si no se tocó nada y manda a `resume` si sí.
- Orca: `orca/src/runs.test.ts`, `worker.test.ts` y `panel.test.tsx`.
