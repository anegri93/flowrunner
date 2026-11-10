# PR 01 · El flowrunner que corre no es el que se desarrolla

Rama: `feat/instalacion-separada` · Depende de: nada (es la primera) · Tamaño: mediano

## Objetivo

ML-1 falló 3 veces en revisar con «a la plantilla revisar le faltan: rechazos». El comando
`flowrunner`, el `tick` de launchd y el plugin de Orca corren todos desde el checkout de desarrollo,
y alguien cambió de rama ahí con el run en curso. El proceso del run lee los prompts del disco en
cada sesión, así que leyó un prompt de otra rama.

Hoy apuntan al checkout:

- `~/.local/bin/flowrunner` es un link a `…/flowrunner/bin/flowrunner.js`;
- `~/Library/LaunchAgents/com.flowrunner.tick.plist` lleva esa misma ruta;
- `ORCA_PLUGIN_DIR` sale de `import.meta.dirname` (`src/cli/orca.ts:7`).

**Métrica:** cambiar de rama en el checkout de desarrollo no cambia nada de un run en curso. Ningún
run falla por un prompt o un código que no corresponde a su versión.

## Decisiones tomadas (no reabrir)

- **Dónde vive el flowrunner que corre:** en `APP_DIR = join(flowrunnerHome(env), "app")`. Es un
  worktree `--detach` del mismo repo de flowrunner, en `origin/main`, con su propio `node_modules`.
- **Una sola puerta de entrada,** `flowrunner self-update`: crea `APP_DIR` si no existe o lo mueve a
  `origin/main` si existe, instala dependencias y re-apunta los tres puntos de entrada. Se puede
  correr desde el checkout de desarrollo o desde la app.
- **Re-apuntar reusa los instaladores que ya existen,** corridos **desde el código de `APP_DIR`**:
  `self-update` ejecuta `node <APP_DIR>/bin/flowrunner.js _reapuntar`. Así `BIN`,
  `ORCA_PLUGIN_DIR` y la skill salen de `APP_DIR` sin cambiar cómo se calculan.
- **Se niega si hay un proceso de run vivo:** algún lugar con pid vivo en `locks/*/lugares/`, o
  `tick.lock` con pid vivo. Los runs que esperan (aprobación, detenidos, en cola) no frenan nada:
  cuando sigan, lo hacen con el código nuevo, y el log es de solo agregar.
- **Las dependencias se instalan** con `pnpm install --frozen-lockfile`. La variable de entorno
  `FLOWRUNNER_APP_INSTALL` reemplaza ese comando, solo para los tests.
- **`doctor` agrega un chequeo:** «flowrunner corre desde ~/.flowrunner/app». Falla si cualquiera de
  los tres puntos de entrada apunta a otro lado, y su arreglo es `flowrunner self-update`.
- **El checkout de desarrollo puede seguir corriendo comandos:** los tests lo hacen. No se agrega un
  bloqueo en tiempo de ejecución.

## Cambios, archivo por archivo

### `src/setup/app.ts` (nuevo)

```ts
// El flowrunner que corre runs: un worktree fijo del repo, separado del checkout de desarrollo.
// Cambiar de rama en el checkout con un run en curso le cambiaba los prompts a mitad de camino (ML-1).
export function appDir(env: NodeJS.ProcessEnv): string; // join(flowrunnerHome(env), "app")

/** El repo de flowrunner del código que corre: la carpeta de arriba de src/. */
export const SOURCE_REPO: string; // join(import.meta.dirname, "..", "..")

/** Los procesos vivos que impiden actualizar: lugares con pid vivo y un tick corriendo. */
export function procesosVivos(home: string): string[]; // describe cada uno: "VF-6-… (pid 123)", "tick (pid 456)"

export interface SelfUpdate { ok: true; app: string; sha: string; creado: boolean; reapuntado: string[] }

export async function selfUpdate(env: NodeJS.ProcessEnv): Promise<SelfUpdate>;
```

`selfUpdate`, en orden:

1. `const vivos = procesosVivos(flowrunnerHome(env))`. Si hay alguno, `UserError` con
   `no actualizo con runs corriendo: ${vivos.join(", ")}` y el siguiente
   `esperá a que terminen o corré flowrunner status`.
2. Lo que importa es el `.git` común del repo:
   `git -C SOURCE_REPO rev-parse --git-common-dir`, resuelto contra `SOURCE_REPO`.
   `git -C SOURCE_REPO fetch --quiet origin`.
3. Si no existe `APP_DIR`:
   `git -C SOURCE_REPO worktree add --detach APP_DIR origin/main`, y `creado = true`.
   Si existe, comprobar que sea un worktree de ese repo: `git -C APP_DIR rev-parse --git-common-dir`
   tiene que coincidir. Si no coincide, `UserError` con
   `${APP_DIR} existe y no es un worktree de flowrunner: borralo y volvé a correr self-update`.
   Si coincide: `git -C APP_DIR checkout --detach --quiet origin/main` y
   `git -C APP_DIR clean -fdq -e node_modules`.
4. Instalar: `runShell(env.FLOWRUNNER_APP_INSTALL ?? "pnpm install --frozen-lockfile", { cwd: APP_DIR, env, timeoutMs: 10 * 60_000 })`.
   Si sale distinto de 0, `UserError` con el final de la salida (`tail`).
5. Re-apuntar:
   `runProc(process.execPath, ["--disable-warning=ExperimentalWarning", join(APP_DIR, "bin", "flowrunner.js"), "_reapuntar", "--json"], { cwd: APP_DIR, env })`.
   Su JSON trae `reapuntado: string[]`.
6. Devolver `sha` (`git -C APP_DIR rev-parse HEAD`), `creado` y `reapuntado`.

### `src/cli/main.ts`

- `self-update`: llama a `selfUpdate(env)` e imprime `flowrunner en ${app} (${sha.slice(0,7)}): ${reapuntado.join(", ")}`.
- `_reapuntar`: oculto, no va en la ayuda. Corre en este orden y junta un texto por cada paso:
  - **Link:** borra `~/.local/bin/flowrunner` si existe y lo vuelve a crear con
    `symlinkSync(BIN, …)`. Usa `commandDir(env)`, que hay que exportar desde `src/setup/init.ts`;
    si devuelve `undefined`, el paso se saltea con «agregá ~/.local/bin a tu PATH».
  - **launchd:** `installLaunchd(env)`, solo si el plist ya existía, o sea que launchd estaba
    instalado.
  - **Orca:** `installOrcaPlugin(env, undefined)`, solo si `env.ORCA` está definido o existe
    `/Applications/Orca.app`.
  - **Skill:** `installSkill(env, true)`.

  Devuelve `{ ok: true, reapuntado: string[] }`.
- La ayuda de `main.ts` suma
  `self-update                    mueve el flowrunner que corre runs a origin/main`.

### `src/setup/init.ts`

- `commandDir` pasa a exportarse.
- En `machineSteps`, el paso «comando flowrunner» se reemplaza por «flowrunner instalado en
  ~/.flowrunner/app». Su `done` es que el link de `~/.local/bin/flowrunner` resuelva a
  `appDir(env)/bin/flowrunner.js`, y su `apply` es `selfUpdate(env)`. Los pasos «job de launchd» y
  «skill» quedan como están: `_reapuntar` los vuelve a correr desde la app.

### `src/cli/doctor.ts`

- Un chequeo nuevo, «flowrunner corre desde ~/.flowrunner/app», junto a los que ya hay. Revisa:
  - que `realpathSync(join(commandDir, "flowrunner"))` sea
    `realpathSync(join(appDir(env), "bin", "flowrunner.js"))`;
  - que el plist, si existe, contenga `join(appDir(env), "bin", "flowrunner.js")`.

  Si falla, el arreglo es `corré flowrunner self-update`. El chequeo de Orca no se hace: su CLI no
  dice desde dónde cargó el plugin.

### `README.md`

En «Instalación», `flowrunner init <repo> --aplicar` deja el flowrunner que corre en
`~/.flowrunner/app`. Para actualizarlo, `flowrunner self-update`. El checkout del repo de flowrunner
queda para desarrollar, y cambiar de rama ahí no afecta a ningún run.

## Tests (escribir primero y verlos fallar)

El repo fuente de los tests es un clon del repo real (`git clone --quiet --shared <repo real> <tmp>`),
con un remote bare propio. Nunca se toca el `.git` del repo real.
`FLOWRUNNER_APP_INSTALL="ln -s <repo real>/node_modules node_modules"` evita instalar. Se usan
`FLOWRUNNER_HOME`, `FLOWRUNNER_LAUNCH_AGENTS` y un `HOME` temporales, con `~/.local/bin` en el
`PATH`, y `ORCA=<test/bin/orca>`, el falso que ya existe.

`test/self-update.int.test.ts`:

1. **«self-update crea la app en origin/main y apunta el comando, launchd y la skill ahí»**:
   - `APP_DIR` existe y su `HEAD` es el `origin/main` del clon;
   - el link de `~/.local/bin/flowrunner` resuelve a `APP_DIR/bin/flowrunner.js`;
   - con un plist creado antes, el plist nuevo contiene `APP_DIR/bin/flowrunner.js`.

   Falla hoy: no existe el comando.
2. **«cambiar de rama en el checkout no cambia el prompt que lee la app»**: después de
   `self-update`, una rama nueva en el clon cambia `prompts/revisar.md` y hace checkout ahí;
   `APP_DIR/prompts/revisar.md` sigue igual. Es la regresión de ML-1.
3. **«self-update se niega con un run corriendo y lo nombra»**: con un archivo de lugar en
   `locks/acme/lugares/R-1.json` y el pid del propio test (vivo), sale 1, y el error contiene `R-1`.
4. **«self-update mueve una app existente a origin/main nuevo»**: un commit nuevo empujado al remote
   del clon, y otra vez `self-update`: el `HEAD` de la app es el nuevo `sha`, y `creado: false`.

`src/cli/doctor.test.ts`, o el test de doctor que ya exista:

5. **«doctor marca el link que no apunta a la app»**: con el link a otro archivo, el chequeo falla
   con el arreglo `flowrunner self-update`.

## Docs a actualizar

- `README.md`, en la sección Instalación.
- **ADR 0021**, «flowrunner corre desde un worktree fijo»: el contexto de ML-1, la decisión de esta
  spec y las alternativas descartadas (un paquete npm publicado, porque es pesado para un proyecto
  personal; un bloqueo en tiempo de ejecución, porque rompe los tests que corren el CLI desde el
  checkout).

## Verificación

```
pnpm lint && pnpm test && pnpm test:integration
```

Después, a mano y una sola vez: `node bin/flowrunner.js self-update` desde el checkout, y
`flowrunner doctor` muestra el chequeo nuevo en verde.

## Fuera de alcance

- Versionar flowrunner con tags: `origin/main` alcanza.
- Actualizar solo, desde `tick`.
- Migrar los runs que ya existen: el log es compatible.

## Riesgos y cómo se detectan

- **`pnpm` no está en el `PATH` de launchd.** El plist ya copia el `PATH` de quien lo instala. Si
  falla, el test 1 con `FLOWRUNNER_APP_INSTALL` sin definir lo mostraría en una máquina sin pnpm.
  Se documenta en el README.
- **El worktree de la app queda sucio** porque un run escribió algo dentro, cosa que no debería
  pasar. El paso 3 hace `clean -fdq`, y doctor puede sumar «la app tiene cambios» si aparece.
