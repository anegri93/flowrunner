# 0018 · Probar alcanza servicios compartidos que ya están prendidos

Estado: Aceptada · 2026-11-09 · Amplía 0016

## Contexto

En rskate, el navegador necesita el Supabase local: las fotos y el tiempo real se piden desde la página
a `127.0.0.1:54321`, y el código de ingreso llega al Mailpit de `127.0.0.1:54324`. Por 0016 el
navegador solo llega a las `urls` de `probar`, y probar se detiene si una de ellas ya responde antes de
levantar. Pero ese Supabase casi siempre está prendido durante el run: los e2e de los criterios lo
necesitan en verificar. Poner sus URLs en `urls` detenía probar siempre; dejarlas afuera bloqueaba el
ingreso. Por eso rskate no tenía `probar` y COMPARTIR-1 se entregó sin video.

## Decisión

- **`probar.servicios`**, un mapa de nombre a URL como `urls`. El navegador y la herramienta de API los
  alcanzan, y el prompt los lista junto a las URLs.
- **No pasan por el chequeo de 0016.** Pueden responder antes de levantar y seguir respondiendo después
  de bajar: no corren el código de la feature, así que no pueden dar un verde falso por ser de otro
  entorno. `levantar` los deja respondiendo, y el entorno está listo cuando responden las URLs y los
  servicios; uno que no responde a tiempo hace fallar `levantar` con su URL.
- La app que corre el código de la feature sigue en `urls`, con el chequeo de siempre.

## Verificación

`src/probar/entorno.test.ts`: un servicio ya prendido no frena levantar ni cuenta como vivo al bajar,
y uno que no responde hace fallar levantar con su URL. `src/phases/probar.test.ts`: el servicio llega a
`allowedOrigins` del navegador y al prompt.
