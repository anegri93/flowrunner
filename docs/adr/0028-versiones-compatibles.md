# 0028 · Las dependencias nuevas, en la versión estable más nueva que anda con el Node del repo

Estado: Aceptada · 2026-11-10

## Contexto

En PIZ-3 (repo pizarra-en-vivo, npm, `engines.node: ">=20.6"`), el plan sumó `unpdf` sin versión. La
sub-task solo puede correr el comando de instalación que arma `installCommands`, y ese comando iba sin
versión: `npm install -E unpdf fflate` instaló la última, `unpdf@2.1.0`, que pide `engines.node:
">=24"`. La revisión lo frenó siete veces, y la sub-task no podía cambiar la versión: la política de
comandos le bloqueaba `npm install -E unpdf@1`, que no era el comando exacto del plan. La persona
pidió que flowrunner instale la última versión estable y compatible, para no volver a tener ese
problema.

## Decisión

1. **flowrunner elige la versión, no el agente,** y la elige antes de que la persona vea el plan. Cada
   dependencia sin versión de `dependencias` o `dependencias_dev` queda en `tasks.json` como
   `paquete@x.y.z`, y `installCommands` instala esa versión exacta. `-E` sigue dependiendo del estilo
   del repo: sin él, el manifiesto queda con `^x.y.z` y el lockfile con la versión elegida.
2. **Estable** es sin prerelease (`-beta`, `-rc`, `-next`), sin deprecar y no más nueva que el
   dist-tag `latest` (una versión publicada con `next` sin sufijo no cuenta). **Compatible** es que su
   `engines.node`, si declara uno, acepte el Node mínimo del repo. Un `engines.node` que no es un rango
   válido no dice nada y no filtra.
3. **El Node mínimo del repo** es la versión más vieja que admite el `engines.node` de su
   `package.json` (`>=20.6` → 20.6.0, `^20 || ^22` → 20.0.0). Si no hay, sale de `.nvmrc` o
   `.node-version` (`22` → 22.0.0), con la misma lectura que usa flowrunner para elegir el Node con
   que corre el repo (`nodeSpec`). Si no hay nada, o el rango admite cualquier versión (`*`), **no se
   filtra por engines**: se elige la estable más nueva, y el plan lo dice («el repo no dice qué Node
   usa»).
4. **Una versión o un rango que trae el plan se respeta** (`unpdf@1.4.0`, `@scope/x@^2`): no se
   consulta ni se cambia. Es la salida cuando la persona decide otra cosa. Tampoco se tocan las
   sub-tasks conservadas de un replan (ADR 0024): su código ya está escrito con lo que instaló.
5. **Si ninguna versión estable anda,** la dependencia queda sin versión en `versiones.json`
   (`sin_version`), con el motivo y la salida propuesta: «Ninguna versión estable de unpdf anda con
   Node 20.6.0 (engines.node de package.json); la más nueva, 2.1.0, pide >=24: subí `engines.node` a
   `>=24` o elegí otra librería». Un paquete que no está en el registro, o que no tiene versiones
   estables, también. `flowrunner plan` lo muestra arriba de todo y **`approve` no sigue**, sin un flag
   que lo salte: la persona pide cambios con otra librería, o con la versión que va y que una sub-task
   suba el Node del repo. Las versiones que sí eligió se listan en el plan, para que se vea que no las
   eligió el planificador.
6. **Lo hace aprobar, al entrar,** no el final de planificar. Así la versión ya figura en el plan que se
   aprueba, y un registro que no responde reintenta solo eso: al final de planificar, cualquier falla
   después de la sesión volvía a pagar un plan entero. Un plan nuevo borra el `versiones.json` del
   anterior al escribir sus artefactos.
7. **El registro es `npm view <paquete>@>=0.0.0 version engines deprecated dist-tags --json`,** desde el
   worktree, así vale el `.npmrc` del repo. Sirve igual para repos de pnpm o yarn, que instalan del
   mismo registro. Va detrás de `Deps.registro`, como `query` y `deleteSession`: los tests usan un
   registro falso, determinista y sin red, y `testDeps` trae uno que rechaza. Un repo sin
   `package.json` no lo consulta.
8. **Sin red, un error acotado.** Cada consulta corta a los 30 s, y npm corre sin reintentos propios.
   El motivo nombra la causa (`ETIMEDOUT`, `ENOTFOUND`) y aprobar devuelve una falla de
   infraestructura: el engine la reintenta con la espera de un corte de red (30 s, 2 min y 5 min) y
   después se detiene diciendo que se retome cuando vuelva la red.
9. **`semver` como dependencia,** para leer rangos y comparar versiones en vez de escribir un parser:
   es el de npm, ISC, sin dependencias en la 7.x, y ya estaba en el árbol por otras herramientas.
   `@types/semver`, MIT y sin dependencias, va de desarrollo.

## Alternativas descartadas

- **Que lo decida el planificador.** No tiene red ni Bash en planificar, y una versión que se acuerda
  de memoria es la que instaló PIZ-3.
- **Elegirla en implementar.** La persona aprobaría un plan sin saber qué se instala, y una
  incompatibilidad aparecería con el código ya a medio escribir.
- **Rechazar el plan en el gate si ninguna versión anda.** El planificador cambiaría de librería solo,
  o gastaría tres intentos sin poder cambiar el Node del repo: subir el Node o cambiar de librería es
  una decisión de la persona.
- **Un `--acepto-dependencias` en `approve`.** Instalaría a ciegas lo que no anda; si la persona quiere
  esa versión igual, la pide con `changes` y el plan la trae explícita.
- **Leer el packument por HTTP.** Ignoraría el registro y la autenticación del `.npmrc` del repo.

## Consecuencias

- Una dependencia nueva se instala en una versión que anda con el Node del repo, o el plan no se
  aprueba hasta que la persona decide qué hacer.
- Entrar a aprobar consulta el registro una vez por paquete sin versión: unos cientos de milisegundos
  con red. Sin red, el run espera como en cualquier corte.
- Una versión explícita del plan no se valida contra el Node del repo: se respeta tal cual.
- El panel de Orca no muestra las versiones; si ninguna anda, su botón Aprobar recibe el mismo rechazo
  que la terminal.

## Verificación

- `src/versiones/versiones.test.ts`: la estable más nueva que anda saltando las más nuevas que no
  (el caso de PIZ-3); prereleases, deprecadas y las más nuevas que `latest`; una versión o un rango
  del plan se respetan sin consultar; ninguna compatible y un paquete que no existe quedan sin
  versión con el motivo; sin `engines` usa `.nvmrc`, y sin nada no filtra; un registro caído rechaza;
  una sub-task conservada no se toca.
- `src/versiones/registro.test.ts`, con un `npm` falso en el PATH: la salida de `npm view` en lista y
  en objeto, E404 y «No match found», y un registro colgado que corta en el plazo con un motivo que el
  engine trata como corte de red.
- `src/phases/aprobar.test.ts`: el plan que ve la persona trae la versión elegida; si ninguna anda, el
  plan lo dice primero y `approve` no sigue; un registro que no responde es una falla de infraestructura
  con motivo de red; un repo sin `package.json` no consulta; un plan nuevo borra las versiones del
  anterior.
