# 0042 · Levantar el servicio de la feature para probarla a mano con la PR abierta

Estado: Aceptada · 2026-11-18

## Contexto

Con la PR abierta, la persona quiere probar la feature antes de mergear. La fase probar ya sabe
levantar el entorno del repo (`probar.levantar` en `.flowrunner/config.yaml`), pero lo baja al
terminar. Para usarlo a mano había que ir al worktree, copiar los `.env` y correr el comando. Después
había que acordarse de bajarlo.

## Decisión

1. **`flowrunner servicio <run> levantar|parar`**, solo con la PR abierta (run entregado, PR sin
   mergear). Levanta con la misma `levantarEntorno` de probar, desde el worktree de la feature y con
   la config de ese worktree. El panel de Orca lo ofrece con «Levantar servicio» y «Parar servicio»,
   y muestra las URLs donde responde. Sin `probar` en la config no hay botón.
2. **Un proceso aparte (`_servicio`) lo tiene arriba**, porque esperar el entorno pasa los 20 s de un
   comando del worker. Deja su estado en `runs/<id>/servicio.json` y la salida en `servicio.log`.
   Watch lo lee. Uno que dice estar arriba sin su proceso vivo se ve como falla.
3. **Mientras está arriba tiene el turno del entorno del proyecto** (ADR 0019): las URLs son fijas, así
   que verificar y probar de otro run esperan, como con un probar largo. Si otro run lo tiene, levantar
   se rechaza con quién.
4. **Se baja solo cuando el run deja de tener la PR abierta**: si se mergea, se aborta o vuelve a
   trabajar (feedback, choques con la base). El proceso lo mira cada 2 s, así que el run que vuelve a
   verificar recibe el turno enseguida. `parar` le manda SIGTERM. Al bajar corre `probar.bajar`, mata
   el grupo de procesos y borra los `.env` copiados.

## Alternativas descartadas

- **Levantarlo en una terminal de Orca.** Nadie lo baja cuando el run vuelve a trabajar, y probar
  encuentra las URLs ocupadas.
- **Que el CLI espere a que responda.** El worker corta cada comando a los 20 s.

## Verificación

- `test/servicio.int.test.ts`: levantar deja la feature respondiendo con el turno del entorno y watch
  lo muestra; levantar dos veces no lanza otro proceso; parar la baja y suelta el turno. Al abortar el
  run, el servicio se baja solo y después no se puede levantar.
- `src/store/servicio.test.ts`: un servicio sin proceso vivo se lee como falla.
- `orca/src/estado.test.ts` y `orca/src/worker.test.ts`: los botones, las URLs y el comando fijo.
