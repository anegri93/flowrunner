# PR 13 · Que explore un modelo barato antes de planificar

Rama: `feat/explorar-antes` · Depende de: PR 12 (`codigoUbicado`), PR 04 (`contextoGraft`) ·
Tamaño: mediano

## Objetivo

- **El problema:** Opus explora solo y paga cada turno por el tamaño del contexto que relee. El
  primer plan de VF-1 leyó 20,9 millones de tokens de caché en 267 turnos. El subagente
  `explorador` existe, pero se usó en 5 de 23 sesiones, todas de ML-1 y VF-1.
- **El cambio:** con `explorar_antes: true`, una sesión `explorar` de Sonnet corre antes del primer
  plan del run y entrega un informe corto. Opus planifica sobre ese informe, con un contexto chico.
- **Métrica para decidir si queda:** en los runs con `explorar_antes`, el costo de explorar más
  planificar del primer plan baja al menos un 30 % contra los runs con solo la PR 12, sin que suban
  los rechazos del gate por run. Si no baja, se saca en una PR aparte: la opción viene apagada, así
  que no hay que migrar nada.

## Decisiones tomadas (no reabrir)

1. **`explorar_antes: boolean`** en la config del repo, **por defecto `false`**. Es un experimento:
   con la opción apagada, el comportamiento es el de la PR 12.
2. **El modelo:** el default de `models.explorar` pasa de Haiku (`low`) a
   `{ model: "claude-sonnet-5-5", effort: "medium" }`. Por qué:
   - el informe pasa a ser **la** exploración de Opus, y si queda incompleto, Opus vuelve a leer, que
     es el costo que se quiere sacar;
   - el subagente de hoy, con Haiku, no bajó las lecturas en VF-1 (entre 59 y 97 `Read` por plan con
     el subagente en uso);
   - el subagente se usa poco (5 de 23 sesiones), así que encarecerlo pesa poco;
   - un repo que quiera Haiku lo vuelve a poner en `models.explorar`.

   La misma clave sirve para la sesión nueva y para el subagente. No se agrega una fase de agente
   nueva.
3. **La sesión corre dentro de la fase `planificar`.** Su `uso` queda con `fase: "planificar"` y
   `sesion: "explorar-N"`: la distingue el nombre de sesión, y `stats --runs` (PR 02) la cuenta en
   planificar.
4. **Solo el primer plan del run explora.** Si `runs/<id>/exploracion.md` ya existe, no se vuelve a
   explorar: un replan, un pedido de cambios o un reintento por el gate reusan el informe.
5. **El explorador solo lee:** Read, Grep, Glob y el MCP de graft. Sin Write, sin Bash, sin Agent.
   Recibe la feature, `codigoUbicado` (PR 12) y el cerebro del repo.
6. **La salida es estructurada** (abajo) y flowrunner la pasa a Markdown con una función pura. El
   planificador recibe el Markdown.
7. **El planificador conserva graft como herramienta y el subagente `explorador`**, sin cambios.
8. **Si la sesión `explorar` falla** por `gate`, `infra` o `entorno`, planificar sigue sin informe y
   deja un `aviso`: explorar es una ayuda, no un paso obligatorio. Un `limite` sí se devuelve tal
   cual (el run se pausa como cualquier otra sesión).

## Cambios, archivo por archivo

Las referencias son a `main` en `e78201c`.

### `src/config/schemas.ts`

- **`DEFAULT_MODELS.explorar`** (línea 25) pasa a `{ model: "claude-sonnet-5-5", effort: "medium" }`.
- **En `repoConfigSchema`:**

  ```ts
  /** Una sesión de Sonnet explora antes del primer plan y le deja a Opus un informe (PR 13). */
  explorar_antes: z.boolean().default(false),
  ```

### `src/phases/explorar.ts` (nuevo)

```ts
import { z } from "zod";

export const exploracionSchema = z.object({
  archivos: z.array(z.object({
    ruta: z.string().min(1),
    lineas: z.string().describe("rango como 40-58, o vacío si es el archivo entero").default(""),
    que: z.string().min(1).describe("qué hace o qué fija, en una frase"),
  })),
  funciones: z.array(z.object({
    simbolo: z.string().min(1),
    donde: z.string().min(1).describe("archivo:línea"),
    que: z.string().min(1),
    llamadores: z.array(z.string()).describe("archivo:línea de cada llamada que importa"),
  })),
  tests_existentes: z.array(z.object({
    ruta: z.string().min(1),
    que_fija: z.string().min(1),
  })),
  riesgos: z.array(z.string().min(1)).describe("lo que el plan no puede romper o tiene que cambiar"),
  dudas: z.array(z.string().min(1)).describe("lo que no se pudo resolver leyendo"),
});
export type Exploracion = z.infer<typeof exploracionSchema>;

/** El informe en Markdown, para el prompt del planificador y para runs/<id>/exploracion.md. */
export function exploracionMd(e: Exploracion): string;

export const EXPLORAR_TIMEOUT_MS = 15 * 60_000;

/**
 * Corre la sesión de exploración y escribe runs/<id>/exploracion.md. Devuelve el Markdown, o
 * undefined si la sesión falló (deja un aviso), o el outcome `limite` para que planificar lo
 * devuelva.
 */
export async function explorar(
  ctx: PhaseContext,
  opts: { worktree: string; config: RepoConfig; feature: Feature; codigo: string },
): Promise<{ tipo: "ok"; md: string } | { tipo: "sin_informe" } | { tipo: "limite"; hasta: number }>;
```

- **`exploracionMd`** arma una sección por campo (`## Archivos`, `## Funciones`,
  `## Tests que ya existen`, `## Riesgos`, `## Dudas`), con una viñeta por ítem. Una sección vacía
  dice `(ninguno)`.
- **La sesión dentro de `explorar`**:
  - `runSession` con `fase: "planificar"` y `nombre: sessionName(ctx.run, "explorar")`
    (`sessionName` viene de `./planificar.ts`);
  - `prompt: render("explorar", { feature: featureText(feature), codigo_ubicado: opts.codigo, ...brainVars(brain) })`;
  - `model: opts.config.models.explorar`, `tools: ["Read", "Grep", "Glob"]`;
  - `mcpServers: { graft: graftMcpServer(worktree, graftIndex(run), deps.env) }`;
  - `schema: exploracionSchema` y `timeoutMs: EXPLORAR_TIMEOUT_MS`.
- **El hook** es un `tripwireHook` con el scope de solo lectura de `readOnlyHook`
  (`src/phases/aprender.ts:105`), pero con `graft: true` y `fase: "planificar"`. Para no duplicarlo,
  `readOnlyHook` suma un parámetro: `readOnlyHook(ctx, root, fase = "aprender", graft = false)`, y
  explorar lo llama con `(ctx, realpathSync(worktree), "planificar", true)`.
- **Con salida válida:** escribe `join(run.dir, "exploracion.md")` y devuelve `{ tipo: "ok", md }`.
- **Si la sesión falla:** emite
  `{ tipo: "aviso", fase: "planificar", texto: `la exploración previa falló (${clase}): ${motivo}; se planifica sin informe` }`
  y devuelve `{ tipo: "sin_informe" }`.

### `prompts/explorar.md` (nuevo)

```markdown
Sos el explorador de flowrunner. Antes de que se planifique la feature de abajo, ubicá en el repo
de tu directorio de trabajo todo lo que el plan va a necesitar, y devolvelo con la salida
estructurada. Solo leés.

- Partí de «El código que ya ubicó la feature». No lo repitas: completalo.
- Ubicá con graft (`graft_find_code`, `graft_trace_calls`, `graft_find_all`, `graft_file_api`)
  antes de leer, y leé con Read solo rangos, con `offset` y `limit`.
- Buscá: los archivos que la feature va a tocar; las funciones que cambian y **todos** sus
  llamadores (también los que pasan por una variable sin tipo, como `app.get(...)`, que graft no
  ve: para esos, Grep); los tests que hoy fijan ese comportamiento; y lo que se puede romper.
- Cada ítem con `archivo:línea`. Nada de código pegado: una frase por ítem.
- Lo que no puedas resolver leyendo va en `dudas`, no lo adivines.

# La feature

{{feature}}

# El código que ya ubicó la feature

{{codigo_ubicado}}

# El cerebro del repo

## Convenciones

{{convenciones}}

## Contexto

{{contexto}}
```

`render` ignora variables de más, así que pasarle `brainVars` entero no rompe aunque la plantilla
no use `que_es_bien`, `lecciones` ni `ejemplos`.

### `src/phases/planificar.ts`

- **Después de calcular `codigo`** con `codigoUbicado` (PR 12), y antes de armar el `render`:

  ```ts
  const informeFile = join(run.dir, "exploracion.md");
  let informe = existsSync(informeFile) ? readFileSync(informeFile, "utf8") : undefined;
  if (informe === undefined && config.explorar_antes) {
    const e = await explorar(ctx, { worktree, config, feature, codigo });
    if (e.tipo === "limite") return e;
    if (e.tipo === "ok") informe = e.md;
  }
  ```

- **El render** suma la variable:
  `exploracion: informe === undefined ? "(no hubo exploración previa)" : informe`.

### `prompts/planificar.md`

- **Después de `# El código que ya ubicó la feature`** (PR 12):

  ```markdown
  # Lo que encontró el explorador

  {{exploracion}}
  ```

- **El paso 1, primera viñeta** (la de la PR 12), suma al principio: «Si hay un informe en «Lo que
  encontró el explorador», es tu punto de partida: no vuelvas a leer lo que ya resume; leé solo lo
  que falte para decidir.»

## Tests

Escribirlos primero y verlos fallar.

| Archivo | Nombre exacto | Qué afirma | Por qué falla hoy |
|---|---|---|---|
| `src/config/config.test.ts` | `explorar_antes viene apagado y el explorador usa Sonnet por defecto` | una config mínima da `explorar_antes === false` y `models.explorar` igual a `{ model: "claude-sonnet-5-5", effort: "medium" }` | el campo no existe y el default es Haiku |
| `src/phases/explorar.test.ts` | `el informe en Markdown tiene una sección por campo y dice ninguno donde no hay` | `exploracionMd` con un archivo y sin funciones contiene `## Archivos`, la viñeta con `ruta:lineas — que`, y `## Funciones` seguido de `(ninguno)` | el módulo no existe |
| `src/phases/planificar.test.ts` | `con explorar_antes, explorar corre antes del plan, solo lee, y su informe llega al prompt` | con `config: { …, explorar_antes: true }` y un sim que responde a la primera sesión con una `Exploracion` válida: hay 2 sesiones; la primera tiene modelo Sonnet, `mcpServers` con `graft` y entre sus herramientas no hay Write ni Agent; `exploracion.md` existe en el run; el prompt de la segunda contiene el Markdown del informe | no hay sesión de exploración |
| `src/phases/planificar.test.ts` | `un replan no vuelve a explorar: reusa el informe` | con `exploracion.md` ya escrito en el run y `explorar_antes: true`, hay una sola sesión, la del planificador, y su prompt contiene el informe | no hay sesión de exploración |
| `src/phases/planificar.test.ts` | `si la exploración falla, planifica igual sin informe y lo avisa` | el sim hace fallar la primera sesión (salida inválida): hay un `aviso` con «la exploración previa falló» y el plan sale igual | no hay sesión de exploración |
| `src/phases/planificar.test.ts` | `sin explorar_antes no hay sesión de exploración` | config por defecto: una sola sesión, y el prompt dice «(no hubo exploración previa)» | la variable no existe |

- **Para distinguir las sesiones en el sim:** que el script elija por el prompt, con
  `prompt.startsWith("Sos el explorador")`.
- **`test/fase0.int.test.ts:40-45`** lee `repoConfig` del `feature check --json`. Si compara
  `models` entero, actualizarlo al default nuevo de `explorar`: es un cambio de default, no un test
  debilitado.

## Docs a actualizar

- **`README.md`:** en la sección de configuración, `explorar_antes: true # experimento: Sonnet
  explora antes del primer plan` con una frase sobre cuándo usarlo, y que el default de
  `models.explorar` ahora es Sonnet.
- **`docs/adr/0011-graft-como-contexto.md`:** una línea en Consecuencias: con `explorar_antes`, el
  explorador previo también tiene graft como herramienta.
- **Sin ADR nuevo:** es un experimento detrás de una opción.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

Para la métrica, en la fase 6: `flowrunner stats --runs` sobre runs con y sin `explorar_antes`.
Se suma el costo de `explorar-1` y `planificar-1`.

## Fuera de alcance

- Sacar el subagente `explorador` del planificador.
- Explorar antes de cada replan.
- Prender `explorar_antes` por defecto: se decide con los datos de la fase 6.

## Riesgos y cómo se detectan

- **El informe es malo y Opus lo sigue a ciegas.** Sube el gate rechazado (llamadores fuera del
  alcance, tests sin declarar) en los runs con la opción. Es la condición de la métrica.
- **Dos sesiones cuestan más que una cuando la feature es chica.** Se ve en `stats --runs` en las
  features de hasta 3 criterios. Si pasa, la opción queda solo para features grandes, como decisión
  del repo.
- **El cambio de default de `models.explorar` encarece el subagente** en los repos que no tocan la
  opción. Se ve en el costo de planificar de los runs que lo usan. El subagente se usa poco (5 de
  23 sesiones).
