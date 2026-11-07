# flowrunner

Runner local y desatendido que lleva una feature escrita en conversación hasta una PR lista para
revisar. El código decide las fases, los gates y los tripwires; los agentes del Claude Agent SDK
hacen el trabajo de cada fase. Cada repo tiene un cerebro en `.flowrunner/` que aprende de las
correcciones de la persona.

- Diseño: [`docs/specs/2026-11-07-flowrunner-v0-design.md`](docs/specs/2026-11-07-flowrunner-v0-design.md)
- Plan de construcción: [`docs/tareas-construccion.md`](docs/tareas-construccion.md)
- Decisiones: [`docs/adr/`](docs/adr/)

## Desarrollo

Requiere Node 24, pnpm 10, git, `gh` y `graft`.

```bash
pnpm install
pnpm lint              # eslint, prettier y tsc
pnpm test              # unitarios, sin red ni suscripción
pnpm test:integration  # git real, CLI como proceso hijo, query y gh falsos
pnpm smoke             # SDK real con la suscripción; aparte de verify
pnpm verify            # lint, test e integración: la verificación local completa
```

## Uso personal

flowrunner se autentica con la suscripción de Claude mediante `claude setup-token`. La
documentación del Agent SDK no permite ofrecer el login de claude.ai en productos de terceros:
antes de compartir flowrunner con otras personas hay que pasar a API key o confirmarlo con
Anthropic.
