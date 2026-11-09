# flowrunner en Orca

Una pestaña en la barra derecha de [Orca](https://www.onorca.dev) con el progreso de los runs
activos, como `flowrunner watch`: cada fase con sus sub-tasks y sesiones, el modelo, los tokens
nuevos, el costo, el tiempo y lo que está haciendo la sesión que corre. Tocar una sesión muestra
sus pasos. Se refresca cada 3 segundos mientras la pestaña se ve.

- `src/worker.ts` corre `flowrunner watch --json` y `flowrunner report <run> --sesion <s> --json`
  en un shell de login, para tener tu PATH.
- `src/panel.tsx` dibuja la pestaña con los componentes de Orca 1.4.246.
- `src/runs.ts` arma las filas a partir del JSON, sin depender de Orca.

## Instalar

Con Orca abierto:

```sh
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load ~/Documents/PersonalProjects/flowrunner/orca
```

Como corre comandos en tu máquina, Orca pide aprobarlo: el comando imprime el fingerprint y lo
volvés a correr con `--approve <fingerprint>`. Después aparece el ícono del cohete en la barra
derecha. Si `flowrunner` no está en el PATH de tu shell de login, cambiá el comando en Settings ›
Plugins › flowrunner.

## Probar

```sh
pnpm orca:test
```

Corre los tests del plugin con `orca plugin test`, con un flowrunner falso en `test/`.
