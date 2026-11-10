# PR 04 · Contexto de graft calculado, y cada sub-task arranca orientada

Rama: `feat/contexto-graft` · Depende de: PR 03 (usa su prompt de implementar) · Tamaño: mediano

## Objetivo

Hoy las sub-tasks no tienen graft (`graft: false` en `src/phases/implementar.ts`). Para orientarse,
corren `ls`, `cat`, `git log` y `git status` por Bash: buena parte de los unos 100 comandos de
lectura que rechazó el bloqueo en 9 runs eran eso. Y donde graft sí está, como herramienta del
planificador, se sumó a las lecturas en vez de reemplazarlas. En revisar, donde llega calculado
(`blastRadius`), se usa sin gastar turnos.

Esta PR hace dos cosas:
- **El módulo `src/graft/contexto.ts`** (contrato C6), que arma el contexto calculado. Lo reusan la
  PR 09 (`llamadoresDe`, para decidir qué se conserva en un replan) y la PR 12 (`contextoGraft` sobre
  el worktree de la feature, para el planificador).
- **El prompt de cada sub-task** pasa a traer la API de los archivos de su alcance, quién usa lo que
  exportan (marcando los llamadores fuera de su alcance) y las sub-tasks ya integradas en la rama.

**Métrica:** en 3 runs nuevos, los comandos de orientación de implementar (`ls`, `cat`,
`git status`, `git log`) bajan a la mitad contra la línea de base, y el costo de implementar por
sub-task no sube. Se mide con `stats --runs` de la PR 02.

## Decisiones tomadas (no reabrir)

1. **Las firmas de C6 son exactamente las de `01-contratos.md`.** Este módulo suma exports, pero no
   cambia ni las firmas ni `ContextoOpts`.
2. **Siempre `--json` y `--no-refresh`.** Es lo que se vio al correr graft 0.18 contra un índice real:
   - En modo texto, la salida (stdout) empieza con una línea
     `[graft] tokens saved ≈ … At the end of your reply, tell the user …`. **Es una instrucción
     dirigida a un agente, y no puede llegar a un prompt.** Con `--json`, la salida es JSON puro, y
     el ahorro viene en el campo `saved`, que se ignora.
   - `--no-refresh` evita que graft revise o reconstruya el índice en cada consulta. El índice lo
     reconstruye implementar al entrar (decisión 7).
3. **Con qué comandos:**
   - API: `graft --dir <índice> skeleton <archivo> <repo> --json --no-refresh`.
   - Llamadores: `graft --dir <índice> callers <símbolo> <repo> --json --no-refresh`, con
     profundidad 1, que es la de por defecto.
   - Siempre con `env: { ...opts.env, ...GRAFT_ENV }`, `execFile` y `maxBuffer` de 16 MB, como
     `blastRadius` (`src/graft/graft.ts:57`).
4. **De qué se buscan llamadores:** solo de las entradas `function` y `class` de cada archivo. Los
   `type`, `interface` y `method` no: los métodos aparecen como `constructor` y con nombre ambiguo.
   - De los `matches`, se usan solo los que tienen `symbol.path === archivo`.
   - Se listan solo los `hits` con `path !== archivo`, porque los del mismo archivo no le sirven a la
     sub-task.
   - Si un símbolo no tiene llamadores de afuera, su entrada va sin la lista.
5. **Presupuesto:**
   - como mucho 30 archivos (una carpeta se expande con `git ls-files -- <carpeta>`, ordenados);
   - como mucho 40 consultas de `callers` por llamada a `contextoGraft`, en el orden en que aparecen
     los símbolos;
   - 4 consultas a la vez;
   - 60 segundos en total. Lo que no entra se omite, y una línea final dice cuántas consultas
     quedaron sin hacer.

   Una consulta tarda unos 0,26 s, medido contra un índice del repo de flowrunner.
6. **El formato de salida es fijo** (abajo), porque `marcarFueraDeAlcance` lo interpreta línea por
   línea.
7. **Implementar reconstruye el índice al entrar a la fase**, antes de arrancar las sub-tasks, con
   `buildIndex(featureWt, graftIndex(run), env)`. La rama tiene los tests del plan y lo ya integrado,
   que el índice de preparar no tiene. Tarda unos segundos (ADR 0015 midió 3,6 s para 426 archivos).
   Si falla, queda un aviso y las sub-tasks reciben el texto de falla de `contextoGraft`: no se
   detiene nada.
8. **Las sub-tasks no reciben graft como herramienta** (siguen con `graft: false`). El contexto llega
   calculado, en el prompt, según el principio 7 del plan.
9. **Las «sub-tasks ya integradas»** salen del log del run en el momento de arrancar cada sub-task
   (`readLog(run.dir).events`, no de `ctx.events`, que es de cuando empezó la fase):
   - los eventos `unidad` con `estado: "integrada"` posteriores al último `aprobado`;
   - de cada unidad, el último;
   - sin la propia sub-task.

## Cambios, archivo por archivo

### `src/graft/graft.ts`

Exportar `graftEnv`, hoy privada en la línea 13, para usarla desde `contexto.ts`. No cambia nada
más.

### `src/graft/contexto.ts` (nuevo)

```ts
// El contexto de graft para un prompt, calculado antes de la sesión: la API de los archivos y quién
// usa lo que exportan. Un dato que el agente busca en tres turnos cuesta tres veces el contexto
// entero; calculado, cuesta cero turnos (plan de raíz, principio 7).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { graftEnv } from "./graft.ts";
import { git } from "../git/git.ts";

export interface ContextoOpts { /* exactamente C6 */ }

/** Una entrada de `graft skeleton --json`. */
export interface EntradaApi {
  readonly name: string;
  readonly kind: string; // "function" | "class" | "method" | "type" | "interface" | …
  readonly span: string; // "L21-L23"
  readonly signature: string;
}
/** Un hit de `graft callers --json`. */
export interface Llamador {
  readonly name: string;
  readonly kind: string; // "function" | "file" | …
  readonly path: string;
  readonly span: string;
  readonly relation: string; // "calls" | "references"
}

export function contextoGraft(opts: ContextoOpts): Promise<string>;
export function llamadoresDe(repo: string, indexDir: string, simbolo: string, env: NodeJS.ProcessEnv): Promise<string[]>;

/** Puro: la sección Markdown de un archivo. La prueban los tests unitarios. */
export function seccionDe(archivo: string, api: readonly EntradaApi[], llamadores: ReadonlyMap<string, readonly Llamador[]>): string;
/** Puro: junta las secciones respetando `maxChars` y lo que quedó afuera. */
export function juntar(secciones: readonly string[], total: number, maxChars: number, consultasOmitidas: number): string;
/** Puro: agrega « · fuera de tu alcance» a cada línea de llamador cuya ruta no está en `alcance`. */
export function marcarFueraDeAlcance(texto: string, alcance: readonly string[]): string;
```

**Formato exacto de `seccionDe`:**

````md
### `src/store/lugares.ts`

- L21-L23 · `function lugaresDir(home: string, proyecto: string): string`
- L95-L117 · `function tomarLugar( home: string, proyecto: string, runId: string, pid: number, reglas: Reglas, ): Toma`
  - ← `src/cli/runs.ts:L102-L122` (despacharCola)
  - ← `src/cli/runs.ts:L63-L66` (handOver)
  - ← `src/store/lugares.test.ts` (archivo)
- L19-L19 · `type Lugar = z.infer<typeof lugarSchema>;`
````

- **Una línea por entrada**, en el orden de graft: `- <span> · \`<signature>\``.
- **La firma** se corta a 200 caracteres con `…` y los saltos de línea pasan a espacios.
- **Un llamador:** `  - ← \`<path>:<span>\` (<name>)`. Si `kind === "file"`, va
  `  - ← \`<path>\` (archivo)`.
- **Un archivo sin entradas,** por ejemplo uno nuevo que todavía no existe: la sección es el título
  y la línea `- (todavía no existe, o graft no le encontró definiciones)`.

**`marcarFueraDeAlcance`:** la regex de línea de llamador es
``/^  - ← `([^`:]+)(?::L\d+-L\d+)?`/``. Si ninguna entrada del alcance cubre la ruta (misma regla
`covers` de `src/tripwires/rules.ts`: igual o `entrada/` como prefijo), agrega
` · fuera de tu alcance` al final de la línea. El resto no cambia.

**`juntar`:**
- Con lo que entra en `maxChars` (por defecto 12.000), separando las secciones con una línea vacía.
- Si se cortó: agrega «(Se cortó en N de M archivos por tamaño: leé el resto con Read.)».
- Si hubo consultas omitidas: «(Quedaron K consultas de llamadores sin hacer: buscalos con Grep si
  hace falta.)».

**`contextoGraft`:**
1. Expande `archivos`: lo que termina en `/`, o que `git ls-files -- <ruta>` devuelve como más de un
   archivo, es una carpeta. Corta en 30.
2. Corre `skeleton` por archivo, de a 4 a la vez.
3. Junta los símbolos `function` y `class`, y corre `callers` hasta 40, de a 4 a la vez.
4. Arma las secciones con `seccionDe` y devuelve `juntar(...)`.
5. Ante cualquier error (graft no instalado, índice inexistente, JSON inválido) devuelve
   `(graft no pudo armar el contexto: <primera línea del error>)`. **Nunca tira.**
6. Un `callers` que sale con 1 porque el símbolo no está en el grafo cuenta como «sin llamadores», no
   como error.

**`llamadoresDe`:**
- Corre `callers <simbolo> --json --no-refresh`.
- Devuelve las rutas únicas y ordenadas de los `hits` de **todos** los `matches`, sin la ruta del
  propio símbolo. Si el nombre es ambiguo, es la unión: es lo conservador para la PR 09.
- Sale con 1 si el símbolo no está en el grafo: devuelve `[]`.
- Ante otro error, **sí tira** `GraftError`, una clase nueva de este módulo
  (`export class GraftError extends Error`, con `name = "GraftError"` y el mensaje de graft): la PR 09
  tiene que saber que no pudo comprobar.

**Salidas reales de ejemplo**, de graft 0.18 sobre el repo de flowrunner, para los fixtures de los
tests:

- `graft --dir idx skeleton src/store/lugares.ts repo --json --no-refresh`:
  `{"file":"src/store/lugares.ts","entries":[{"name":"Lugar","kind":"type","span":"L19-L19","signature":"type Lugar = z.infer<typeof lugarSchema>;"},{"name":"lugaresDir","kind":"function","span":"L21-L23","signature":"function lugaresDir(home: string, proyecto: string): string"}, …],"saved":{…}}`
- Un archivo inexistente: `{"file":"src/noexiste.ts","entries":[],"note":"no definitions indexed for this file"}`, con exit 0.
- `graft --dir idx callers tomarLugar repo --json --no-refresh`:
  `{"query":"tomarLugar","matches":[{"symbol":{"id":"src/store/lugares.ts#tomarLugar","name":"tomarLugar","kind":"function","path":"src/store/lugares.ts","span":"L95-L117"},"hits":[{"id":"src/cli/runs.ts#despacharCola","relation":"calls","depth":1,"name":"despacharCola","kind":"function","path":"src/cli/runs.ts","span":"L102-L122"}, …,{"id":"src/store/lugares.test.ts","relation":"calls","depth":1,"name":"lugares.test.ts","kind":"file","path":"src/store/lugares.test.ts","span":"L1-L91"}]}],"saved":{…}}`
- Un símbolo inexistente: sale con 1 y escribe en stderr
  `✗ no symbol "noExiste" in the graph — check spelling or run graft build`.
- `class TurnoAgotadoError`: los `hits` traen `relation: "references"`.

### `src/phases/implementar.ts`

- **Al principio de `implementar`** (la `PhaseFn`, línea 141 de main), antes de armar la cola de
  sub-tasks:

  ```ts
  try {
    await buildIndex(featureWt, graftIndex(run), deps.env);
  } catch (error) {
    emit({ tipo: "aviso", fase: "implementar", texto: `graft no pudo reconstruir el índice: ${firstLine(error)}; las sub-tasks arrancan sin su contexto` });
  }
  ```

  `firstLine` es local: el mensaje del error hasta el primer salto de línea.
- **En `runUnit`, antes de `runSession`:**

  ```ts
  const orientacion = await orientacionDe(run, plan, task, featureWt, deps.env);
  ```

  `orientacion` entra en `render("implementar", { …, orientacion })`.
- **Función nueva en el mismo archivo** (exportada para el test):

  ```ts
  /** Lo que la sub-task tiene que saber antes de empezar: lo ya integrado y su alcance según graft. */
  export async function orientacionDe(
    run: RunPaths,
    plan: Pick<Plan, "subtareas">,
    task: Subtask,
    featureWt: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const integradas = integradasText(readLog(run.dir).events, plan, task.id);
    const api = marcarFueraDeAlcance(
      await contextoGraft({ repo: featureWt, indexDir: graftIndex(run), archivos: task.alcance, env }),
      task.alcance,
    );
    return [
      "## Sub-tasks ya integradas en tu rama",
      "",
      integradas,
      "",
      "## Tu alcance hoy, según graft",
      "",
      api,
    ].join("\n");
  }

  /** Puro: «- ST-1 · <título> · <sha corto> · alcance: a, b», o «Ninguna todavía.». */
  export function integradasText(events: readonly RunEvent[], plan: Pick<Plan, "subtareas">, self: string): string;
  ```

- **Los imports nuevos:** `buildIndex` de `../graft/graft.ts`, `contextoGraft` y
  `marcarFueraDeAlcance` de `../graft/contexto.ts`, `graftIndex` de `./inputs.ts`, `readLog` de
  `../store/run-log.ts`, y los tipos `RunPaths` y `Plan`.

### `prompts/implementar.md`

Después de la línea `**Dependencias que podés agregar:** {{dependencias}}` y antes de `# Reglas`,
va esta sección nueva:

```md
# Lo que ya hay

Esto lo calculó flowrunner antes de que empezaras: lo que ya integraron otras sub-tasks y, para cada archivo de tu alcance, su API y quién usa lo que exporta. Partí de acá y leé con Read solo los rangos que necesites. Un llamador marcado «fuera de tu alcance» no lo podés cambiar: si cambiás la firma de lo que usa, lo rompés.

{{orientacion}}
```

## Tests (escribir primero y verlos fallar)

### `src/graft/contexto.test.ts` (nuevo, unitario, sin graft)

Usa como fixtures los JSON de ejemplo de arriba, armados a mano en el test.

1. **«la sección de un archivo lista su API y, bajo cada función, quién la llama desde otro
   archivo».** `seccionDe("src/store/lugares.ts", entradas, mapa)` da exactamente el bloque de
   ejemplo, con `- ← \`src/store/lugares.test.ts\` (archivo)` para un hit de `kind: "file"`. Falla
   hoy: el módulo no existe.
2. **«un archivo sin entradas dice que todavía no existe o no tiene definiciones».**
3. **«marcarFueraDeAlcance marca solo los llamadores cuya ruta no cubre el alcance».** Con alcance
   `["src/store/"]`: marca `src/cli/runs.ts:L102-L122` y no marca `src/store/lugares.test.ts`. Una
   línea de API que no es llamador no cambia.
4. **«juntar corta en el último archivo entero y dice cuántos quedaron afuera».** Con 3 secciones de
   100 caracteres y `maxChars: 250`: entran 2 y aparece «Se cortó en 2 de 3 archivos».
5. **«ninguna línea del contexto trae la instrucción de ahorro de tokens de graft».** Una salida de
   texto con `[graft] tokens saved … tell the user …` antes del JSON hace fallar el parseo, y el
   resultado es el texto de falla, no la línea. Documenta por qué se usa `--json`.

### `test/graft-contexto.int.test.ts` (nuevo, con el graft real)

Igual que `test/graft.int.test.ts`. Repo armado con `repoWith`:
- `src/a/uno.ts`: `export function uno(): number { return 1 }`;
- `src/b/dos.ts`: `import { uno } from "../a/uno.ts"; export const dos = () => uno() + 1;`;
- `src/a/tres.ts`: `export class Tres {}`.

Con `buildIndex` en un directorio temporal:

6. **«contextoGraft con el graft real: la API del alcance, quién la usa desde afuera y la carpeta
   expandida».** Con `archivos: ["src/a/"]`, el texto tiene `` ### `src/a/uno.ts` ``,
   `function uno(): number` y `` - ← `src/b/dos.ts `` (el span no se compara), y también
   `` ### `src/a/tres.ts` ``.
7. **«sin índice, contextoGraft no tira y lo dice en el texto».** Con `indexDir` inexistente,
   devuelve un texto que empieza con `(graft no pudo armar el contexto:`.
8. **«llamadoresDe devuelve los archivos que llaman, y nada para un símbolo que no existe».**
   `llamadoresDe(repo, idx, "uno", env)` da `["src/b/dos.ts"]`; con `"noExiste"`, da `[]`.

### `src/phases/implementar.test.ts`

9. **«cada sub-task arranca con lo integrado, la API de su alcance y sus llamadores fuera del
   alcance marcados».** Con `plannedRun`, un proyecto con `files` igual a los de arriba, y un plan
   de ST-1 (`["src/a/"]`) y ST-2 (`["src/c/"]`, `depende_de: ["ST-1"]`), con guiones que escriben un
   archivo cada uno:
   - el prompt de ST-1 (`sim.records[0]`) contiene `# Lo que ya hay`, `function uno(): number` y
     `` `src/b/dos.ts `` seguido de `fuera de tu alcance`;
   - el prompt de ST-2 contiene `- ST-1 · tarea ST-1 · ` con un sha corto.

   Falla hoy porque la sección no existe.
10. **«integradasText toma lo integrado desde la última aprobación, una vez por sub-task y sin la
    propia».** Unitario, con eventos armados a mano: dos `integrada` de ST-1 (antes y después de un
    `aprobado`) y una de ST-2. Para `self: "ST-2"`, da solo ST-1 con el sha posterior.

## Docs a actualizar

- **ADR nuevo, `docs/adr/0022-contexto-de-graft-calculado.md`:**
  - **Contexto:** el diagnóstico (graft como herramienta se sumó a las lecturas en planificar; en
    revisar, calculado, se usa).
  - **Decisión:** las decisiones 1 a 9.
  - **Consecuencia:** el contexto de las sub-tasks ahora viene de graft. ADR 0015 decía «las
    sub-tasks no usan graft», y sigue siendo cierto como herramienta.
  - En ADR 0015 no se edita nada.
- **`prompts/implementar.md`:** la sección de arriba.
- `README.md` y `skills/flowrunner/SKILL.md`: sin cambios.

## Verificación

```sh
pnpm vitest run --project unit src/graft src/phases/implementar.test.ts
pnpm vitest run --project integration test/graft-contexto.int.test.ts test/graft.int.test.ts
pnpm lint
pnpm test
pnpm test:integration
```

`graft` tiene que estar instalado, igual que para `test/graft.int.test.ts`. Si
`graft --version` falla, se detiene y se avisa (ver `00-guia.md`); el test no se saltea.

## Fuera de alcance

- Graft como herramienta MCP para las sub-tasks.
- El contexto del planificador: es de la PR 12, que usa `contextoGraft` sobre el worktree de la
  feature.
- Decidir qué se conserva en un replan: es de la PR 09, que usa `llamadoresDe`.
- Medir las lecturas: es de la PR 02.

## Riesgos y cómo se detectan

- **Tiempo antes de cada sub-task:** hasta 60 s en el peor caso. Se ve en el tiempo de implementar
  de `stats --runs`. Si sube más que lo que ahorra en turnos, se bajan los topes (decisión 5).
- **Ruido en el prompt:** el contexto puede tapar lo importante. El tope de 12.000 caracteres lo
  acota, y el aviso de corte le dice a la sub-task dónde seguir.
- **Índice viejo:** una sub-task que arranca después de que otra paralela integró ve el índice de
  la entrada a la fase. Las «sub-tasks ya integradas» lo compensan, porque salen del log en el
  momento.
- **Ambigüedad de nombres en `llamadoresDe`:** se usa la unión, que es lo conservador. La PR 09 lo
  sabe.
- **Graft no instalado:** `flowrunner doctor` ya lo chequea. El contexto dice que falló y la
  sub-task sigue como hoy.

## Conflicto con contratos

Ninguno que obligue a cambiar C6. Dos notas para el coordinador:

1. **El marcado «fuera de tu alcance» no entra en la firma de `contextoGraft`**, porque
   `ContextoOpts` no tiene `alcance`. Se resuelve con el export extra `marcarFueraDeAlcance`, que
   post-procesa el formato fijo de esta PR. Si la PR 12 quiere el mismo marcado, lo llama igual.
2. **Numeración de ADRs:** esta PR toma `0021` y la PR 03 toma `0020`. Si otra PR (05 a 14) agrega
   ADRs, va de `0022` en adelante, en el orden de las PRs. Si se implementan en otro orden, el
   número se corre al siguiente libre al momento de abrir la PR.
