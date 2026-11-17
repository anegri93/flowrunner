# 0035 · Una sub-task clona el node_modules de la feature en vez de correr el setup

Estado: Aceptada · 2026-11-17

## Contexto

Cada sub-task trabaja en su propio worktree y corría el `setup` del repo antes de empezar. En
pizarra-en-vivo eso es `npm ci`: 25 a 37 segundos por sub-task, medido el 2026-11-17 (578 MB de
`node_modules`). Clonar ese `node_modules` con copy-on-write tarda 13 segundos. Las sub-tasks que
dependen de otra corren una detrás de la otra, así que el setup se suma entero en cada una.

## Decisión

1. **Antes del setup, `reusarDependencias` intenta clonar** cada `node_modules` del worktree de la
   feature (también los de paquetes de un workspace) en el de la sub-task, en paralelo: `cp -cR`
   (clonefile de APFS) en macOS, `cp -R --reflink=auto` en Linux.
2. **Solo si es seguro:**
   - **el `setup` es solo la instalación de npm** (`npm ci`, `npm install`, con sus opciones). pnpm
     no: su `.bin` lleva rutas absolutas al `node_modules` de donde se instaló;
   - **lo instalado es exactamente lo que pide el lockfile de la sub-task.** El registro que deja
     npm en `node_modules/.package-lock.json` tiene cada paquete del `package-lock.json` con su
     versión, salvo los opcionales de otra plataforma, y nada más. Así no importa por qué camino
     llegó lo instalado (preparar, un reinstalado de verificar, un replan que sacó commits);
   - **ningún `package.json` del repo tiene scripts que npm corre al instalar** (`preinstall`,
     `install`, `postinstall`, `prepare` y sus pre/post): pueden generar código fuera de
     `node_modules`, como un `prisma generate`.
3. **Si algo no se cumple, corre el setup de siempre.** Si el clon falla, además se borra lo clonado
   y queda un aviso: la mejora no se pierde sin rastro.
4. Una sub-task que agrega o saca paquetes los instala ella sobre su clon, como antes sobre lo que
   dejaba el setup.

## Alternativas descartadas

- **Mirar si la rama cambió manifiestos o lockfiles desde la base.** Fue la primera versión:
  `/code-review` mostró que no ve un reinstalado que después un replan dejó sin sus commits, ni
  lockfiles fuera de la config, ni los scripts de instalación.
- **Un link simbólico a `node_modules` de la feature.** Un `npm install` de una sub-task cambiaría el de
  la feature y el de las otras.

## Verificación

- `src/phases/reinstalar.test.ts`: solo un setup que únicamente instala con npm; clona cada
  `node_modules`, también los de los paquetes, si lo instalado es lo del lockfile (con un opcional de
  otra plataforma sin instalar); no reusa si lo instalado no es lo del lockfile, si algún
  `package.json` corre scripts al instalar, ni con otro setup; si el clon falla, no deja nada a medias
  y lo avisa.
- `src/phases/implementar.test.ts`: con `npm ci` como setup, la sub-task arranca con el `node_modules`
  de la feature clonado (con `npm ci`, la marca que dejó preparar no estaría).
