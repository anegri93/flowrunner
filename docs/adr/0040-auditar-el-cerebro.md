# 0040 · Auditar el cerebro y decidir con evidencia, sin aplicar nada solo

Estado: Aceptada · 2026-11-17

## Contexto

El cerebro de cada repo (`.flowrunner/`) crece con cada run: lecciones propuestas, lecciones de las
correcciones de la persona, el borrador de init. Nadie lo revisaba entero. Una lección puede quedar
vieja (nombra un archivo que ya no está), repetirse, contradecir a otra o no alcanzar (`No
alcanzó:`). Y los runs se detienen a preguntar por cosas que la historia ya contesta: si la persona
eligió casi siempre el primer arreglo propuesto, flowrunner podría haberlo hecho solo con
`vueltas`. El objetivo de la persona es que flowrunner sea cada vez más autónomo.

## Decisión

1. **`flowrunner brain audit <ruta>`** corre una sesión de solo lectura (Read, Grep y Glob; el modelo
   de revisar) sobre un worktree limpio de la base. Lee el cerebro entero, comprueba contra el código
   lo que nombra y recibe la historia de los runs del proyecto, que arma el código desde sus logs:
   cada detención con su motivo, qué respondió la persona y los motivos que más se repiten.
2. **Devuelve hallazgos y decisiones validados con zod.** Cada decisión trae su evidencia
   (`por_que`), qué detención reduce (`reduce`) y **ediciones exactas**: un `buscar` que aparece una
   sola vez en el archivo y su `reemplazar`.
3. **Solo el cerebro y su config.** Las ediciones pueden tocar `.flowrunner/*.md`,
   `.flowrunner/propuestas/*.md` y `.flowrunner/config.yaml`; ni `verify.sh`, que corre en cada run,
   ni `ejemplos/`, ni código del repo. El código revisa cada decisión contra el cerebro auditado y
   marca la que no se puede aplicar, con su motivo. Un archivo, o una carpeta de su camino, que es un
   link no se edita: el camino real tiene que quedar dentro del worktree. `config.yaml` sí entra,
   aunque tiene comandos que corren en la máquina (`setup`, `probar.levantar`, `fallas.*.simular`):
   las opciones que bajan detenciones viven ahí, y nada llega a la base sin la PR que revisa la
   persona. Quien revisa esa PR tiene que mirar esos comandos como miraría un `verify.sh`.
4. **La auditoría se guarda** en `~/.flowrunner/auditorias/<proyecto>/<id>.json`, con el sha256 de
   cada archivo que tocan sus decisiones, y su informe en `<id>.md`.
5. **Aplicar es de la persona.** `flowrunner brain apply <proyecto>/<id> --decision Dn …` aplica solo
   las elegidas sobre el cerebro de hoy de la base y abre una PR en
   `chore/flowrunner-auditoria-<id>-<decisiones>`. Una decisión cuyo archivo cambió desde la
   auditoría, o que choca con otra elegida, no entra y la PR lo dice. Si no entra ninguna, o el
   cerebro resultante no carga, no se abre nada. La skill lo pregunta antes (`ask`).
6. **En el panel**, la vista Doctor suma la sección Cerebro del proyecto enfocado en Orca: auditar,
   que pide confirmación y corre de fondo (`brain audit --fondo`, la tarea `auditar-<proyecto>`); la
   última auditoría con sus hallazgos; las decisiones para elegir con un toque; y abrir la PR con las
   elegidas o el informe como pestaña.

## Alternativas descartadas

- **Aplicar las decisiones solas, o las de mayor impacto.** El cerebro lo leen todos los runs: un
  cambio malo se repite en cada uno. La PR chica se revisa como cualquier otra.
- **Que la sesión reescriba los archivos enteros.** No se puede comprobar contra el archivo de hoy, y
  pisaría lo que la persona escribió después de auditar.
- **Que la sesión lea los logs de los runs.** Contar detenciones y respuestas no necesita modelo; así
  no gasta turnos leyendo JSON.
- **Proponer cambios al código del repo.** Eso es una feature: va como hallazgo, sin decisión.

## Verificación

- `src/setup/auditar.test.ts`: qué archivos se pueden editar, cada `buscar` una sola vez y sin
  patrones en el reemplazo, la revisión de cada decisión y la historia con lo que respondió la
  persona.
- `test/auditar.int.test.ts`: la auditoría guardada con sus decisiones revisadas, `--ultima`,
  `--fondo`, y aplicar solo las elegidas que no cambiaron, solo en `.flowrunner/`, sin repetir una
  ya aplicada.
- `orca/src/worker.test.ts` y `orca/src/doctor.test.ts`: la ruta del proyecto enfocado, los comandos
  fijos, elegir y abrir la PR con las elegidas, y la confirmación antes de auditar.
