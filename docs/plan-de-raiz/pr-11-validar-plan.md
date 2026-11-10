# PR 11 · El gate como herramienta del planificador

Rama: `perf/validar-plan` · Depende de: #70 (rutas protegidas dentro de `checkPlanShape`). Si la PR 09
ya está mergeada, también corre `checkConserva` · Tamaño: mediano

## Objetivo

- **El incidente:** 5 rechazos del gate en estos runs (ML-1, VF-5 y tres en VF-6). Todos eran de
  chequeos que no corren nada: un test existente sin declarar, llamadores fuera del alcance, un test
  declarado y no escrito. Cada rechazo es un intento más de planificar: entre US$ 0,7 y 2,8 y entre
  2,5 y 10 minutos.
- **La métrica:** en 5 runs nuevos, a lo sumo un rechazo del gate de afuera por algo que
  `validar_plan` chequea.

## Decisiones tomadas (no reabrir)

1. **Un servidor MCP en proceso**, como `httpServer` en `src/probar/herramientas.ts:198`:
   `createSdkMcpServer({ name: "gate", tools: [tool("validar_plan", …)] })`. El nombre completo de la
   herramienta es `mcp__gate__validar_plan`.
2. **La entrada es el plan, con el mismo schema que la salida estructurada:** `planSchema.shape`
   (`src/gates/plan.ts`). El planificador le pasa lo mismo que va a devolver.
3. **Corre solo los chequeos que no corren comandos.** Los fixers (lint y formato de los tests) y
   `checkCommandsFail` quedan solo en el gate de afuera: modifican archivos o tardan minutos.
4. **No hay dos copias de los chequeos.** Se extraen a una sola función, `chequeosEstaticos`, que usan
   el gate de afuera y la herramienta. El gate de afuera sigue siendo la red y el único que corre los
   tests en rojo.
5. **La herramienta nunca da error.** Devuelve texto: «ok …» o la lista de problemas. `isError` es
   siempre `false`, porque los problemas son información para el planificador, no una falla de la
   herramienta.
6. **Validar no es obligatorio para el gate.** Un plan que no se validó pasa igual por el gate de
   afuera, como hoy. El prompt pide validar; el código no lo exige.

## Cambios, archivo por archivo

### `src/gates/estaticos.ts` (nuevo)

```ts
import type { RepoConfig } from "../config/schemas.ts";
import type { Feature } from "../feature/feature.ts";
import { changesSince } from "../git/git.ts";
import { testsInScope, testsTouched, undeclared } from "./existente.ts";
import { callersOutOfScope } from "./llamadores.ts";
import { checkPlanShape, type Plan } from "./plan.ts";

export interface EstaticosInput {
  readonly plan: Plan;
  readonly feature: Feature;
  readonly worktree: string;
  /** Desde dónde se cuentan los tests escritos: base_sha, o inicioTests con la PR 09. */
  readonly desde: string;
  readonly config: RepoConfig;
  readonly env: NodeJS.ProcessEnv;
  /** Si el comando de un criterio es el verify del repo (`isVerifyCommand`). */
  readonly esVerify: (comando: string) => boolean;
}

/**
 * Los problemas del plan que se ven sin correr nada, en el orden del gate de hoy. Los usan el gate de
 * afuera de planificar y la herramienta `validar_plan`.
 */
export async function chequeosEstaticos(input: EstaticosInput): Promise<string[]>;
```

**Qué devuelve, en este orden**, tomado tal cual de `planificar.ts`, líneas 193–221 de hoy:

1. `checkPlanShape(plan, feature, worktree, config)`. Con #70 incluye las rutas protegidas. **Con la
   PR 14** lleva el quinto parámetro: `checkPlanShape(plan, feature, worktree, config, esVerify)`.
2. `await callersOutOfScope(plan, worktree, env)`.
3. `changes = await changesSince(worktree, desde, env)` y `written` = los de estado distinto de
   `borrado`. Si `written` está vacío: `"planificar no escribió ningún test"`.
4. Por cada `path` de
   `undeclared([...testsTouched(changes, config.tests_globs), ...testsInScope(plan.subtareas, worktree, config.tests_globs)], plan.cambia_lo_existente)`:
   el mismo mensaje de hoy, `el plan cambia ${path}, un test que ya existe, y no lo declara en cambia_lo_existente. …`.
5. Por cada `declared` de `plan.tests` que no está en `written`: `el plan declara el test ${declared}, pero no está escrito`.

**Con la PR 09 mergeada**, el input suma un campo opcional, `conserva?: ConservaInput`. Si viene,
después del punto 5 se agrega `...checkConserva(conserva)`.

**`esVerify` va en el input desde esta PR**, aunque `checkPlanShape` todavía no lo use:

- si la PR 14 se mergea después, solo cambia la línea 1 y, en planificar, aplica `delRun` al plan
  antes de llamar a `chequeosEstaticos`;
- si la PR 14 ya está mergeada, esta PR lo implementa así desde el principio.

### `src/phases/planificar.ts`

- **El bloque de las líneas 193–221** (de `const problems = [` hasta el chequeo «declara el test …
  pero no está escrito») pasa a:

  ```ts
  const esVerify = (comando: string) => isVerifyCommand(config, comando);
  const problems = await chequeosEstaticos({
    plan, feature, worktree, desde: prep.base_sha, config, env: deps.env, esVerify,
  });
  const written = (await changesSince(worktree, prep.base_sha, deps.env))
    .filter((c) => c.status !== "borrado")
    .map((c) => c.path);
  for (const f of await runFixers(worktree, config, written, deps.env)) {
    problems.push(`${f.falla} en los tests: ${f.detalle}`);
  }
  ```

  Lo que sigue, `if (problems.length === 0) { … checkCommandsFail … }`, no cambia, salvo usar
  `esVerify` como `skip`. **El orden de los mensajes cambia:** hoy el problema de los fixers va antes
  de «declara el test … pero no está escrito», y ahora va después. Ningún test existente compara el
  motivo entero: si alguno lo hace, se actualiza solo el orden esperado.
- **Con la PR 14 mergeada:** el `plan` que se pasa es `delRun(result.output, esVerify)`, el mismo que
  escribe `writePlanArtifacts`.
- **Con la PR 10 mergeada:** este bloque vive en `gateYCierre`.
- **Con la PR 09 mergeada:** `desde` es `inicioTests`, el `HEAD` después de rearmar, tanto en el gate
  como en el cálculo de `written`. En `validarPlanServer`, `desde` es el `HEAD` del worktree al abrir
  la sesión, que ya tiene las candidatas: así lo que escribió el planificador no se confunde con el
  código conservado.
- **La sesión** (líneas 139–170) suma el servidor y la herramienta:

  ```ts
  mcpServers: {
    graft: graftMcpServer(worktree, graftIndex(run), deps.env),
    gate: validarPlanServer({ feature, worktree, desde: prep.base_sha, config, env: deps.env, esVerify }),
  },
  ```

- **El hook de planificar** (líneas 115–138) suma `mcp: [VALIDAR_PLAN_TOOL]`. Hoy `HookPolicy.mcp`
  ya existe (`src/tripwires/hook.ts:28`) y `decide` lo permite (línea ~90).

### `src/gates/validar-plan.ts` (nuevo)

```ts
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { planSchema } from "./plan.ts";
import { chequeosEstaticos, type EstaticosInput } from "./estaticos.ts";

export const VALIDAR_PLAN_TOOL = "mcp__gate__validar_plan";

/** El texto que ve el planificador. Exportado para el test. */
export function respuestaValidar(problemas: readonly string[]): string {
  return problemas.length === 0
    ? "ok: el plan pasa los chequeos que no corren nada. Al devolverlo, el gate además corre el comando de cada criterio, y tiene que fallar."
    : `El plan tiene ${String(problemas.length)} ${problemas.length === 1 ? "problema" : "problemas"}:\n- ${problemas.join("\n- ")}\nCorregilos y volvé a validar antes de devolver el plan.`;
}

export function validarPlanServer(ctx: Omit<EstaticosInput, "plan">): McpServerConfig {
  return createSdkMcpServer({
    name: "gate",
    tools: [
      tool(
        "validar_plan",
        "Corre sobre el plan los chequeos del gate que no ejecutan nada: forma, alcances que se pisan, rutas protegidas, llamadores fuera del alcance, tests existentes sin declarar y tests declarados sin escribir. Pasale el mismo JSON que vas a devolver.",
        planSchema.shape,
        async (plan) => {
          const problemas = await chequeosEstaticos({ ...ctx, plan });
          return { content: [{ type: "text", text: respuestaValidar(problemas) }], isError: false };
        },
      ),
    ],
  });
}
```

- **Con la PR 14 mergeada,** el handler aplica `delRun(plan, ctx.esVerify)` antes de
  `chequeosEstaticos`, igual que el gate de afuera. Así el planificador no ve un problema que el gate
  de afuera no ve.
- Si `planSchema.shape` no compila como `AnyZodRawShape` por los `.describe()`, se pasa
  `planSchema.shape` con el tipo del SDK sin tocar el schema. **No** se arma un schema paralelo.

### `prompts/planificar.md`

Antes del párrafo «En `plan` escribí el plan en Markdown…», un paso 8:

```
8. Antes de devolver el plan, pasalo por `validar_plan` con el mismo JSON que vas a devolver. Si
   devuelve problemas, corregí el plan o los tests y validá de nuevo. No devuelvas un plan que
   `validar_plan` rechaza: el gate de afuera corre los mismos chequeos y lo va a rechazar igual.
```

## Tests (escribir primero y verlos fallar)

**`src/gates/estaticos.test.ts`** (nuevo):

1. **«los chequeos estáticos devuelven los mismos problemas que hoy daba el gate, en su orden»:** un
   worktree con un test existente reescrito y sin declarar, y un test declarado sin escribir.
   Devuelve exactamente los dos mensajes de hoy, en ese orden. **Hoy falla:** el módulo no existe.

**`src/gates/validar-plan.test.ts`** (nuevo):

2. **«sin problemas responde ok; con problemas, la lista y que vuelva a validar»:** sobre
   `respuestaValidar`, con 0, 1 y 2 problemas. Afirma el singular y el plural, y que
   `isError` nunca es `true`, llamando al handler a través de `validarPlanServer` con un plan
   válido y con uno inválido.

**`src/phases/planificar.test.ts`:**

3. **«la sesión del planificador recibe validar_plan, y el hook la permite»:**
   - `Object.keys(records[0].options.mcpServers)` es `["graft", "gate"]`;
   - un guion que llama a `mcp__gate__validar_plan` tiene `decision: "allow"` en `records[0].decisions`.

   **Hoy falla:** solo está `graft`, y el hook rechaza la herramienta con «no está permitida en
   planificar».
4. **El existente** «el motivo del intento anterior y una instrucción de changes llegan al prompt»
   afirma `toEqual(["graft"])` sobre `mcpServers`: se actualiza a `["graft", "gate"]`. Es un cambio de
   contrato de la sesión, no un test debilitado.
5. **Los existentes del gate** («reescribir un test existente sin declararlo no pasa el gate», «un
   plan cuyo criterio ya pasa se rechaza…») tienen que pasar sin cambios: prueban que el gate de
   afuera sigue igual.

## Docs a actualizar

- **`prompts/planificar.md`:** ver arriba.
- **ADR:** no hace falta. No cambia qué se acepta, solo cuándo lo ve el planificador. El ADR 0011
  (graft como único MCP de planificar) suma una línea en «Consecuencias»: «Desde la PR 11, planificar
  también tiene el servidor `gate`, con `validar_plan`».
- **README y SKILL.md:** sin cambios.

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

## Fuera de alcance

- Que la herramienta corra los comandos de los criterios o los fixers.
- Exigir que el plan se haya validado antes de aceptarlo.
- Contar cuántas veces se validó: lo mide `stats --runs` (PR 02) por las llamadas a
  `mcp__gate__validar_plan`.

## Riesgos y cómo se detectan

- **El planificador valida en cada cambio y suma turnos.** El prompt pide validar antes de devolver,
  no en cada paso. `stats --runs` muestra cuántas llamadas hay por sesión; si pasan de 3, se ajusta el
  prompt.
- **La herramienta y el gate de afuera divergen.** Es una sola función, `chequeosEstaticos`, y la
  cubren los tests 1 y 5. La normalización de la PR 14 (`delRun`) se aplica en los dos lugares, como
  dice esta spec.
- **`changesSince` se llama mientras el planificador escribe.** La herramienta lee el estado del
  momento. Si el planificador escribe después de validar, el gate de afuera lo ve igual.
