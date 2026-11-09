# flowrunner

Le pedís una feature a Claude Code y flowrunner la lleva sola hasta una PR lista para revisar. Vos
intervenís en dos momentos: cuando aprobás el plan y cuando revisás la PR. Todo lo demás corre sin
vos, en segundo plano, y cada repo tiene un cerebro en `.flowrunner/` que aprende de tus correcciones.

## Instalar

Una sola vez por máquina. Necesitás macOS, Node 24 o más nuevo, pnpm 10, git y Claude Code con tu
sesión abierta.

1. Instalá las herramientas que usa flowrunner y abrí sesión en GitHub:

   ```bash
   npm i -g pnpm@10 @nanonets/graft
   ```

   ```bash
   gh auth login
   ```

2. Cloná flowrunner e instalá sus dependencias:

   ```bash
   git clone https://github.com/anegri93/flowrunner.git ~/Documents/PersonalProjects/flowrunner
   ```

   ```bash
   cd ~/Documents/PersonalProjects/flowrunner && pnpm install
   ```

3. Dejá el comando `flowrunner` en tu PATH:

   ```bash
   ln -s ~/Documents/PersonalProjects/flowrunner/bin/flowrunner.js ~/.local/bin/flowrunner
   ```

## Sumar un repo

Una vez por repo. El repo tiene que estar en GitHub y su rama base en verde.

1. Mirá qué hay y qué falta. No toca nada:

   ```bash
   flowrunner init ~/ruta/al/repo
   ```

2. Aplicalo. Registra el repo, instala la skill de Claude Code, el chequeo cada 10 minutos y el comando,
   y abre una PR con el cerebro del repo en `.flowrunner/`:

   ```bash
   flowrunner init ~/ruta/al/repo --aplicar
   ```

3. En esa PR, revisá la config que infirió, con el setup, los tests, el lint y el formateador, y el borrador de `contexto.md`, `convenciones.md` y
   `que-es-bien.md`: init lo redacta leyendo el código del repo y lo deja en una sección
   «Borrador de flowrunner init», con los archivos de los que salió. Corregí lo que no sea así y
   escribí tus reglas arriba de esa sección. Después mergeala: los runs leen el cerebro desde la rama
   base.

   El borrador vive en la rama base de GitHub: si en tu carpeta no lo ves, hacé `git pull`.

   Si el repo ya tenía su cerebro de antes, init no lo toca. Para sumarle el borrador leído del código,
   en su propia PR y debajo de lo que ya escribiste:

   ```bash
   flowrunner brain draft ~/ruta/al/repo
   ```

4. Confirmá que quedó listo. Todo tiene que salir con ✓:

   ```bash
   flowrunner init ~/ruta/al/repo
   ```

## Usar

1. Abrí Claude Code en el repo y pedile la feature, como se la pedirías a una persona.
2. La skill te hace preguntas de a una, escribe la feature y la lanza. Desde ahí el run corre solo.
3. Para ver cómo va, usá la pestaña de flowrunner en Orca o, en una terminal:

   ```bash
   flowrunner watch PIZ-1
   ```

4. Cuando el plan está listo, la etapa Aprobar dice «te espera». Tocá «Plan» para leerlo y después
   «Aprobar» o «Cambios» en la tarjeta del run. También podés pedirle a Claude que te lo muestre y
   decidir ahí.
5. flowrunner implementa, verifica, revisa y abre la PR.
6. Revisá la PR, corregí lo que haga falta y mergeala. En el próximo chequeo, que corre cada 10 minutos,
   flowrunner aprende de tus correcciones y cierra el run.

## Cómo funciona

![El flujo de un run: de la feature a la PR, y de tus correcciones al cerebro del repo](docs/img/flujo.png)

Cada run pasa por puestos en orden. Los grises los hace código, sin modelo; los azules, un agente; los
naranjas, vos.

| Puesto          | Quién          | Qué hace                                                                | Qué deja               |
| --------------- | -------------- | ----------------------------------------------------------------------- | ---------------------- |
| 0 · Feature     | vos            | La escribís conversando con la skill en Claude Code                     | `feature.md`           |
| 1 · Preparar    | código         | Una copia de trabajo aparte, dependencias instaladas y la base en verde | la base comprobada     |
| 2 · Planificar  | Opus           | Lee el código, escribe los tests de aceptación y divide en sub-tasks    | `plan.md` y los tests  |
| 3 · Aprobar     | vos            | Aprobás el plan o pedís cambios con tu motivo                           | el plan aprobado       |
| 4 · Implementar | Sonnet × N     | Cada sub-task en su propia copia, en paralelo si no se pisan            | un commit por sub-task |
| 5 · Verificar   | código         | Corre los criterios y el `verify.sh` del repo                           | los criterios en verde |
| 6 · Revisar     | Opus, solo lee | Compara el cambio con las convenciones del repo                         | la revisión            |
| 7 · Entregar    | código         | Sube la rama y abre la PR, con lo que aprendió el run                   | la PR y el informe     |
| 8 · Aprender    | agente         | Después del merge, convierte tus correcciones en lecciones              | una PR de lecciones    |

Las líneas punteadas del diagrama son el trabajo que vuelve atrás: un criterio en rojo o un bloqueante de
la revisión vuelven a implementar, y tus cambios al plan vuelven a planificar. Las lecciones llegan al
cerebro del repo, y el próximo run las lee.

Los tests de aceptación quedan bloqueados: ninguna sub-task los puede tocar. Por eso, antes de
bloquearlos, flowrunner les pasa el lint del repo en modo arreglar y el formateador. Un error que el
lint no arregla solo rechaza el plan, y el planificador lo corrige antes de que lo veas.

Mientras trabajan, los agentes no pueden salirse de lo suyo: cada sub-task solo escribe dentro de su
alcance, y flowrunner lo controla en cada herramienta y otra vez sobre el diff.

## Qué pasa cuando algo falla

Una sub-task que falla se reintenta con el motivo, y verificar y revisar pueden devolver trabajo hasta 2
vueltas. Cuando reintentar no tiene sentido, flowrunner corta antes:

- **Un problema del entorno**, como una dependencia sin instalar, no se le devuelve a una sub-task:
  verificar reinstala y repite. Si sigue, se detiene y dice qué falta.
- **Una sub-task que no avanza** dos intentos seguidos se corta, con lo último que dijo.
- **Si el ciclo no converge**, un agente de solo lectura diagnostica si el problema está en el código de
  alguna sub-task, en el entorno o en el plan, y actúa según eso.

Todo tiene tope. Si el run se detiene, `flowrunner watch` y `flowrunner status` dicen el motivo y el
comando exacto para seguir.

## Cómo aprende el cerebro

`.flowrunner/` es el cerebro del repo: su contexto, sus convenciones, qué es una buena PR y las lecciones.
Aprende de dos fuentes, y en las dos decidís vos:

- **Lo que al run le costó corregirse solo.** Si hubo vueltas o pediste cambios al plan, la PR de entrega
  trae lecciones propuestas en un commit aparte. Si una no te convence, la borrás antes de mergear.
- **Tus correcciones a la PR.** Después del merge, tus commits y comentarios se vuelven lecciones que
  entran por una PR chica con auto-merge.

## Ver un run en vivo

`flowrunner watch` muestra, al estilo de [agents-tree](https://github.com/anegri93/agents-tree), cada run
con sus fases y sub-tasks: el modelo, los tokens nuevos, los USD aproximados, el tiempo y el estado. Lo
que corre muestra en gris la herramienta que está usando y cuánto contexto arrastra. Se refresca cada 2
segundos; con las flechas elegís una fila, con Enter ves sus pasos y con `q` salís. Con `--once` la
dibuja una vez.

### En Orca

Si usás [Orca](https://www.onorca.dev), el plugin de [`orca/`](orca/README.md) suma una pestaña en la
barra derecha, con el ícono del cohete. Cada run es una tarjeta con su estado, su tiempo y las ocho
etapas del flujo, cada una con su tiempo. La que trabaja gira, y debajo dice qué está haciendo. Desde
ahí decidís lo que el run espera: aprobar o pedir cambios al plan, reanudar o rehacer un run detenido.
El botón de pasos de una sesión y «Plan» abren el archivo como pestaña de Orca.

Para instalarlo, con Orca abierto:

```bash
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load ~/Documents/PersonalProjects/flowrunner/orca
```

Orca pide aprobarlo porque corre comandos en tu máquina: repetí el comando con el `--approve` que
imprime.

Los tokens nuevos son lo que cada fase leyó o escribió por primera vez, sin las relecturas de caché. El
costo de lo que corre es un mínimo, `≥ 2.97`, porque la salida se conoce al terminar. Los USD son el
equivalente de API: con la suscripción no se cobran, y lo que limita es su cupo.

## Comandos

| Comando                                 | Para qué                                      |
| --------------------------------------- | --------------------------------------------- |
| `flowrunner init <ruta> [--aplicar]`    | revisar y dejar listo un repo                 |
| `flowrunner brain draft <ruta>`         | proponer un borrador del cerebro en una PR    |
| `flowrunner watch [run] [--json]`       | ver un run, o todos los activos, en vivo      |
| `flowrunner status [run]`               | el estado de los runs, o de uno fase por fase |
| `flowrunner plan <run>`                 | el plan que espera aprobación                 |
| `flowrunner approve <run>`              | aprobar el plan                               |
| `flowrunner changes <run> "<motivo>"`   | pedir cambios al plan                         |
| `flowrunner report <run>`               | el informe del run                            |
| `flowrunner resume <run>`               | retomar un run detenido                       |
| `flowrunner rerun <run> --desde <fase>` | rehacer desde una fase                        |
| `flowrunner abort <run>`                | cancelar un run                               |
| `flowrunner learn <run>`                | aprender ya de una PR mergeada                |
| `flowrunner stats [proyecto]`           | en qué fase se va el tiempo y el costo        |
| `flowrunner doctor`                     | qué le falta a esta máquina                   |

`run` puede ser el id completo o la clave de la feature, como `PIZ-1`. Casi nunca hace falta escribirlos:
la skill de Claude Code los usa por vos.

## Autenticación

flowrunner usa tu suscripción de Claude: la sesión de Claude Code que ya tenés, con `auth: login` en
`~/.flowrunner/config.yaml`, que es lo que deja `init`, o un token de `claude setup-token` guardado en el
Keychain. La documentación del Agent SDK no permite ofrecer el login de claude.ai en productos de
terceros: antes de compartir flowrunner con otras personas hay que pasar a API key o confirmarlo con
Anthropic.

## Desarrollo

```bash
pnpm lint              # eslint, prettier y tsc
pnpm test              # unitarios, sin red ni suscripción
pnpm test:integration  # git real, CLI como proceso hijo, SDK y gh simulados
pnpm smoke             # SDK real con la suscripción
pnpm verify            # lint, unitarios e integración: la verificación local completa
```

- Diseño: [`docs/specs/2026-11-07-flowrunner-v0-design.md`](docs/specs/2026-11-07-flowrunner-v0-design.md)
- Plan de construcción: [`docs/tareas-construccion.md`](docs/tareas-construccion.md)
- Decisiones: [`docs/adr/`](docs/adr/)
