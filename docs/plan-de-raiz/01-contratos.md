# 01 · Decisiones y contratos compartidos

Todo lo que una PR usa de otra está acá. **Ninguna PR cambia un contrato de este archivo.** Si la
implementación muestra que un contrato no se puede cumplir, se detiene y se pregunta (ver
`00-guia.md`).

## Decisiones de producto, tomadas el 2026-11-09

| # | Decisión |
|---|---|
| D1 | Un run trabado **no reintenta solo: se detiene y pregunta**. La pregunta vive en el estado `detenido`, que ya existe. No hay estado nuevo |
| D2 | Entre las opciones está **«lo arreglo yo»**: `fix --yo` da el worktree, la persona edita, y `resume` commitea y vuelve a verificar |
| D3 | El botón Aprobar del panel de Orca **se habilita recién después de abrir el plan** de ese run en Orca. Cada aprobación guarda su origen |
| D4 | **Vueltas automáticas por defecto: 0.** Cada repo las puede subir con `vueltas` en su config, de 0 a 3 |
| D5 | Diagnosticar y reparar corren solos **solo si el repo configuró `vueltas` > 0**. Con 0 no corren. `flowrunner explain` queda fuera de esta tanda |
| D6 | El modelo de planificar no cambia por código: ya se configura en `models.planificar`. El experimento de Sonnet (fase 4.5 del plan) es de uso, no de implementación |

## C1 · Un `detenido` con pregunta

`Halt` en `src/engine/engine.ts` suma dos campos. `siguiente` se queda, como el primer comando de
`opciones`, para no romper lo que ya lo lee:

```ts
export interface Opcion {
  /** El comando tal cual, con <placeholders> para lo que escribe la persona. */
  readonly comando: string;
  /** Qué hace, en una frase, para el aviso, Orca y la skill. */
  readonly que: string;
}

export interface Halt {
  readonly motivo: string;
  readonly siguiente: string;
  /** Las respuestas posibles, en orden de preferencia. Nunca vacía. */
  readonly opciones: readonly Opcion[];
  /** Las sub-tasks a las que se atribuye el problema, si hay. */
  readonly unidades?: readonly string[];
}
```

- **Quién arma las opciones:** solo el engine, con una función pura,
  `opcionesDe(state: RunState, fase: Phase, unidades: readonly string[] | undefined): Opcion[]`,
  exportada de `engine.ts`. Ninguna fase arma comandos.

| Situación | Opciones, en este orden |
|---|---|
| Verificar, revisar o probar en rojo, con vueltas agotadas | por cada unidad, `flowrunner fix <run> --unidad ST-n "<qué cambiar>"`; después `flowrunner fix <run> --yo`, `flowrunner accept <run> "<por qué>"`, `flowrunner rerun <run> --desde planificar`, `flowrunner abort <run>` |
| Implementar: una sub-task trabada (outcome `pregunta`) | `fix --unidad` por cada una, `fix --yo`, `rerun --desde planificar` y `abort`. **Sin `accept`**: no se entrega una sub-task sin hacer |
| Probar, con criterios sin probar (lo que hoy es `sinProbar`) | `flowrunner rerun <run> --desde probar`, `accept`, `fix --yo` y `abort` |
| Cualquier otra detención: entorno, invariante, infra agotada, presupuesto | `flowrunner resume <run>` (o el `siguiente` que ya armaba `halt`) y `abort` |
| Credencial rechazada (PR 07) | `flowrunner doctor`, `flowrunner resume <run>` y `abort` |

- **`opciones` nunca está vacía**, y `siguiente === opciones[0].comando`.
- **Los runs viejos** no tienen `opciones` en ningún evento, porque se calculan al reducir: el
  reductor nuevo las calcula igual para el log viejo.

## C2 · El outcome `pregunta`

En `outcomeSchema` (`src/store/events.ts`):

```ts
z.strictObject({
  tipo: z.literal("pregunta"),
  motivo: z.string().min(1),
  unidades: z.array(z.string().min(1)).min(1).optional(),
}),
```

- **El engine:** `detenido` con `halt = { motivo, siguiente, opciones: opcionesDe(...), unidades }`.
  No suma intentos ni vueltas.
- **Quién lo devuelve:** implementar, para una sub-task trabada (PR 06), y cualquier fase que sepa
  que reintentar solo no sirve.

## C3 · Vueltas configurables

- **Config del repo** (`src/config/schemas.ts`): `vueltas: z.int().min(0).max(3).default(0)`.
- **Se congela al crear el run:** `run_creado` suma `vueltas: z.int().min(0).max(3).optional()`. Un
  run viejo sin el campo se lee como 2, que es el comportamiento de antes: los runs en curso no
  cambian a mitad de camino.
- **`RunState`** suma `vueltasMax: number`. `MAX_ROUNDS` deja de exportarse; si algo lo importa, se
  cambia a `state.vueltasMax`.
- **En `onOutcome` para `vuelve`:** si la vuelta nueva de esa fase supera `vueltasMax`, el run queda
  `detenido` con la pregunta de C1. Con `vueltasMax = 0`, el primer `vuelve` ya es una pregunta.

## C4 · Eventos nuevos y cambiados

En `eventSchema` (`src/store/events.ts`). `Origen` es `z.enum(["terminal", "claude", "orca"])`.

| Evento | Campos | Efecto en el engine |
|---|---|---|
| `arreglo_pedido` (nuevo) | `at`, `unidades: string[]` (al menos 1), `instruccion: string` (no vacía), `origen` | solo desde `detenido`: entra a `implementar` con esas `unidades` y esa `instruccion`. **No suma vueltas** |
| `arreglo_manual_iniciado` (nuevo) | `at`, `origen` | solo desde `detenido`: queda `detenido`, con `aMano: true`, y `halt.siguiente` y `opciones` pasan a `[resume, abort]` con el motivo «editá el worktree y retomá» |
| `arreglo_manual` (nuevo) | `at`, `sha: string \| null` (`null` si no había cambios) | solo con `aMano`: entra a `verificar` con `aMano: false` |
| `aceptado` (nuevo) | `at`, `fase`, `motivo: string` (no vacío), `origen` | solo desde `detenido` en esa `fase`, y solo si la fase es verificar, revisar o probar: entra a la fase siguiente. Generaliza `sin_probar_aceptado`, que se sigue leyendo igual |
| `aprobado` | suma `origen` opcional | sin cambios |
| `cambios_pedidos` | suma `origen` opcional | sin cambios |
| `run_creado` | suma `vueltas` opcional | ver C3 |

- **`RunState`** suma `aMano: boolean` (inicial `false`).
- **Lo aceptado va a la PR:** `entregar` y el informe listan cada `aceptado`, con su fase y su
  motivo, igual que hoy `sin_probar_aceptado`.

## C5 · CLI nuevo y cambiado

Cada comando responde con `runStartedSchema` y respeta la cola (`lanzarOEncolar`) como los demás.

| Comando | Qué hace |
|---|---|
| `flowrunner fix <run> --unidad ST-n [--unidad ST-m] "<instrucción>" [--origen o]` | solo sobre un `detenido` con pregunta: escribe `arreglo_pedido` y lanza |
| `flowrunner fix <run> --yo [--origen o]` | solo sobre un `detenido`: escribe `arreglo_manual_iniciado`, imprime la ruta del worktree de la feature y no lanza nada |
| `flowrunner resume <run>` | con `aMano`, antes de lanzar: chequea el diff del worktree, commitea con el trailer `Flowrunner-Manual: <run>` y escribe `arreglo_manual`. Si algún chequeo falla, no commitea, sale con 1 y lista los problemas. Sin `aMano`, igual que hoy |
| `flowrunner accept <run> "<por qué>" [--origen o]` | escribe `aceptado` con la fase del halt y lanza. `accept-untested` queda como está, como comando propio que sigue escribiendo `sin_probar_aceptado` |
| `--origen terminal\|claude\|orca` | en `approve`, `changes`, `fix` y `accept`. Por defecto `terminal`. La skill pasa `claude`; el worker de Orca, `orca` |
| `flowrunner self-update` | PR 01 |
| `flowrunner stats --runs [proyecto]` | PR 02 |

**Qué chequea `resume` sobre un arreglo a mano.** Solo tres cosas: que no toque `.git`, que los
tests bloqueados sigan con su hash, y que no agregue secretos. Las rutas protegidas
(`ALWAYS_PROTECTED`) no se chequean: protegen de los agentes, no de la persona, y arreglar a mano un
`CLAUDE.md`, como en VF-6, es para lo que existe `fix --yo`.

## C6 · Contexto de graft para un prompt

Módulo nuevo `src/graft/contexto.ts`, de la PR 04. Lo usan las PRs 04, 09 y 12:

```ts
export interface ContextoOpts {
  readonly repo: string;        // el worktree que indexó graft
  readonly indexDir: string;    // graftIndex(run)
  readonly archivos: readonly string[]; // rutas relativas, archivos o carpetas
  readonly env: NodeJS.ProcessEnv;
  readonly maxChars?: number;   // por defecto 12_000
}

/** API de cada archivo y quién llama a lo que exporta, en Markdown. Nunca tira: si graft falla, lo dice en el texto. */
export function contextoGraft(opts: ContextoOpts): Promise<string>;

/** Los archivos que llaman a `simbolo`, relativos al repo. Para decidir qué conservar en un replan. */
export function llamadoresDe(
  repo: string,
  indexDir: string,
  simbolo: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]>;
```

- **Implementación:** con el CLI de graft, como `blastRadius` en `src/graft/graft.ts`, con
  `GRAFT_ENV`, `--json` y `--no-refresh`. En modo texto, graft imprime en stdout una línea dirigida al
  agente que no puede llegar a un prompt. El detalle, con salidas reales de graft 0.18, está en la
  PR 04.
- **Una carpeta en `archivos`** se expande a sus archivos versionados, hasta 30.
- **Sobre `maxChars`:** el texto se corta en el último archivo que entra entero, y lo dice.

## C7 · Dónde corre flowrunner

De la PR 01, que es la primera.

- **El flowrunner que corre** vive en `APP_DIR = join(flowrunnerHome(env), "app")`: un worktree
  `--detach` del repo de flowrunner, con su `node_modules`.
- **Los tres puntos de entrada apuntan ahí:** `~/.local/bin/flowrunner`, el `tick` de launchd y el
  plugin de Orca.
- **El checkout de desarrollo no corre runs.** `BIN` y `ORCA_PLUGIN_DIR` salen de `APP_DIR` cuando
  se instala, no de `import.meta.dirname` del checkout.

## C8 · Lo que no cambia

- El formato de `events.jsonl`: solo de agregar. Un evento viejo se sigue leyendo igual.
- `max_runs`, los lugares, la cola y los turnos (ADR 0019).
- El gate de afuera de planificar: sigue siendo el único que corre los tests en rojo.
- Los nombres de las fases.
