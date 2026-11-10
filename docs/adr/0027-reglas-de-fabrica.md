# 0027 · Reglas de fábrica: criterios de verify, filtros sin tests y el Node de una dependencia

Estado: Aceptada · 2026-11-10

## Contexto

PIZ-3 (`PIZ-3-20261110-144346`, repo pizarra-en-vivo) dejó dos tropiezos que no dependían del repo:

1. **Un criterio que solo corría el verify.** «AC-9: `npm run check` pasa (formato, lint, typecheck,
   tests y build)» es exactamente lo que corre `.flowrunner/verify.sh`. El plan lo mandó, como debe,
   a `./.flowrunner/verify.sh` y al run (`delRun`), y verificar lo dio en verde. Pero probar
   recibe todos los criterios de la feature y no puede correr comandos: lo dejó `no_probado`, el run se
   detuvo (ADR 0017) y la persona tuvo que aceptar entregar sin nada que arreglar.
2. **Un filtro por nombre que no coincide con ningún test.** El primer plan no pasó el gate: comandos
   como `npx vitest run servidor/api.test.ts -t "importar un documento …"` «ya pasaban antes de
   implementar». `vitest run <archivo> -t "<nombre que no existe>"` saltea todos los tests y sale 0;
   jest hace lo mismo (`Tests: 2 skipped, 2 total`, exit 0), también con `--passWithNoTests=false`,
   que solo mira si hay archivos de test. El gate decía «ya pasa» sin la causa: 9 minutos y unos
   USD 1,5 de un plan tirado.

La persona pidió que lo que pueda ser configuración o regla de fábrica no dependa de que alguien se
acuerde.

## Decisión

1. **`feature check` avisa un criterio que solo pide los chequeos del repo** (`soloChequeosDelRepo`):
   el criterio entero es un comando que chequea todo el repo, o lo nombra en palabras, seguido de
   «pasa», «en verde», «sin errores». El comando cuenta si es el verify del repo (`isVerifyCommand`)
   o un script o herramienta de chequeo sin un archivo ni un filtro detrás (`npm run check`,
   `pnpm verify`, `npx tsc --noEmit`); en palabras, «el build pasa», «los tests que ya existen siguen
   pasando». Un criterio que además pide un comportamiento, o que corre un test puntual, no avisa: es
   mejor un aviso de menos que uno que hace sacar un criterio válido. El aviso no frena, como los otros.
2. **Probar no cuenta como sin probar un criterio de verify.** Se eligió descontarlo, y además decirle
   a la sesión que no lo pruebe, en vez de sacarlo del texto de la feature que recibe: el criterio
   sigue a la vista con su id, y el prompt dice que «es el verify del repo y verificar ya lo comprobó
   en verde». Un `no_probado` de ese criterio se ignora; un `ok` o una `falla` siguen como siempre.
   «Verificar quedó en verde» no hace falta chequearlo: probar solo corre después de un verificar en
   verde, y toda vuelta a implementar pasa de nuevo por verificar antes de volver a probar. Qué es un
   criterio de verify lo decide `isVerifyCommand` sobre el comando del plan, igual que en verificar.
3. **El gate dice la causa de un filtro sin tests.** Cuando un comando sale 0 y su salida dice que
   todos los tests se saltearon (el resumen de vitest o el de jest), el rechazo dice «ningún test
   coincide con `-t "…"`, y el comando da verde igual», y qué hacer. Solo cambia el texto del
   rechazo: el gate ya lo rechazaba.
4. **Las reglas generales van en `prompts/planificar.md`,** que el planificador lee en todo repo y en
   todo run, sin depender de que el cerebro del repo las tenga:
   - un comando filtrado por nombre que no coincide con ningún test sale en verde: el test que busca
     va en el plan como test bloqueado, con ese nombre, o el comando apunta a su archivo nuevo;
   - al sumar una dependencia, comprobar que su `engines.node` acepte el Node mínimo del repo y, si
     no, decirlo en `decisiones`. Elegir la versión compatible es otro cambio; esto es solo la regla.
5. **No escribir criterios de verify es regla de quien escribe la feature,** no del planificador, que
   no escribe criterios y ya sabe qué hacer con uno así (paso 4 del prompt). Va en la skill
   («Escribir una feature») y en el aviso de `feature check`. Ahí también va que, al autorizar una
   dependencia, la feature diga con qué Node tiene que andar.

## Alternativas descartadas

- **Poner las reglas en `templates/brain/`.** La plantilla solo llega a los repos que corren
  `brain init` desde ahora; pizarra-en-vivo y los demás repos ya registrados no las verían. Y
  `lecciones.md` es de aprender: una regla de fábrica ahí se mezcla con lo que aprendió el repo.
- **Sacar el criterio de verify del texto que recibe probar.** El informe y el video nombran los
  criterios por id; uno que desaparece del prompt se ve como uno que nadie miró.
- **Que `feature check` frene un criterio de verify.** La heurística puede equivocarse con un criterio
  en prosa, y el run igual anda: lo frenaba probar, y eso ya no pasa.
- **Detectar en el gate estático (`validar_plan`) un `-t` sin test.** Pediría saber qué nombres
  define cada archivo, y el gate de afuera ya corre el comando; la regla del prompt lo evita antes.

## Consecuencias

- Una feature como la de PIZ-3 avisa antes de lanzar, y si se lanza igual, AC-9 no frena el run.
- Un plan con un `-t` que no encuentra nada sigue rechazado, pero con un motivo que el planificador
  puede corregir en el próximo intento.
- Un criterio de verify que probar marca `no_probado` ya no llega al informe como aviso.
- La detección del resumen depende del formato de vitest y de jest; otro runner que saltee todo con
  exit 0 sigue dando el rechazo genérico.

## Verificación

- `src/cli/feature-check.test.ts`: avisa `npm run check`, el verify del repo, «el build pasa», «los
  tests que ya existen siguen pasando»; no avisa un test puntual, un `-t`, ni un criterio que además
  pide un comportamiento.
- `src/phases/probar.test.ts`: un criterio de verify `no_probado` no detiene el run, y el prompt le
  dice a la sesión que no lo pruebe.
- `src/gates/plan.test.ts`: un `vitest run … -t` real que no coincide con ningún test, y la salida de
  jest con todo salteado, se rechazan con la causa.
