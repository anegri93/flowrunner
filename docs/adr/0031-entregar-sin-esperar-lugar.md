# 0031 · Un run al que solo le falta entregar no espera un lugar

Estado: Aceptada · 2026-11-17 · Amplía 0019

## Contexto

Con `max_runs` (ADR 0019), todo run que vuelve a trabajar después de una decisión de la persona toma
un lugar o espera en cola. En PIZ-14 (2026-11-12), la persona aceptó entregar con criterios sin probar
y el run esperó **12,7 minutos** en cola, detrás de tres runs que implementaban, para correr entregar:
un push y una PR, 6 segundos.

## Decisión

1. **Un run en curso o en cola cuya fase es entregar no tiene tope:** `reglas` le da `max` infinito. El
   lugar se escribe igual, con el pid del proceso, para que nadie lo lance dos veces, y se suelta al
   terminar, como siempre.
2. **`despacharCola` sigue mirando la cola** cuando el primero no tiene lugar, en vez de cortar: un run
   que solo tiene que entregar, más atrás, sale igual. Hoy ya no entra a la cola; queda por los runs que
   se encolaron antes de este cambio.
3. **Mientras entrega, cuenta como ocupado.** Por unos segundos puede haber `max_runs + 1` lugares; un
   run de la cola espera a que entregar termine, que lo despacha al soltar su lugar.

## Alternativas descartadas

- **Entregar sin escribir lugar.** El lugar también dice qué proceso avanza el run (`isRunning`): sin él,
  `resume` o `tick` podrían lanzar un segundo proceso.
- **Aprender sin lugar también.** Ya corre por `tick`, sobre runs entregados, sin tomar lugar.

## Verificación

- `test/entregar-sin-lugar.int.test.ts`, con `max_runs: 1` y el único lugar ocupado: aceptar un run
  detenido en probar lo entrega sin esperar, y el otro sigue trabajando.
- No hay test del punto 2: con este cambio un run que solo tiene que entregar ya no entra a la cola.
