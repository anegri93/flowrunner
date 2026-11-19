# 0043 · La conversación decide, el plan ejecuta

Estado: Aceptada · 2026-11-19 · Modifica el paso 6 del prompt de planificar

## Contexto

En los 33 runs de pizarra-en-vivo (PIZ-2 a PIZ-53), la persona aprobó 33 de 33 planes sin pedir cambios,
con una mediana de 27 segundos desde que el plan la esperó. Lo que lee y decide es la conversación con la
skill que escribe la feature, no el plan. Pero esa conversación era corta: en PIZ-17 a PIZ-21 hubo una
aclaración por feature, y la revisión encontró después casos borde que nadie había preguntado, como una
paleta agrupada dentro de una zona (PIZ-19) o una imagen recortada sobre un prototipo (PIZ-18). Esos no
eran errores de código: eran decisiones de producto que el planificador tomó solo, porque el prompt le
decía «las dudas que no son de la persona se deciden y se anotan; no se pregunta», y ninguna regla
separaba lo técnico de lo que cambia lo que la persona ve o usa.

## Decisión

1. **La skill recorre cinco temas** en el ping pong (funcionalidad, error, borde, existente y propuesta), y
   cada aclaración lleva su tema (`- P (borde): … R: …`). `feature check` avisa, sin frenar, si no hay
   ninguna de errores o de casos borde (T1.1, T1.2).
2. **El planificador no decide producto.** Una decisión que cambia lo que la persona ve o usa y que las
   Aclaraciones no cubren va en `preguntas` de su salida, cada una con su tema, la pregunta y su propuesta,
   sin plan. Las dudas técnicas se siguen decidiendo y anotando en `decisiones`.
3. **Con alguna pregunta, planificar devuelve `pregunta`** (ADR 0023): el run se detiene antes de aprobar con
   cada pregunta y su propuesta en el motivo, y el plan que venga en la misma salida no se usa, porque
   decidiría lo que la persona todavía no decidió.
4. **La sesión queda para retomarla.** Se marca como la de un plan rechazado por el gate (ADR 0025), y las
   preguntas quedan en `planificar-preguntas.json` del run, para que la respuesta de la persona vuelva a la
   misma conversación y se sume a la feature del run como aclaración (T1.4).

## Alternativas descartadas

- **Que el planificador decida y lo anote en `decisiones` como hasta ahora.** Es lo que llevó a PIZ-17 a
  PIZ-19: la persona no lee el plan, así que la decisión no la ve nadie hasta la revisión o la PR.
- **Que el planificador devuelva el plan con preguntas al costado, y aprobar las muestre.** La persona no
  lee el plan, y un plan armado sobre una decisión que después cambia hay que rehacerlo.
- **Que preguntar sea un evento propio con su estado.** `pregunta` y `halt()` ya cubren una fase que sabe
  que reintentar sola no sirve; un estado nuevo duplica lo que el engine ya hace.

## Verificación

- `src/feature/feature.test.ts` y `src/cli/feature-check.test.ts`: el tema de una aclaración, un tema que
  no existe, y el aviso de lo que faltó preguntar.
- `src/phases/planificar.test.ts`, «el planificador pregunta lo que la feature no cubre»: una salida con
  preguntas detiene sin escribir el plan y deja la sesión marcada; con preguntas, el plan de la misma
  salida no se usa; con preguntas vacías, el plan sigue como siempre.
