# Explicar un bloqueante antes de decidir

Estado: implementado sin revisión de la persona: lo pidió con «implementa todo» · 2026-11-17 ·
ADR 0037

## Problema

Pedido de la persona: «cuando estoy en un stage y tiene un bloqueante que requiere mi feedback,
necesito alguna manera que, desde el plugin, pueda explicarme mejor cuál es el problema, y las
sugerencias de solución, para que yo pueda comprender qué pasa antes de tomar una decisión».

Hoy un run detenido muestra su motivo y sus respuestas, cada una con una frase. El motivo está escrito
para flowrunner, no para alguien que no vio lo que hicieron los agentes.

## Decisión

Un comando, `flowrunner explain <run>`, que pide una explicación a una sesión de solo lectura, y un
botón «Explicar» en el panel de Orca que la abre como pestaña. El detalle de las reglas está en el
ADR 0037. Lo que decidí sin preguntar, y por qué:

- **Solo runs detenidos.** Son los que esperan una respuesta con opciones. Un plan que espera
  aprobación ya se lee con su pestaña, y explicarlo sería otro plan.
- **A pedido, no al detenerse.** La mayoría de los motivos se entienden: no vale una sesión por
  detención.
- **Con schema y respuestas por número.** El panel tiene que mostrar solo lo que el run acepta, con el
  comando exacto: el modelo no copia comandos, y una respuesta que no existe invalida la explicación.
- **Una por detención, guardada en la carpeta del run.** Volver a abrirla no gasta otra sesión. La
  clave es la posición del evento que detuvo el run en el log, que no se mueve con eventos que no la
  cambian.
- **Sin tocar el estado ni el costo del run.** Un evento propio, `explicacion`, que el reductor ignora;
  `stats --runs` la cuenta aparte. Pedir ayuda no puede frenar un run por su tope.
- **Sonnet con esfuerzo medio, en `models.explicar`.** Es leer y redactar, no planificar.
- **Sin Bash.** Explicar no necesita correr nada, y así no hay política de comandos que mantener.
- **En Orca, en segundo plano.** El panel corta cada comando a los 20 s: `explain --fondo` contesta
  enseguida y el panel la abre sola cuando `watch --json` la ve lista.

## Cómo se ve

En la tarjeta de un run detenido, junto a sus respuestas:

- «Explicar»: la pide. Mientras se escribe, «Explicando por qué se detuvo…» en lugar del botón.
- Lista, se abre sola como pestaña de Orca, y el botón pasa a «Explicación».
- Si falló, «No se pudo explicar: <motivo>» y «Explicar de nuevo».

La pestaña tiene: el resumen; qué pasó; por qué frena; cada respuesta con su comando, qué hace, sus
riesgos y cuál recomienda; la recomendación con su porqué; y el motivo tal cual.

## Fuera de alcance

- Explicar un plan que espera aprobación, o un run que no está detenido.
- Elegir la respuesta desde la explicación: se elige con los botones de siempre.
- Recordar entre recargas del panel cuáles se pidieron: la que se terminó de escribir con el panel
  cerrado se abre con «Explicación».
