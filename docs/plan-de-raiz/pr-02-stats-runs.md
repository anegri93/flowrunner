# PR 02 · `flowrunner stats --runs`: la línea de base como comando

Rama: `feat/stats-por-run` · Depende de: nada · Tamaño: chico

## Objetivo

Sin medir, no se sabe si las PRs de este plan mejoran algo (principio 6). Hoy los números del
diagnóstico salen de scripts sueltos. Este comando los reproduce para cualquier run, y es con lo que
se decide la fase 6.

**Métrica:** sobre los runs de `~/.flowrunner/runs/`, el comando reproduce la tabla de
`docs/specs/2026-11-09-por-que-falla-y-tarda.md`.

## Decisiones tomadas (no reabrir)

- **Un flag del comando que ya existe:** `flowrunner stats --runs [proyecto] [--json]`. Sin
  `--runs`, `stats` hace lo de hoy.
- **Por run,** en el orden en que se crearon:
  - `activo_min`: la suma de lo que duró cada acción, de `accion_iniciada` a `accion_terminada`.
    Una acción sin terminar cuenta hasta el último evento.
  - `costo_usd` y `costo_por_fase`.
  - `planes`: la cantidad de `accion_iniciada` de planificar.
  - `rechazos_bash` y `rechazos_escritura`: eventos `rechazo` con herramienta Bash, o con Write,
    Edit, MultiEdit o NotebookEdit.
  - `vueltas`: los outcomes `vuelve`.
  - `fallas`: los outcomes `falla`.
  - `derecho`: `true` si no hubo ningún outcome `falla` ni `vuelve`.
  - `graft`, solo para planificar: llamadas a graft, `Read` y turnos, sumados de
    `sesiones/planificar-*.jsonl`.
- **El total de abajo:** la mediana de `activo_min` y de `costo_usd`, el porcentaje de planificar
  sobre el costo, los planes por run, los rechazos de Bash por run y los runs derechos sobre el
  total.
- **Los tokens no se suman:** el costo ya los resume.

## Cambios, archivo por archivo

### `src/report/stats.ts`

```ts
export interface RunStats {
  readonly id: string;
  readonly proyecto: string;
  readonly status: RunStatus;
  readonly activoMin: number;
  readonly costoUsd: number;
  readonly costoPorFase: Partial<Record<Phase, number>>;
  readonly planes: number;
  readonly rechazosBash: number;
  readonly rechazosEscritura: number;
  readonly vueltas: number;
  readonly fallas: number;
  readonly derecho: boolean;
  readonly graftPlanificar: { readonly llamadas: number; readonly reads: number; readonly turnos: number };
}

/** Los números de un run, de su log y de las sesiones de planificar. */
export function runStats(dir: string, events: readonly RunEvent[]): RunStats;

export function statsPorRun(home: string, project?: string): {
  ok: true;
  runs: RunStats[];
  resumen: {
    runs: number;
    medianaActivoMin: number;
    medianaCostoUsd: number;
    planificarPct: number;  // 0 a 100
    planesPorRun: number;
    rechazosBashPorRun: number;
    derechos: number;
  };
};

export function describeStatsPorRun(s: ReturnType<typeof statsPorRun>): string;
```

- **Contar desde las sesiones:** cada línea de `sesiones/planificar-*.jsonl` con `type: "assistant"`
  es un turno. Cada `content[]` con `type: "tool_use"` cuenta como `Read` si `name === "Read"`, o
  como graft si `name.startsWith("mcp__graft__")`. Una línea que no es JSON se ignora, porque es una
  sesión cortada.
- **La mediana:** el promedio de los dos del medio si son pares. Una mediana de 0 runs es 0.
- **El texto:** una tabla con columnas fijas, una fila por run, `| id | activo | US$ | planes |
  rechazos | vueltas | derecho |`, y debajo el resumen en 6 líneas.

### `src/cli/main.ts`

En `case "stats"`, si `values.runs === true`, usar `statsPorRun(home, first)` con
`describeStatsPorRun`. Hay que sumar `runs: { type: "boolean" }` a las opciones de `parseArgs`. La
ayuda pasa a decir `stats [--runs] [proyecto]`.

## Tests (escribir primero y verlos fallar)

`src/report/stats.test.ts`. Los runs se arman con `createRun` y `appendEvent`, como hacen los tests
que ya existen ahí:

1. **«stats por run suma el tiempo activo de las acciones, no las esperas»**: dos acciones de 60 s
   con una espera de aprobación de 10 min entre ellas dan `activoMin = 2`.
2. **«un run sin fallas ni vueltas es derecho; con una vuelta, no»**.
3. **«cuenta los planes, y los rechazos de Bash aparte de los de escritura»**.
4. **«de las sesiones de planificar cuenta turnos, Read y graft, y salta una línea cortada»**: con un
   `sesiones/planificar-1.jsonl` escrito a mano, con 2 turnos, 1 `Read`, 1 `mcp__graft__graft_file_api`
   y una línea final truncada.
5. **«el resumen da las medianas, con pares e impares»**.

Los cinco fallan hoy porque `statsPorRun` no existe.

## Docs a actualizar

- La tabla «Operar los runs» de `skills/flowrunner/SKILL.md`: en la fila «qué pieza mejorar», sumar
  `flowrunner stats --runs --json` para comparar runs.
- En `README.md`, una línea donde se nombra `stats`.

## Verificación

```
pnpm lint && pnpm test
node bin/flowrunner.js stats --runs
```

El segundo comando, contra tus runs reales, tiene que dar VF-6 con 95 min activos y US$ 25,71, y
VF-2 derecho.

## Fuera de alcance

- Gráficos.
- Comparar dos períodos: se hace con `--json` y a mano.

## Riesgos y cómo se detectan

- **Un formato de sesión distinto en otra versión del SDK.** Las llamadas que no se reconocen suman
  0, y el test 4 fija el formato actual.
