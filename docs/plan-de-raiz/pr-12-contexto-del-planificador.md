# PR 12 · El planificador arranca con el código ya ubicado

Rama: `feat/contexto-del-planificador` · Depende de: PR 04 (`contextoGraft`, C6) · Tamaño: mediano

## Objetivo

- **El problema:**
  - El primer plan cuesta, en promedio, US$ 2,76 y 10 minutos; el de VF-1 tuvo 97 `Read` en 267
    turnos.
  - La feature que escribe la skill ya comprobó y citó el código con `archivo:línea`, y el
    planificador lo vuelve a buscar desde cero.
  - graft como herramienta se suma a las lecturas en vez de reemplazarlas: en VF-1, entre 26 y 37
    llamadas a graft **y** entre 59 y 73 `Read` por plan.
- **El cambio:** que la feature lleve sus citas en una sección `## Contexto`, y que planificar le
  ponga al planificador, en el prompt y antes de empezar, esas citas y el contexto de graft de esos
  archivos (principio 7: el contexto llega calculado).
- **Métrica:** el primer plan, en promedio, baja de US$ 2,76 a menos de US$ 1,5, y de 10 a menos de
  6 minutos. Se mide con `flowrunner stats --runs` (PR 02) en los 5 runs de la fase 6.

## Decisiones tomadas (no reabrir)

1. **La sección es opcional** y va entre `## Descripción` y `## Criterios`. Una feature vieja, sin
   ella, se sigue leyendo igual.
2. **Formato exacto de cada línea:** `- <ruta>[:<desde>[-<hasta>]] — <qué hace o qué fija hoy>`. El
   separador es una raya larga (`—`) con un espacio a cada lado. La ruta es relativa a la raíz del
   repo, sin `./`; `<desde>` y `<hasta>` son enteros desde 1, con `desde <= hasta`.
3. **Una cita mal formada es un error de `parseFeature`** (un `ConfigError` con la línea), como un
   criterio sin `AC-n:`.
4. **Una cita a un archivo que no existe en el repo, o a una línea más allá del final, frena
   `feature check` con un error.** Las citas son del código de hoy, no del que la feature va a crear.
5. **El Contexto no entra en `featureText`.** Solo lo reciben planificar (esta PR) y explorar (la
   PR 13). Implementar, revisar, probar y diagnosticar no lo necesitan, y sería contexto de más en
   cada turno.
6. **Sin Contexto, planificar saca los archivos** de las rutas que nombran la descripción, los
   criterios y las aclaraciones (función `archivosNombrados`, abajo), y se queda con las que existen
   en el worktree. Si no queda ninguna, el prompt dice que la feature no ubicó código y que explore
   el planificador.
7. **A lo sumo 20 archivos** pasan a `contextoGraft`, en el orden en que aparecen; `contextoGraft`
   recorta por tamaño (C6). El planificador conserva graft como herramienta y el subagente
   explorador, sin cambios.

## Cambios, archivo por archivo

Las referencias son a `main` en `e78201c`.

### `src/feature/feature.ts`

- Sumar el tipo y el campo:

  ```ts
  export interface Cita {
    readonly ruta: string;
    readonly desde?: number;
    readonly hasta?: number;
    readonly que: string;
  }
  // en Feature:
  readonly contexto: readonly Cita[];
  ```

- **`SECTIONS`** (línea 33) suma `contexto: "contexto"`, y `SectionKey` lo toma solo.
- **En `parseFeature`** (desde la línea 52), después de las aclaraciones y antes del `return`:

  ```ts
  const CITA = /^([^\s:]+?)(?::(\d+)(?:-(\d+))?)?\s+—\s+(.+)$/;
  const contexto: Cita[] = [];
  for (const item of listItems(sections.get("contexto") ?? [])) {
    const m = CITA.exec(item);
    if (m === null) {
      problems.push({
        where: `${file} › Contexto`,
        message: `"${item}" no tiene la forma ruta:línea — qué hace`,
      });
      continue;
    }
    const [, ruta = "", desde, hasta, que = ""] = m;
    const d = desde === undefined ? undefined : Number(desde);
    const h = hasta === undefined ? d : Number(hasta);
    if (ruta.startsWith("/") || ruta.startsWith("./") || ruta.split("/").includes("..") || (d !== undefined && (d < 1 || (h ?? d) < d))) {
      problems.push({
        where: `${file} › Contexto`,
        message: `"${item}": la ruta va relativa al repo, sin ./ ni .., y las líneas desde 1, con desde <= hasta`,
      });
      continue;
    }
    contexto.push({ ruta, ...(d === undefined ? {} : { desde: d, hasta: h }), que: que.trim() });
  }
  ```

  Y en el `return`: `contexto,`.
- `listItems` ya junta las líneas de continuación: una cita larga en dos líneas sigue valiendo.

### `src/feature/citas.ts` (nuevo)

Funciones puras, para testear sin red ni graft:

```ts
import type { Cita, Feature } from "./feature.ts";

/** Problemas de las citas contra el repo: archivo inexistente o línea fuera del archivo. */
export function checkCitas(
  citas: readonly Cita[],
  leer: (ruta: string) => string | undefined, // undefined si no existe o es carpeta
): string[];

/**
 * Las rutas que nombra el texto de la feature (descripción, criterios, aclaraciones), en orden de
 * aparición, sin repetir. Solo las que `existe` acepta. Hasta `max` (20).
 */
export function archivosNombrados(
  feature: Pick<Feature, "descripcion" | "criterios" | "aclaraciones">,
  existe: (ruta: string) => boolean,
  max = 20,
): string[];
```

- **`checkCitas`**, con estos textos exactos:
  - `Contexto cita ${ruta}, que no existe en el repo: las citas son del código de hoy`;
  - `Contexto cita ${ruta}:${desde}-${hasta}, pero el archivo tiene ${n} líneas`.
- **`archivosNombrados`** usa esta regex sobre cada texto:

  ```ts
  /(?:^|[\s`'"(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6}|(?:[\w@.-]+\/)+)(?=$|[\s`'"),.:;])/gm
  ```

  Saca `./` del principio, y una ruta que termina en `:12` se toma sin la línea. Una carpeta
  (`src/export/`) cuenta si `existe` la acepta.

### `src/cli/feature-check.ts`

Sobre la versión de #70.

- **En `checkFeature`**, después de `parseFeature`:

  ```ts
  const problemas = checkCitas(feature.contexto, (ruta) => {
    const abs = join(project.path, ruta);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
  });
  if (problemas.length > 0)
    throw new ConfigError(problemas.map((message) => ({ where: `${file} › Contexto`, message })));
  ```

- **`describeCheckedFeature`** suma la línea
  `${feature.contexto.length} citas de código en Contexto` después de la de criterios.
- El `--json` ya devuelve `feature`, que ahora trae `contexto`: es un cambio aditivo del contrato
  de la skill.

### `src/phases/planificar.ts`

- **Import:** `contextoGraft` desde `../graft/contexto.ts` (PR 04), y `archivosNombrados` desde
  `../feature/citas.ts`.
- **Función nueva**, exportada para el test:

  ```ts
  /** La sección del prompt con lo que la feature ya ubicó y el contexto de graft de esos archivos. */
  export async function codigoUbicado(
    feature: Feature,
    worktree: string,
    indexDir: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const citas = feature.contexto;
    const archivos =
      citas.length > 0
        ? [...new Set(citas.map((c) => c.ruta))].slice(0, 20)
        : archivosNombrados(feature, (r) => existsSync(join(worktree, r)));
    if (archivos.length === 0)
      return "La feature no ubicó código: explorá vos, con graft y el explorador.";
    const lineas = citas.map(
      (c) => `- ${c.ruta}${c.desde === undefined ? "" : `:${c.desde}${c.hasta !== c.desde ? `-${c.hasta}` : ""}`} — ${c.que}`,
    );
    const graft = await contextoGraft({ repo: worktree, indexDir, archivos, env });
    return [
      ...(lineas.length === 0
        ? [`La feature no trae citas; estos son los archivos que nombra: ${archivos.join(", ")}.`]
        : ["## Lo que comprobó quien escribió la feature", "", ...lineas]),
      "",
      "## Lo que dice graft de esos archivos",
      "",
      graft,
    ].join("\n");
  }
  ```

- **Antes del `runSession`**, en una constante con nombre (la PR 13 la reusa):
  `const codigo = await codigoUbicado(feature, worktree, graftIndex(run), deps.env);`. Se calcula
  **después** de `resetHard` y de restaurar los tests (líneas 107 a 111), así graft mira la base.
- **En el `render("planificar", { ... })`** (línea 142), la variable nueva: `codigo_ubicado: codigo`.

### `prompts/planificar.md`

- **Una sección nueva, justo después de `# La feature`:**

  ```markdown
  # El código que ya ubicó la feature

  {{codigo_ubicado}}
  ```

- **El paso 1, primera viñeta**, se reemplaza por:

  > - **Partí de «El código que ya ubicó la feature».** Ahí está lo que se comprobó al escribirla y
  >   la API de esos archivos con quién los llama. No lo vuelvas a buscar: leé con Read solo lo que
  >   falta, y solo los rangos (`offset` y `limit`). Para lo que no está ahí, ubicá con graft
  >   (`graft_find_code`, `graft_trace_calls`, `graft_find_all`) antes de leer.

  Las viñetas de «Leé solo rangos» y «Delegá los recorridos» se quedan como están. El test
  `el explorador recibe las herramientas de graft, y el prompt pide ubicar con graft y leer rangos`
  (`planificar.test.ts:129`) sigue buscando `graft_find_code` y `` `offset` y `limit` ``: los dos
  textos siguen en el prompt.

### `skills/flowrunner/SKILL.md`

- **El paso 2 de «Escribir una feature»** suma al final: «Esas citas van en la sección
  `## Contexto` de la feature: el planificador arranca por ahí.»
- **El paso 4** suma la sección al bloque del formato exacto, entre Descripción y Criterios:

  ```markdown
  ## Contexto

  - src/export/pedidos.ts:40-58 — arma la consulta de pedidos por rango
  - tests/pedidos.test.ts:12 — fija que un rango vacío devuelve []
  ```

  Y una línea debajo del bloque: «Contexto es opcional, pero cada cita que comprobaste en el paso 2
  va ahí, con la forma `ruta:línea — qué hace`. Solo código que ya existe: `feature check` frena una
  cita a un archivo que no está.»

## Tests

Escribirlos primero y verlos fallar.

| Archivo | Nombre exacto | Qué afirma | Por qué falla hoy |
|---|---|---|---|
| `src/feature/feature.test.ts` | `la sección Contexto trae cada cita con su ruta, sus líneas y qué hace` | con `- src/a.ts:12-20 — arma X`, `- src/b.ts — fija Y` y una continuación en otra línea, `contexto` es `[{ruta:"src/a.ts",desde:12,hasta:20,que:"arma X"},{ruta:"src/b.ts",que:"fija Y …"}]`; una feature sin la sección tiene `contexto: []` | `## Contexto` es «sección desconocida» |
| `src/feature/feature.test.ts` | `una cita de Contexto sin la forma ruta:línea — qué hace es un error` | `- src/a.ts arma X` (sin raya), `- /abs.ts:1 — x` y `- src/a.ts:9-3 — x` dan cada uno su problema | la sección no existe |
| `src/feature/citas.test.ts` | `checkCitas frena un archivo inexistente y una línea fuera del archivo` | los textos exactos de arriba, con un `leer` de mentira | el módulo no existe |
| `src/feature/citas.test.ts` | `archivosNombrados toma las rutas de la descripción, los criterios y las aclaraciones que existen` | con «`src/export/csv.ts`», «src/api/» y «tests/x.test.ts:12» en distintos lugares, y un `existe` que rechaza una, devuelve las que existen, sin la línea, en orden y sin repetir; `README` (sin barra) no cuenta | el módulo no existe |
| `src/phases/planificar.test.ts` | `el prompt trae las citas de la feature y el contexto de graft de esos archivos` | con una feature con `## Contexto` que cita `src/export/csv.js` (en `makeProject`), el prompt del planificador contiene la cita y el texto exacto de `await contextoGraft({ repo: worktree, indexDir: graftIndex(run), archivos: ["src/export/csv.js"], env })` | la variable no existe |
| `src/phases/planificar.test.ts` | `sin Contexto, el prompt toma los archivos que nombra la feature, y sin ninguno lo dice` | una feature que nombra un archivo existente lo lleva al contexto; una que no nombra ninguno trae «La feature no ubicó código» | la variable no existe |

- **Para los de planificar:** `plannedRun`, `makeProject` y `preparar` ya construyen el índice de
  graft real (ADR 0015), así que `contextoGraft` corre de verdad.
- **La feature de prueba** se escribe en el `newRun` del test: `newRun(work, featureConContexto)`.

## Docs a actualizar

- `skills/flowrunner/SKILL.md`: arriba.
- `README.md`: en la sección del formato de la feature, si la hay, la sección `## Contexto` con un
  ejemplo de dos líneas. Si no la hay, una línea en «Cómo se usa», en el paso de escribir la
  feature.
- `prompts/planificar.md`: arriba.
- Sin ADR: no cambia la arquitectura.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

- `test/skill.int.test.ts` lee el SKILL.md instalado: tiene que seguir en verde.
- El conteo de `stats --runs` sobre los 5 runs de la fase 6 lo hace la persona.

## Fuera de alcance

- Pasar el Contexto a implementar o a revisar: la sub-task ya recibe su contexto de graft (PR 04).
- Cambiar el modelo de planificar (D6).
- La sesión `explorar` previa: PR 13.

## Riesgos y cómo se detectan

- **Una feature con muchas citas infla el prompt.** `contextoGraft` corta en `maxChars` (12.000)
  y las citas son una línea cada una. Se ve en `stats --runs` como tokens de entrada del primer
  turno.
- **El planificador lee igual.** Se mide en la fase 6 con los `Read` por plan, contra la línea de
  base de 59 a 97 en los runs grandes. Si no bajan, se revisa el texto del paso 1 antes de sacar el
  contexto.
- **La regex de `archivosNombrados` toma de más**, como una URL con barras. Solo pasan las rutas
  que existen en el worktree, así que lo peor es un archivo de más en el contexto.
