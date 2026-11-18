# 0037 · Explicar una detención antes de decidir

Estado: Aceptada · 2026-11-17 · Amplía 0023

## Contexto

Cuando un run se detiene (ADR 0023), el aviso, watch y el panel de Orca dicen el motivo y las
respuestas posibles, cada una con una frase. El motivo lo escribe una fase o un modelo para
flowrunner: «revisar: la revisión encontró bloqueantes: …», «verificar: 2 intentos sin pasar el
gate. Último motivo: …». La persona que no leyó lo que hicieron los agentes no sabe qué pasó ni qué
hace cada respuesta, y elige a ciegas o abre la terminal para preguntarle a Claude.

## Decisión

1. **`flowrunner explain <run>`** corre, solo sobre un run `detenido`, una sesión de solo lectura
   (Read, Grep y Glob sobre la copia de la feature; sin Bash, sin escribir) que recibe el motivo, las
   respuestas del halt numeradas con su comando, el detalle de la etapa (`report --fase`), el de las
   sub-tasks señaladas (`report --unidad`, con su diff), la feature y el plan. Devuelve, con schema:
   resumen, qué pasó, por qué frena, qué hace y qué riesgo tiene cada respuesta, cuál recomienda y por
   qué. Un run que espera aprobación no se explica: su explicación es el plan.
2. **Solo las respuestas que el run ofrece.** El modelo las nombra por número y nunca copia un
   comando. Una respuesta o una recomendación que no existe, o repetida, invalida la explicación: no
   se guarda y queda el motivo. El Markdown lo arma flowrunner y lista todas las respuestas, en orden
   y con su comando tal cual; la que el modelo no explicó queda con la frase de flowrunner.
3. **Una por detención.** La clave es la posición en el log del evento que dejó el run detenido
   (`detencionDe`): los eventos que no cambian la detención, como el uso de la explicación, no la
   mueven, y una detención nueva con el mismo motivo tiene otra. Se guarda en
   `~/.flowrunner/runs/<id>/explicaciones/detencion-<n>.md`; pedirla de nuevo la devuelve sin otra
   sesión. Mientras se escribe, un candado con el pid; si falla, `detencion-<n>.error` con el motivo,
   y pedirla otra vez lo reintenta.
4. **No toca el run.** El uso de la sesión va en un evento propio, `explicacion`, que el reductor
   ignora: no suma al costo del run ni cuenta para su tope (la pidió la persona y no avanza el run), y
   no aparece como una sesión de la etapa en watch, el recorrido ni el detalle de la etapa. Los
   rechazos y avisos de la sesión van a su `detencion-<n>.log`. `stats --runs` lo suma aparte.
5. **`--fondo`** la escribe en un proceso aparte (`_explain`), como `learn --fondo`: el panel de Orca
   corta cada comando a los 20 s. Contesta enseguida «explicando», o la explicación si ya está, y
   avisa en el escritorio al terminar.
6. **El modelo sale de `models.explicar`**, por defecto Sonnet con esfuerzo `medium`. Si la config del
   repo no carga, se usa el default: puede ser justo el motivo de la detención.
7. **En Orca**, un run detenido suma «Explicar» a sus decisiones. Corre `explain --fondo`; la tarjeta
   dice «Explicando por qué se detuvo…» mientras `watch --json` informa `explicacion.estado`
   `explicando`, y la abre sola como pestaña cuando pasa a `lista`, si la pidió ese panel. Lista, el
   botón es «Explicación» y la abre; si falló, la tarjeta dice por qué y ofrece «Explicar de nuevo».

## Alternativas descartadas

- **Explicar siempre, al detenerse.** Gasta una sesión por detención aunque la persona entienda el
  motivo, que es lo más común, y demora el aviso.
- **Texto libre del modelo, sin schema.** No hay cómo comprobar que solo hable de las respuestas que
  el run acepta, y un comando copiado mal se corre tal cual.
- **El uso como un evento `uso` de la fase.** Sumaba al tope del run, y si la persona retomaba
  mientras se escribía, la sesión aparecía dentro de la etapa nueva en el recorrido.

## Verificación

- `src/engine/engine.test.ts`: `detencionDe` es la posición del evento que detuvo el run, no cambia
  con el uso de su explicación, cambia en una detención nueva con el mismo motivo, y el uso de una
  explicación no suma al costo ni frena por presupuesto.
- `src/cli/explain.test.ts`: las respuestas van numeradas con su comando tal cual; una respuesta o
  una recomendación que no existe, o repetida, se rechaza; el Markdown trae todas, en orden.
- `test/explicar.int.test.ts`: con el CLI real y el SDK simulado, explica un run detenido una vez por
  detención sin cambiar el run; una recomendación inválida no se guarda y watch dice `fallo`;
  `--fondo` contesta enseguida y deja la explicación lista; un run que no está detenido no se explica.
- `orca/src/estado.test.ts` y `orca/src/worker.test.ts`: el botón, «explicando», que se abra sola al
  estar lista, el fallo, y que el worker corra `explain --fondo` y abra solo la que está lista.
