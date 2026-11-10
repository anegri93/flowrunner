# PR 07 · Reintentos solo para la infraestructura, y más largos para la red

Rama: `fix/reintentos-de-red` · Depende de: PR 05 (`halt` arma las opciones) · Tamaño: chico

## Objetivo

- **Corte de red.** El primer VF-6 (`VF-6-20261109-210425`) murió en preparar en 25 segundos:
  `git fetch` falló tres veces con «Could not resolve host: github.com». Hoy una falla de
  infraestructura se reintenta 2 veces, a los 5 y a los 20 s (`MAX_INFRA_RETRIES` en
  `src/engine/engine.ts:31` e `infraBackoffMs` en `src/runner/runner.ts:9`): demasiado corto para un
  corte de red.
- **Credencial rechazada.** En VF-3 y VF-4 la credencial se rechazó tres veces. El run se detuvo
  bien, como entorno, pero su «para seguir» decía `flowrunner resume`, y retomar sin arreglar la
  credencial vuelve a fallar.

**Métrica:** ningún run muere por un corte de red de menos de 7 minutos, y una credencial rechazada
detiene con `flowrunner doctor` como primera opción.

## Decisiones tomadas (no reabrir)

- **Qué es una falla de red** lo decide el texto del motivo, con una función pura y una lista
  cerrada de patrones. No hay clase nueva en `outcomeSchema`: así ninguna fase cambia cómo propaga
  `clase`.
- **Red:** 3 reintentos, a los 30 s, 2 min y 5 min, cerca de 7,5 minutos en total. Después detiene
  con el motivo y `resume`.
- **El resto de la infraestructura:** como hoy, 2 reintentos a los 5 y 20 s.
- **Una credencial rechazada** sigue siendo `entorno` (detiene sin reintentar), pero su `siguiente`
  pasa a `flowrunner doctor`, y las opciones quedan `[doctor, resume, abort]`.
- **Los dos textos de credencial** (`TOKEN_REJECTED` y `LOGIN_MISSING`, en
  `src/agent/session.ts:111-114`) se mudan a un módulo puro que leen la sesión y el engine. Así el
  engine los reconoce sin comparar strings sueltos.

## Cambios, archivo por archivo

### `src/engine/motivos.ts` (nuevo, puro, sin imports)

```ts
// Motivos que el engine reconoce por su texto: no cambian la clase del outcome, cambian cómo seguir.

export const TOKEN_REJECTED =
  "Claude rechazó la credencial de la sesión: revisá el token del Keychain con `flowrunner doctor`";
export const LOGIN_MISSING =
  "Claude Code no encontró tu sesión: corré `claude auth status` en la terminal y, si no hay sesión, abrí `claude` y corré `/login`";

export const esCredencial = (motivo: string): boolean =>
  motivo.includes(TOKEN_REJECTED) || motivo.includes(LOGIN_MISSING);

/** Cortes de red de git, de Node y de la API de Anthropic. Una lista cerrada: un rojo de código no entra. */
const RED: readonly RegExp[] = [
  /Could not resolve host/i,
  /unable to access '[^']*':/i,
  /Failed to connect to/i,
  /Connection (?:timed out|refused|reset)/i,
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)\b/,
  /socket hang up/i,
  /\bfetch failed\b/i,
  /overloaded_error/i,
  /\bAPI Error: (?:5\d\d|529)\b/,
  /error connecting to api\.github\.com/i,
];

export const esFallaDeRed = (motivo: string): boolean => RED.some((r) => r.test(motivo));
```

### `src/agent/session.ts`

- **Las líneas 111 a 114** se reemplazan por
  `import { LOGIN_MISSING, TOKEN_REJECTED } from "../engine/motivos.ts";`. El resto no cambia.

### `src/engine/engine.ts`

- **Constantes nuevas**, junto a `MAX_INFRA_RETRIES` (línea 31):

```ts
/** Un corte de red dura más que un error de otra infraestructura: 30 s, 2 min y 5 min. */
export const MAX_NETWORK_RETRIES = 3;
```

- **`onOutcome`, `falla`:**
  - **`entorno` o `invariante`** (línea 168): pasa a
    `return halt(state, `${fase}: ${outcome.motivo}`, esCredencial(outcome.motivo) ? "flowrunner doctor" : undefined);`.
  - **`infra`** (líneas 171 a 180):

```ts
if (outcome.clase === "infra") {
  const infra = state.infra + 1;
  const red = esFallaDeRed(outcome.motivo);
  const max = red ? MAX_NETWORK_RETRIES : MAX_INFRA_RETRIES;
  if (infra > max) {
    return halt(
      { ...state, infra },
      red
        ? `${fase}: sin conexión después de ${String(max)} reintentos (30 s, 2 min y 5 min): ${outcome.motivo}. Cuando vuelva la red, retomá el run`
        : `${fase}: falla de infraestructura repetida: ${outcome.motivo}`,
    );
  }
  return { ...state, infra };
}
```

- **`opcionesDe`** (de la PR 05), fila «cualquier otro»: si `state.halt.siguiente` no es
  `flowrunner resume R`, las opciones son `[siguiente, resume R, abort R]`; si no,
  `[resume R, abort R]`. Para `flowrunner doctor`, el texto de `que` es «revisá la credencial; después
  retomá el run».

### `src/runner/runner.ts`

```ts
/** Espera antes de reintentar: una falla de red, 30 s, 2 min y 5 min; otra infraestructura, 5 s y 20 s. */
export function infraBackoffMs(retry: number, red = false): number {
  if (red) return [30_000, 120_000, 300_000][Math.min(Math.max(retry, 1), 3) - 1] ?? 300_000;
  return 5_000 * 4 ** Math.max(0, retry - 1);
}
```

- **En `runUntilStop`**, la línea del `await deps.sleep(...)`:
  `await deps.sleep(infraBackoffMs(state.infra + 1, esFallaDeRed(outcome.motivo)));`.

### `src/notify/estado.ts`

Sin cambios: el aviso de `detenido` (PR 05) ya muestra la primera opción, que para una credencial es
`flowrunner doctor`.

## Tests (escribir primero y verlos fallar)

`src/engine/motivos.test.ts` (nuevo):

| Nombre | Afirma |
|---|---|
| «reconoce los cortes de red de git, de Node y de la API» | verdaderos: el motivo literal del primer VF-6, `git fetch --quiet origin falló: fatal: unable to access 'https://github.com/anegri93/videoFactory.git/': Could not resolve host: github.com`; `la sesión implementar-ST-1-1 falló: getaddrinfo ENOTFOUND api.anthropic.com`; `la sesión planificar-1 falló: API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}`; `gh pr create falló: error connecting to api.github.com` |
| «un rojo de código o de setup no es de red» | falsos: `src/a.ts:512:3 error TS2322`; `el setup \`pnpm install\` salió 1: ERR_PNPM_OUTDATED_LOCKFILE`; `AC-1 sigue en rojo: status 500 esperado, llegó 200` |
| «reconoce las dos credenciales» | `esCredencial` es verdadero con `TOKEN_REJECTED` y con `LOGIN_MISSING`, y falso con otro motivo de entorno |

`src/engine/engine.test.ts`:

| Nombre | Afirma | Por qué falla hoy |
|---|---|---|
| «un corte de red se reintenta tres veces y a la cuarta detiene, con resume» | tres `falla infra` con el motivo del primer VF-6 dejan `en_curso` con `infra` en 3; la cuarta da `detenido`, con el motivo que contiene «sin conexión después de 3 reintentos» y `opciones[0]` en `flowrunner resume R` | hoy detiene a la tercera |
| «una falla de infraestructura que no es de red sigue deteniendo a la tercera» | el comportamiento de hoy, con un motivo como «la sesión terminó sin resultado» | pasa hoy: fija lo que no cambia |
| «una credencial rechazada detiene enseguida, con flowrunner doctor primero» | `falla entorno` con `TOKEN_REJECTED`: `detenido`, `siguiente` en `flowrunner doctor` y las opciones `[doctor, resume R, abort R]` | hoy `siguiente` es `resume` |

`src/runner/runner.test.ts`:

- «el runner espera 30 s, 2 min y 5 min entre reintentos de red». Un registro donde preparar devuelve
  cuatro veces `falla infra` con «Could not resolve host» y un `deps.sleep` que anota sus argumentos:
  anota `[30_000, 120_000, 300_000]` y el run termina `detenido`. **Por qué falla hoy:** anota
  `[5_000, 20_000]`.
- El test de hoy del backoff de infraestructura (5 y 20 s), si existe, queda igual.

`src/agent/session.test.ts`:

- Sin tests nuevos. Los que hoy afirman el texto de la credencial siguen pasando, porque el texto es el
  mismo y solo cambió de archivo.

## Docs a actualizar

- **`docs/adr/0023-detenerse-y-preguntar.md`** (de la PR 05): un párrafo «La infraestructura sí
  reintenta», con el caso del primer VF-6 y los tiempos. No hace falta un ADR propio.
- **`README.md`:** en la sección de problemas comunes, si existe, o en la de la PR 05: «un corte de
  red se reintenta durante unos 7 minutos; una credencial rechazada te pide `flowrunner doctor`».

## Verificación

```sh
pnpm lint
pnpm test
pnpm test:integration
```

## Fuera de alcance

- Reintentar dentro de la sesión del SDK, o reanudarla después de un corte: un reintento de la fase
  arranca una sesión nueva, como hoy.
- Detectar que la red volvió y retomar solo: lo hace la persona con `resume`.
- Los reintentos de `gh` dentro de `entregar` y `aprender`: siguen siendo `infra`, y ahora, si su
  motivo es de red, esperan más.

## Riesgos y cómo se detectan

- **Un falso positivo de red** (un rojo de código cuyo texto matchea) cuesta 7,5 minutos de espera
  antes de detenerse. Lo acota la lista cerrada: el test «un rojo de código o de setup no es de red»
  fija los casos parecidos. Con un caso nuevo, se suma un negativo a ese test antes de tocar `RED`.
- **Mover las constantes de credencial** rompe a quien las importe de `session.ts`. Con
  `git grep -n "TOKEN_REJECTED\|LOGIN_MISSING"`, hoy solo las usa `session.ts`.

## Conflicto con contratos

La fila «cualquier otra detención» de C1 dice `resume` (o el `siguiente` de `halt`) y `abort`. Con
`siguiente = flowrunner doctor` quedan tres opciones: `doctor`, `resume` y `abort`. Cumple «nunca
vacía, y `siguiente` es la primera». Es el punto 3 de los conflictos de la PR 05.
