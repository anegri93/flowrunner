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

`init` infiere el setup, el `verify.sh` y dónde van los tests a partir del `package.json` y de los
archivos del repo, y comprueba que la base esté en verde antes de abrir la PR. Completá
`contexto.md`, `convenciones.md` y `que-es-bien.md` en esa PR antes de mergearla.

Después, abrí una sesión de Claude Code y pedile que escriba y lance una feature: la skill
`flowrunner` hace el resto con el CLI.

## Uso personal

flowrunner se autentica con la suscripción de Claude mediante `claude setup-token`, o con la
sesión de Claude Code que ya tenés si ponés `auth: login` en `~/.flowrunner/config.yaml`. La
documentación del Agent SDK no permite ofrecer el login de claude.ai en productos de terceros:
antes de compartir flowrunner con otras personas hay que pasar a API key o confirmarlo con
Anthropic.
