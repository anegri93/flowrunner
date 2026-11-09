# 0017 · Probar no entrega sin probar, provoca fallas declaradas y graba un video que se entiende

Estado: Aceptada · 2026-11-09 · Amplía 0016

## Contexto

En KMS-1 (mango-portal-colaborador, PR #103) la fase probar devolvió 9 de 10 criterios en `no_probado`
y el run siguió a entregar: `no_probado` era un aviso. Los criterios eran justamente los de error
(qué ve RRHH cuando KMS no responde), y el agente no tenía cómo provocar esa falla: por 0016 no corre
comandos. La persona revisó la PR creyendo que estaba probada. La prueba a mano que vino después
encontró dos errores, uno de ellos anterior a la feature.

El video tampoco servía para validar: Chrome sin ventana, `slowMo` y nada más. La persona dijo que
"solo se ven los destellos y cambios de página", y que lo que quedaba más abajo de la pantalla se
tocaba fuera de cuadro.

## Decisión

- **Un criterio sin probar detiene el run.** Probar devuelve `falla` con la clase nueva `sin_probar` y
  el motivo dice qué criterios y qué faltó. El engine detiene sin reintentar (reintentar no consigue
  la falla ni el dato que faltó) y deja dos salidas: arreglar y `flowrunner rerun <run> --desde
  probar`, o `flowrunner accept-untested <run> "<por qué>"`, que sigue a entregar sin volver a probar.
  Aceptar es de la persona, como aprobar: sin motivo no se acepta, solo vale mientras el run está
  detenido por eso, y el motivo queda en el informe y en la PR. Si además hay una prueba en falla,
  gana la falla: vuelve a implementar y lo que no se pudo probar se mira en la próxima pasada.
- **Fallas declaradas por el repo.** `probar.fallas` en la config nombra cada falla con qué hace, cómo
  se simula y cómo se restaura. El agente las ve como `mcp__fallas__simular` y `mcp__fallas__restaurar`
  y elige el nombre, nunca el comando: 0016 sigue valiendo, el agente no corre nada que el repo no
  escribió. Al terminar, antes de bajar el entorno, flowrunner restaura toda falla que haya quedado
  puesta y avisa la que no pudo.
- **Video legible siempre.** Cada página carga un init script (`src/probar/guion-del-video.ts`): un
  cursor que sigue al mouse que mueve Playwright y marca cada clic, y lo que recibe foco o un clic
  queda centrado con un scroll suave. Para narrar, el agente llama con `browser_evaluate` a
  `flowrunner.placa`, `rotulo` y `veredicto`: qué se prueba y qué debería pasar, en qué paso va, y el
  resultado marcado sobre la pantalla.
- **Ventana opcional.** `probar.navegador_visible` abre Chrome con ventana. Es por repo y apagado por
  defecto: los runs corren de fondo y la ventana puede aparecer en cualquier momento.

## Evidencia

KMS-1, 2026-11-09: el run `KMS-1-20261109-162541` entregó con 9 `no_probado`. La prueba a mano con
`docker pause portal-localstack` (pausar cuelga la conexión y conserva la clave; `stop` la pierde)
encontró que una clave borrada salía como 503 en vez de "el sueldo no abre", y el error de la ficha que
arregló #105. Los videos grabados a mano con placas, cursor y scroll centrado fueron los que la persona
aceptó como evidencia.

## Verificación

- `src/engine/engine.test.ts`: `sin_probar` detiene con las dos salidas; aceptar sigue a entregar;
  retomar vuelve a probar; aceptar no hace nada fuera de esa detención.
- `src/phases/probar.test.ts`: un criterio sin probar detiene; con una falla, gana la falla; con fallas
  declaradas la sesión las recibe por nombre y el navegador sale con ventana y guion.
- `src/probar/herramientas.test.ts`: un nombre que no está no corre nada; simular y restaurar corren lo
  declarado; al bajar se restaura lo que quedó puesto; el guion es JavaScript válido.
- `src/report/report.test.ts`: el informe y la PR dicen que se entregó sin probar, con el motivo.
- `test/cli-runs.int.test.ts`: `accept-untested` sin motivo sale 1; con motivo entrega sin volver a
  probar; sobre un run que no está detenido por eso sale 1.
