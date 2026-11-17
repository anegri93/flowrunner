# 0031 · Entregar tiene su propio carril de un lugar

Estado: Aceptada · 2026-11-17 · Amplía 0019

## Contexto

Con `max_runs` (ADR 0019), todo run que vuelve a trabajar después de una decisión de la persona toma
un lugar o espera en cola. En PIZ-14 (2026-11-12), la persona aceptó entregar con criterios sin probar
y el run esperó **12,7 minutos** en cola, detrás de tres runs que implementaban, para correr entregar,
que ese día duró entre 6 y 18 segundos.

Entregar no siempre es tan corto: la primera vez abre una sesión corta para proponer lecciones (hasta
15 minutos de tope; 0,1 minutos en los runs de PIZ) y el push reintenta si se corta la red. Por eso no
puede correr sin ningún tope.

## Decisión

1. **Entregar tiene su propio carril de `MAX_ENTREGAS` = 1 lugar**, aparte de `max_runs`. Un run cuya
   fase es entregar cuenta solo contra ese carril, y los demás solo contra `max_runs`: un run que
   entrega no le quita el lugar a uno que implementa, ni al revés. Como mucho corren `max_runs + 1`.
2. **`Reglas.cuenta`** dice qué lugares vigentes cuentan para cada tope. Un lugar del otro carril sigue
   valiendo: no se borra, y sigue diciendo qué proceso avanza el run (`isRunning`).
3. **`despacharCola` sigue mirando la cola** cuando un run no tiene lugar en su carril, en vez de
   cortar: uno del otro carril, más atrás, puede tener lugar.
4. Un run que llega a entregar en su mismo proceso, después de probar, no espera: ya tiene su lugar.

## Alternativas descartadas

- **Sin tope para entregar.** Fue la primera versión de esta PR: `/code-review` mostró que la sesión de
  lecciones y los reintentos de red pueden durar minutos, y que varias entregas a la vez no tenían
  límite.
- **Entregar sin escribir lugar.** El lugar dice qué proceso avanza el run: sin él, `resume` o `tick`
  podrían lanzar un segundo proceso.

## Verificación

- `test/entregar-sin-lugar.int.test.ts`, con `max_runs: 1` y el único lugar ocupado: aceptar un run
  detenido en probar lo entrega sin esperar, con su lugar escrito; un segundo espera, porque el carril
  es de uno; cuando el primero entrega, la cola mira detrás de un run priorizado sin lugar y lanza al
  segundo.
- `src/store/lugares.test.ts`, «cuenta separa los carriles»: cada tope cuenta los suyos, y los del otro
  siguen valiendo.
