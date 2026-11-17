# 0035 · Una sub-task clona el node_modules de la feature en vez de correr el setup

Estado: Aceptada · 2026-11-17

## Contexto

Cada sub-task trabaja en su propio worktree y corría el `setup` del repo antes de empezar. En
pizarra-en-vivo eso es `npm ci`: 25 a 37 segundos por sub-task, medido el 2026-11-17 (578 MB de
`node_modules`). Clonar ese `node_modules` con copy-on-write tarda 13 segundos. Las sub-tasks que
dependen de otra corren una detrás de la otra, así que el setup se suma entero en cada una.

## Decisión

1. **Antes del setup, `reusarDependencias` intenta clonar** cada `node_modules` del worktree de la
   feature (también los de paquetes de un monorepo) en el de la sub-task: `cp -cR` (clonefile de APFS)
   en macOS, `cp -R --reflink=auto` en Linux.
2. **Solo si es seguro:**
   - el `setup` del repo únicamente instala paquetes de node (`npm ci`, `npm install`,
     `pnpm install`, `yarn`, `bun install`, con sus opciones): un setup que hace más, como un
     `prisma generate`, corre siempre;
   - la rama no cambió manifiestos ni lockfiles desde la base, así que el `node_modules` de la feature
     es el que instaló preparar con esos mismos archivos.
3. **Si algo no se cumple o el clon falla**, se borra lo clonado y corre el setup de siempre.
4. Una sub-task que agrega o saca paquetes los instala ella sobre su clon, como antes sobre lo que
   dejaba el setup.

## Alternativas descartadas

- **Un link simbólico a `node_modules` de la feature.** Un `npm install` de una sub-task cambiaría el de
  la feature y el de las otras sub-tasks.
- **Clonar sin mirar el setup.** Un setup que genera código o compila dejaría la sub-task sin eso.

## Verificación

- `src/phases/reinstalar.test.ts`: solo un setup que únicamente instala; clona cada `node_modules`,
  también los de los paquetes; no reusa si la rama cambió un manifiesto o el lockfile, ni con otro
  setup.
- `src/phases/implementar.test.ts`: con un setup que solo instala, la sub-task arranca con el
  `node_modules` de la feature clonado (con `npm ci`, la marca que dejó preparar no estaría).
