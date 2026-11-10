# 0022 · El contexto de graft llega calculado a cada sub-task

Estado: Aceptada · 2026-11-10

## Contexto

Las sub-tasks no tenían graft (`graft: false` en `src/phases/implementar.ts`). Para orientarse
corrían `ls`, `cat`, `git log` y `git status` por Bash: buena parte de los unos 100 comandos de
lectura que rechazó el bloqueo en 9 runs eran eso. Donde graft sí estaba, como herramienta del
planificador, se sumó a las lecturas en vez de reemplazarlas: en VF-1, entre 26 y 37 llamadas a graft
**y** entre 59 y 73 `Read` por plan. En revisar, donde llega calculado (`blastRadius`), se usa sin
gastar turnos.

## Decisión

El módulo `src/graft/contexto.ts` arma, antes de la sesión, la API de unos archivos y quién usa lo
que exportan (contrato C6 del plan de raíz). Implementar se lo pone a cada sub-task en el prompt.

1. **Las firmas son las de C6:** `contextoGraft(opts)` nunca tira, y si graft falla lo dice en el
   texto; `llamadoresDe(repo, indexDir, simbolo, env)` tira `GraftError` si no pudo comprobar, porque
   el replan (PR 09) tiene que saberlo.
2. **Siempre `--json` y `--no-refresh`.** En modo texto, graft imprime en stdout una línea dirigida al
   agente (`[graft] tokens saved ≈ … tell the user …`) que no puede llegar a un prompt. Con `--json`
   la salida es JSON puro y el ahorro, en `saved`, se ignora. `--no-refresh` evita que cada consulta
   revise el índice: lo reconstruye quien llama.
3. **Los comandos:** `graft --dir <índice> skeleton … --json --no-refresh -- <archivo> <repo>` para la
   API, y `callers … -- <símbolo> <repo>`, con profundidad 1, para los llamadores. Con
   `DO_NOT_TRACK=1`, `execFile` y 16 MB de `maxBuffer`, como `blastRadius`.
4. **Llamadores solo de `function` y `class`.** Los métodos salen como `constructor` o con nombre
   ambiguo. De cada respuesta se usan los `matches` del mismo archivo, y se listan solo los llamadores
   de otros archivos.
5. **Topes:** 30 archivos (una carpeta se expande a sus archivos versionados con `git ls-files`), 40
   consultas de llamadores, 4 a la vez, 60 s en total. Lo que no entra se omite y se dice. El texto
   se corta en `maxChars` (12.000) en el último archivo entero, y lo dice.
6. **El formato es fijo:** `marcarFueraDeAlcance` lo lee línea por línea para marcar los llamadores
   que la sub-task no puede tocar.
7. **Implementar reconstruye el índice al entrar,** porque la rama ya tiene los tests del plan y lo
   integrado, que el índice de preparar no tiene. Si falla, queda un aviso y nada se detiene.
8. **Las sub-tasks siguen sin graft como herramienta.** El contexto llega en el prompt.
9. **Las sub-tasks ya integradas** salen del log en el momento de arrancar cada una: lo integrado
   después de la última aprobación, lo último de cada una, sin la propia.

Detalle en `docs/plan-de-raiz/pr-04-contexto-graft-subtasks.md`.

### Lo que la spec no nombraba

Medido con graft 0.29, que es el instalado; la spec se escribió con 0.18 y el JSON es el mismo.

- **Sin índice, `skeleton` no sale con error:** devuelve `entries: []` con la nota
  `no wiring graph — run graft build first`. Esa nota cuenta como falla; sin eso, un índice que falta
  se leía como «sin definiciones».
- **`skeleton` resuelve un nombre suelto a cualquier archivo con ese nombre.** Si el archivo que
  devuelve no es el pedido, la sección dice que todavía no existe, en vez de mostrar la API de otro.
- **Una carpeta con un solo archivo también es carpeta,** y una que todavía no tiene nada versionado
  tiene su sección, que dice que todavía no existe.
- **Las rutas van a `git ls-files` literales** (`--literal-pathspecs`): `[id]` de Next es una ruta, no
  un patrón.
- **Después de una falla, las consultas en curso se cortan** (un `AbortController`): `contextoGraft`
  devuelve enseguida y no deja graft corriendo hasta el plazo.
- **Del error de graft se toma una línea de stderr, nunca de stdout,** sin las que le hablan al agente:
  `[graft]` (el ahorro) y `⬆` (versión nueva, «run `graft upgrade`», que sale aunque esté
  `DO_NOT_TRACK`). También las de progreso, que empiezan con `·`.
- **La orientación se arma antes de copiar los `env_files`** al worktree de la sub-task: tarda hasta
  60 s, y si tira no hay `finally` que los borre.
- **El tope de `maxChars` es del texto de `contextoGraft`,** sin las notas finales. Implementar le suma
  después « · fuera de tu alcance» a cada llamador marcado, así que lo que llega al prompt puede pasar
  el tope: en `src/store/` de flowrunner, 11.787 caracteres sin marcar y 15.175 marcados.
- **Un corte por el tope de 30 archivos dice «por tamaño»,** con el texto exacto de la spec.

## Pendiente

- **Un nombre repetido pierde sus llamadores de otros archivos.** graft 0.29 no los lista: si
  `src/a/uno.ts` y `src/c/otro.ts` definen `uno`, el llamador de `src/b/dos.ts` no aparece, y lo dice
  solo en el `note` del match. La spec da la unión por conservadora («Si el nombre es ambiguo, es la
  unión»), y no lo es. Hoy `llamadoresDe` devuelve esa unión, que puede quedar vacía, y
  `contextoGraft` muestra la entrada sin llamadores. Hay que decidirlo antes de la PR 09, que usa
  `llamadoresDe` para conservar código.

## Consecuencias

- El contexto de las sub-tasks viene de graft. El ADR 0015 decía «las sub-tasks no usan graft», y
  sigue siendo cierto como herramienta.
- Cada sub-task espera, antes de su sesión, lo que tarden sus consultas: menos de un segundo en un
  alcance chico, 60 s en el peor caso. Se ve en el tiempo de implementar de `stats --runs`.
- Las PRs 09 y 12 reusan el módulo: `llamadoresDe` para decidir qué se conserva en un replan, y
  `contextoGraft` para el planificador.

## Verificación

`src/graft/contexto.test.ts` prueba el formato, el corte y los topes con un graft de mentira, y que la
línea dirigida al agente no llega al texto. `test/graft-contexto.int.test.ts` lo prueba con el graft
real. `src/phases/implementar.test.ts` comprueba que el prompt de cada sub-task trae lo integrado, la
API de su alcance y los llamadores de afuera marcados.
