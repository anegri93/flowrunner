# PR 14 · Lo imposible, antes de implementar

Rama: `feat/imposibles-antes` · Depende de: #70 (`protectedMentions` y `avisos` en `feature check`),
#71 (verificar excluye los criterios de verify) · Tamaño: chico

## Objetivo

- **El problema:** las tres trabas de VF-6 se vieron recién en verificar, después de implementar:
  1. **`CLAUDE.md`:** lo frena #70, en `feature check` y en el gate.
  2. **`npm run mac`:** un criterio usaba un script que no existía en `package.json`, y la sub-task
     que lo tenía que crear no pudo tocar `package.json`.
  3. **AC-12, «verify.sh en verde»:** estaba asignado a ST-6, que no era dueña de lo que se rompía.
     #71 hace que verificar lo atribuya por archivo, pero el plan sigue obligando a inventarle una
     dueña.

  Y el test de documentación de VF-6 solo buscaba el texto «npm run mac» en el doc, sin comprobar
  que el script existiera.
- **Métrica:** las tres trabas de VF-6 aparecen en `feature check` o en el gate del plan, antes de
  implementar. Se comprueba con los tests de abajo, armados con los textos de VF-6.

## Decisiones tomadas (no reabrir)

1. **Los dos chequeos nuevos de `feature check` son avisos**, no errores, igual que los de #70: se
   suman a `avisos`.
   - **Scripts:** un criterio que nombra un script que hoy no existe puede estar pidiendo crearlo.
   - **Documentación:** un criterio sobre documentación puede ser legítimo.

   El aviso dice qué hacer en cada caso.
2. **Scripts:** solo se mira el `package.json` de la raíz del repo del proyecto. Sin `package.json`,
   o si no se puede leer, no hay chequeo ni aviso. Los monorepos con `--prefix` o `--filter` quedan
   fuera (ver Riesgos).
3. **Qué cuenta como «nombra un script»**, sobre el texto de cada criterio:
   - `npm run <s>`, `npm run-script <s>`, `npm test` (→ `test`), `npm start` (→ `start`);
   - `pnpm <s>` y `pnpm run <s>`;
   - `yarn <s>` y `yarn run <s>`.

   Para pnpm y yarn, la palabra no cuenta si es un comando propio del gestor:

   ```
   add install i remove rm uninstall update up upgrade exec dlx create init link unlink list ls
   outdated why store env patch publish pack audit import rebuild prune fetch deploy setup config
   root bin licenses doctor server self-update dedupe approve-builds info workspaces workspace
   cache set plugin npm constraints explain node version run
   ```

   `test` y `start` sí cuentan como script en los tres gestores. El nombre del script es
   `[A-Za-z][\w:.-]*`: empieza con una letra, así una opción como `--filter` no cuenta como script.
4. **Qué cuenta como «se comprueba en documentación»:** el texto del criterio nombra un archivo
   `.md`, `.mdx`, `.rst`, `.adoc` o `.txt`, la palabra `README`, o una ruta que empieza con `docs/`
   o `doc/`. No cuenta si el único archivo nombrado es protegido (`CLAUDE.md`, `AGENTS.md`): para
   esos ya avisa `protectedMentions`, más fuerte. Es una heurística de palabras: no lee el test ni
   el código.
5. **Un criterio de verify es «del run»:** su `subtarea` en `ac-map.json` es el valor reservado
   **`run`**, exportado como `CRITERIO_DEL_RUN`. No choca con los ids (`^ST-\d+$`) y es un `string`
   como hoy, así que el formato de `ac-map.json` no cambia.
   - **Implementar** filtra por `c.subtarea === task.id`, así que nunca le llega.
   - **Verificar** ya lo excluye por `isVerifyCommand` (#71).
   - **El gate** ya no lo corre en rojo (`skip`).
6. **flowrunner lo corrige solo.** Si el planificador asigna un criterio de verify a una sub-task,
   planificar lo pasa a `run` antes del gate (`delRun`). No hay rechazo: rechazar costaría un
   reintento de planificar por algo que flowrunner puede arreglar.
7. **Solo un criterio cuyo comando es el verify del repo puede ser `run`.** Cualquier otro con `run`
   es un problema del gate.

## Cambios, archivo por archivo

Las referencias son a `main` en `e78201c`, con #70 y #71 encima.

### `src/cli/feature-check.ts`

- **Funciones nuevas, exportadas y puras:**

  ```ts
  /** Los scripts de un package.json, o undefined si no hay o no se lee. */
  export function scriptsDe(packageJsonText: string | undefined): Record<string, string> | undefined;

  /** Avisos para los criterios que usan un script que hoy no existe. */
  export function scriptsInexistentes(
    feature: Feature,
    scripts: Record<string, string> | undefined,
  ): string[];

  /** Avisos para los criterios que solo se comprueban leyendo documentación. */
  export function soloDocumentacion(feature: Feature): string[];
  ```

- **Los textos, exactos:**
  - `scriptsInexistentes`, uno por cada script faltante de cada criterio:
    `${c.id} usa \`${comando}\`, y el package.json del repo no tiene el script "${s}". Si la feature lo crea, el plan tiene que poner package.json en el alcance de una sub-task; si no, el criterio no se puede cumplir`,
    donde `comando` es el texto que matcheó, como `npm run mac`.
  - `soloDocumentacion`, uno por criterio:
    `${c.id} se comprueba en documentación (${lo que matcheó}): un test de eso solo busca texto y no prueba que lo documentado funcione. Si documenta un comando, un script o un endpoint, sumá un criterio que lo ejecute`.
- **En `checkFeature`:**

  ```ts
  const pkg = join(project.path, "package.json");
  const scripts = scriptsDe(existsSync(pkg) ? readFileSync(pkg, "utf8") : undefined);
  // avisos:
  avisos: [
    ...protectedMentions(feature),
    ...scriptsInexistentes(feature, scripts),
    ...soloDocumentacion(feature),
  ],
  ```

### `src/gates/plan.ts`

- **Constante:** `export const CRITERIO_DEL_RUN = "run";`.
- **En `planSchema.criterios[].subtarea`** (línea 70):
  `.describe("la sub-task que cubre el criterio: ST-n, o run si su comando es el verify del repo")`.
- **Función nueva:**

  ```ts
  /** Los criterios de verify pasan a ser del run, sin importar a qué sub-task los asignó el plan. */
  export function delRun<P extends Pick<Plan, "criterios">>(
    plan: P,
    esVerify: (comando: string) => boolean,
  ): P {
    return {
      ...plan,
      criterios: plan.criterios.map((c) =>
        esVerify(c.comando) ? { ...c, subtarea: CRITERIO_DEL_RUN } : c,
      ),
    };
  }
  ```

- **`checkPlanShape`** suma un quinto parámetro, con default para no romper a quien no lo pasa:
  `esVerify: (comando: string) => boolean = () => false`. En el ciclo de `feature.criterios`
  (líneas 157 a 162 en #70), antes del chequeo de existencia:

  ```ts
  else if (entry.subtarea === CRITERIO_DEL_RUN) {
    if (!esVerify(entry.comando))
      problems.push(
        `${ac.id} es del run, pero solo un criterio cuyo comando es el verify del repo puede serlo: asignalo a la sub-task que lo cubre`,
      );
  } else if (!idSet.has(entry.subtarea)) …
  ```

### `src/phases/planificar.ts`

- **Línea 175**, `const plan = result.output;`, pasa a:

  ```ts
  const esVerify = (comando: string) => isVerifyCommand(config, comando);
  const plan = delRun(result.output, esVerify);
  ```

- **Línea 197**, `checkPlanShape(plan, feature, worktree, config)`, pasa a
  `checkPlanShape(plan, feature, worktree, config, esVerify)`.
- **`checkCommandsFail`** (línea 228) ya recibe el `skip` con `isVerifyCommand`: usar `esVerify`.
- `writePlanArtifacts` escribe el `plan` normalizado, así que `ac-map.json` queda con `run`.

### Lo que muestra el criterio del run

Donde hoy se imprime `→ ${c.subtarea}`, un criterio con `subtarea === "run"` muestra
`→ del run (lo comprueba verificar)`:

- `src/cli/approval.ts:155` (`describePlan`);
- `src/cli/etapa.ts:111`;
- `orca/src/runs.ts:519` (`planMarkdown`). Orca no importa de `src/`: compara con el literal
  `"run"`.

### `prompts/planificar.md`

- **Al final del paso 4:** «Esos criterios son del run, no de una sub-task: en `subtarea` poné
  `run`. Si los asignás a una sub-task, flowrunner los pasa a `run` igual.»

### `skills/flowrunner/SKILL.md`

- **En el paso 5 de «Escribir una feature»** (el de `feature check`, con el texto de #70), sumar los
  avisos nuevos a la lista de lo que se muestra antes de lanzar:
  - un criterio que usa un script que no existe;
  - un criterio que se comprueba solo en documentación. Para este, proponerle a la persona un
    criterio que ejecute lo documentado.

## Tests

Escribirlos primero y verlos fallar.

| Archivo | Nombre exacto | Qué afirma | Por qué falla hoy |
|---|---|---|---|
| `src/cli/feature-check.test.ts` | `avisa un npm run, pnpm o yarn de un script que no está en package.json` | con criterios ``AC-1: `npm run mac` levanta el trabajador`` (el de VF-6), ``AC-2: `pnpm typecheck` pasa``, ``AC-3: `pnpm install` deja node_modules``, ``AC-4: `npm test` pasa`` y ``AC-5: `yarn build` compila``, y `scripts = { test: "vitest", typecheck: "tsc" }`: hay dos avisos, uno por AC-1 (`mac`) y uno por AC-5 (`build`), con el texto exacto | la función no existe |
| `src/cli/feature-check.test.ts` | `sin package.json no hay aviso de scripts` | `scriptsInexistentes(feature, undefined)` da `[]`, y `scriptsDe("{roto")` da `undefined` | la función no existe |
| `src/cli/feature-check.test.ts` | `avisa un criterio que se comprueba solo en documentación, salvo los archivos protegidos` | `AC-1: docs/despliegue.md explica npm run mac` (VF-6) y `AC-2: el README nombra el comando` dan un aviso cada uno; `AC-3: CLAUDE.md lista los comandos` no da este aviso (lo da `protectedMentions`); `AC-4: GET /pedidos devuelve 200` no da ninguno | la función no existe |
| `src/gates/plan.test.ts` | `un criterio que corre el verify del repo es del run y no necesita sub-task` | un plan con `{ id: "AC-2", comando: "./.flowrunner/verify.sh", subtarea: "run" }` y `esVerify` que reconoce ese comando no tiene problemas | `run` no existe como sub-task: «AC-2 apunta a run, que no existe» |
| `src/gates/plan.test.ts` | `solo un criterio que corre el verify puede ser del run` | `{ id: "AC-1", comando: "node tests/ac1.mjs", subtarea: "run" }` da el problema exacto de arriba | el texto es otro |
| `src/gates/plan.test.ts` | `delRun pasa los criterios de verify a run y deja los demás` | sobre un plan con AC-12 (`./.flowrunner/verify.sh`, `ST-6`) y AC-1 (`node tests/ac1.mjs`, `ST-1`), AC-12 queda `run` y AC-1, `ST-1` | la función no existe |
| `src/phases/planificar.test.ts` | `un criterio de verify que el planificador asignó a una sub-task queda del run en ac-map` | con una feature de dos criterios y un plan simulado con AC-2 en `./.flowrunner/verify.sh` y `ST-1`: el plan pasa el gate y `readPlan(run).criterios` tiene AC-2 con `subtarea: "run"` | queda `ST-1` |

- **El de planificar:** el `makeProject` de `plannedRun` ya deja un `.flowrunner/verify.sh` que sale
  0, así que el gate saltea AC-2 con el `skip`. El sim devuelve el plan con `output`, como el
  `goodPlan` de `planificar.test.ts:26`.
- **Implementar no lleva test nuevo:** filtra por `c.subtarea === task.id`, así que un criterio
  `run` ya no le llega hoy. Un test ahí pasaría también antes del cambio. Lo que cambia es que
  planificar escribe `run`, y eso lo cubre el test de planificar.

## Docs a actualizar

- `skills/flowrunner/SKILL.md` y `prompts/planificar.md`: arriba.
- **`README.md`:** en la parte de escribir la feature, una línea: «`feature check` avisa si un
  criterio usa un script que no existe o si solo se comprueba leyendo documentación.»
- Sin ADR.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
pnpm orca:test   # «lee solo los runs del proyecto enfocado…» ya falla en main; el resto en verde
```

## Fuera de alcance

- Leer el `package.json` de los paquetes de un monorepo.
- Leer el test de un criterio para ver si de verdad solo busca texto: lo hace revisar desde #70.
- Convertir los avisos en errores.

## Riesgos y cómo se detectan

- **Falso positivo de scripts:** un criterio que nombra un script que la feature va a crear. El
  aviso lo dice («si la feature lo crea…») y no frena nada. Si en la fase 6 la persona lo ignora
  siempre, se baja la prioridad del texto.
- **Monorepos:** `npm --prefix app run x` o `pnpm --filter web build` no matchean, porque la regex
  pide `npm run` seguido del nombre, y en pnpm el nombre tiene que empezar con una letra, así que
  `--filter` no cuenta. No hay aviso de más. El riesgo es un aviso de menos, nunca uno falso.
- **Un plan viejo con un criterio de verify en una sub-task:** sigue funcionando, porque implementar
  y verificar ya lo trataban por `isVerifyCommand`. `run` solo aparece en los planes nuevos.
- **La PR 11 (`validar_plan`) llama a `checkPlanShape`:** tiene que pasarle el mismo `esVerify` y
  aplicar `delRun` antes, o el planificador va a ver un problema que el gate de afuera no ve.
