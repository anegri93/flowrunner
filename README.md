# flowrunner

Runner local y desatendido que lleva una feature escrita en conversación hasta una PR lista para
revisar. El código decide las fases, los gates y los tripwires; los agentes del Claude Agent SDK
hacen el trabajo de cada fase. Cada repo tiene un cerebro en `.flowrunner/` que aprende de las
correcciones de la persona.

- Diseño: [`docs/specs/2026-11-07-flowrunner-v0-design.md`](docs/specs/2026-11-07-flowrunner-v0-design.md)
- Plan de construcción: [`docs/tareas-construccion.md`](docs/tareas-construccion.md)
- Decisiones: [`docs/adr/`](docs/adr/)

## Desarrollo

Requiere Node 24 o más nuevo, pnpm 10, git, `gh` y `graft`.

```bash
pnpm install
pnpm lint              # eslint, prettier y tsc
pnpm test              # unitarios, sin red ni suscripción
pnpm test:integration  # git real, CLI como proceso hijo, query y gh falsos
pnpm smoke             # SDK real con la suscripción; aparte de verify
pnpm verify            # lint, test e integración: la verificación local completa
```

## Puesta en marcha

```bash
pnpm install
ln -s "$PWD/bin/flowrunner.js" ~/.local/bin/flowrunner   # o cualquier carpeta de tu PATH
flowrunner init <ruta-del-repo>             # revisa, infiere y dice qué falta; no toca nada
flowrunner init <ruta-del-repo> --aplicar   # config, skill, launchd y la PR con el cerebro
```

`init` también instala la skill de Claude Code y un hook de inicio de sesión: en un repo registrado, la
sesión arranca sabiendo que las features nuevas van por flowrunner.

`init` infiere el setup, el `verify.sh` y dónde van los tests a partir del `package.json` y de los
archivos del repo, y comprueba que la base esté en verde antes de abrir la PR. Completá
`contexto.md`, `convenciones.md` y `que-es-bien.md` en esa PR antes de mergearla.

Después, abrí una sesión de Claude Code y pedile que escriba y lance una feature: la skill
`flowrunner` hace el resto con el CLI.

## Qué pasa cuando algo falla

flowrunner reintenta, pero no a ciegas. Una sub-task que falla se reintenta hasta 3 veces con el
motivo, y verificar y revisar pueden devolver trabajo hasta 2 vueltas. Cuando reintentar no tiene
sentido, se corta antes:

- **Una señal de entorno** en la salida de un criterio, como `Cannot find package` o `command not
found`, no se le devuelve a una sub-task: verificar reinstala y repite. Si sigue, se detiene y dice
  qué falta.
- **Una sub-task devuelta que no encuentra nada que cambiar** no gasta reintentos: su código queda
  integrado y verificar decide de qué lado está el problema.
- **Si el ciclo no converge**, porque pasó lo anterior o el mismo criterio falló dos vueltas
  seguidas, una sesión de solo lectura diagnostica la causa: el código de alguna sub-task, que puede
  no ser la que se culpó; el entorno; o el plan. Con código, devuelve el trabajo a la sub-task
  correcta con una instrucción precisa; con entorno o plan, se detiene y dice cómo seguir.

Todo tiene tope: al agotarse, el run se detiene con el motivo y el comando exacto para continuar.

## Cómo aprende el cerebro

El cerebro aprende de dos fuentes, y en las dos decide la persona:

- **Lo que le costó al run corregirse solo.** Las vueltas de verificar y revisar y los cambios que
  pediste al plan se vuelven lecciones propuestas, en un commit aparte de la misma PR de entrega,
  explicadas en su descripción. Si una no te convence, la borrás de `.flowrunner/lecciones.md` antes
  de mergear; si mergeás, quedan. Un run sin vueltas no gasta en esto y la PR lo dice.
- **Tus correcciones a la PR.** Después del merge, tus commits y comentarios se vuelven lecciones que
  llegan por una PR chica con auto-merge. Un commit tuyo que solo toca `.flowrunner/`, como borrar una
  lección propuesta, no cuenta como corrección del código.

## Ver un run en vivo

```bash
flowrunner watch PIZ-1        # un run por su clave o su id; sin nada, todos los activos
```

Una vista al estilo de [agents-tree](https://github.com/anegri93/agents-tree): arriba, cuántos runs te
esperan, trabajan o terminaron; abajo, por proyecto y con lo urgente primero, cada run con sus fases y
sub-tasks como árbol. Cada fila muestra el modelo con su esfuerzo, los tokens con una barra de qué parte
del run se llevó, los USD aproximados, el tiempo y el estado; debajo, en gris, la herramienta que está
usando o por qué volvió algo. Se refresca cada 2 segundos. Con las flechas elegís una fila y con Enter
ves los pasos de sus sesiones; `q` sale. Con `--once`, o fuera de una terminal, la dibuja una vez.

Los USD son el equivalente de API. Con la suscripción no se cobran: lo que limita es su cupo. Un run no
tiene tope de gasto salvo que el repo lo pida con `budget.run_usd` en `.flowrunner/config.yaml`.

## Uso personal

flowrunner se autentica con la suscripción de Claude mediante `claude setup-token`, o con la
sesión de Claude Code que ya tenés si ponés `auth: login` en `~/.flowrunner/config.yaml`. La
documentación del Agent SDK no permite ofrecer el login de claude.ai en productos de terceros:
antes de compartir flowrunner con otras personas hay que pasar a API key o confirmarlo con
Anthropic.
