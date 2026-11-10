# Por qué flowrunner falla y tarda

Diagnóstico · 2026-11-09 · sobre los 10 runs de `~/.flowrunner/runs/`

Los números salen de los eventos de cada run (`events.jsonl`: duración de cada acción, `uso` con su
costo, rechazos) y de las sesiones de planificar (`sesiones/planificar-*.jsonl`: turnos, herramientas
y tokens). «Activo» es la suma de lo que duraron las fases, sin las esperas de la persona.

## Los runs

| Run | Activo | US$ | Qué lo trabó |
|---|---|---|---|
| PIZ-1 | 9 min | 2,36 | una vuelta de revisar |
| VF-2 | 12 min | 3,24 | nada: salió derecho |
| PIZ-2 | 16 min | 3,44 | una sub-task «sin cambios» dos veces, tres `rerun` |
| VF-3 | 26 min | 6,85 | Prettier: verificar devolvió trabajo; credencial rechazada |
| VF-4 | 28 min | 6,63 | un `let` en un test bloqueado: verificar se detuvo 5 veces |
| ML-1 | 28 min | 6,95 | gate del plan; 3 fallas de revisar por un prompt de otra rama (ver abajo); 2 vueltas de revisar |
| VF-5 | 28 min | 8,04 | gate del plan: un test existente sin declarar |
| VF-1 | 79 min | 20,18 | 4 planes (US$ 14,63); Prettier en tests bloqueados |
| VF-6 | 95 min | 25,71 | 8 planes, 9 implementaciones, 9 verificaciones |

Cuando nada se traba, un run sale en 9 a 12 minutos por US$ 2 o 3. Lo que cuesta es lo que pasa
cuando algo se traba.

## Las causas, de mayor a menor

### 1. Los agentes tienen menos herramientas que una persona, y cada choque es un turno perdido

- **135 comandos rechazados** en 9 runs; 61 en VF-6.
- La lista de comandos es exacta: nada de `&&`, ni `prettier`, ni `tsc`, ni nada que no esté literal
  en la lista.
- De ahí salen tres trabas:
  - **Formato y lint, en 4 de 9 runs** (VF-1, VF-3, VF-4, VF-6): el código o los tests llegan sin
    formatear y verificar da rojo.
  - **Sub-tasks «sin cambios»** (PIZ-2, VF-1, VF-6): el agente no pudo correr lo que necesitaba y
    terminó sin hacer nada.
  - **Tests bloqueados con un error de lint** (VF-1 y VF-4): nadie los puede tocar, y el run se
    detiene una y otra vez.

### 2. Planificar es lo más caro, y se repite

Se lleva **US$ 45,92 de los US$ 83 totales (55 %)**, y 176 minutos.

| | Costo | Tiempo | Turnos |
|---|---|---|---|
| Primer plan, promedio de 9 runs | US$ 2,76 | 10 min | 33 a 267 |
| Primer plan de VF-1 y VF-6 | US$ 5,2 a 5,5 | 18 a 20 min | 115 y 267 |
| Reintento por el gate, sesión nueva sin plan anterior (ML-1 #2, VF-5 #2) | US$ 2,07 y 2,77 | 9 a 10 min | 89 y 121 |
| Replan que parte del plan anterior (VF-6 #2 a #8) | US$ 0,69 a 1,03 | 2,5 a 3,7 min | 10 a 30 |

- **El costo es de lectura, no de escritura.** Cada turno vuelve a leer todo el contexto: el primer
  plan de VF-1 leyó 20,9 millones de tokens de caché en 267 turnos, con 97 `Read`. Lo que sale es
  poco.
- **El planificador explora solo, con Opus.** El subagente `explorador` (Haiku) existe, pero se usó
  en 5 de 23 sesiones, todas de ML-1 y VF-1.
- **Un reintento por el gate arranca de cero.** El plan se escribe recién después de pasar el gate
  (`planificar.ts:252`). Si el gate lo rechaza, no queda nada que archivar, y el reintento vuelve a
  explorar todo el repo para corregir una línea, como declarar un test.
- **Un replan descarta el código.** `rerun --desde planificar` vuelve a la base: en VF-6, ST-1 a ST-5
  se reimplementaron 4 veces (implementar costó US$ 13,01).

### 3. Las trabas sin arreglo no se ven hasta verificar

`CLAUDE.md` en el alcance (VF-6), el script de `package.json` (VF-6) y el `let` en un test bloqueado
(VF-4) no se ven al aprobar el plan. Aparecen después de implementar, y ahí arranca el ciclo de
devolver, diagnosticar y replanificar.

### 4. La recuperación automática multiplica el costo de una traba

Las vueltas de verificar, revisar y probar, el diagnóstico y los replans insisten solos, y cada vuelta
cuesta lo que una sesión entera. En VF-6, una traba de cinco minutos se convirtió en 70 minutos y
US$ 17.

### 5. Infraestructura

- Credencial rechazada: 3 veces, en VF-3 y VF-4.
- Corte de DNS: VF-6 murió en preparar en 25 segundos.
- **ML-1:** el comando `flowrunner` corre desde el checkout de desarrollo
  (`~/.local/bin/flowrunner` → `bin/flowrunner.js`). Cambiar de rama en ese checkout con un run
  corriendo cambia los prompts que el run lee del disco a mitad de camino. Así fallaron las 3
  revisiones de ML-1. **El checkout desde el que corren los runs no se cambia de rama.** Para
  desarrollar, un worktree aparte.

## Lectura

Los fallos salen de la combinación de dos diseños:

1. **Un entorno más restringido que el de una persona** (lista exacta de comandos, tests bloqueados,
   alcances rígidos), que genera trabas que un desarrollador no tendría.
2. **Una recuperación automática cara** (vueltas, diagnóstico, replan desde cero), que convierte cada
   traba en media hora y varios dólares.

Cada arreglo de los incidentes anteriores agregó una regla, y con ella otro motivo para trabarse.

## Palancas, por impacto

1. **Que los agentes corran los comandos normales del repo:** formato, lint, typecheck, tests y sus
   combinaciones. Ataca la causa 1, que es la mitad de lo que se trabó.
2. **Detenerse y preguntar en vez de insistir**, conservando el código hecho. Ataca la causa 4 y la
   parte cara de la 2.
3. **Abaratar planificar.** Ver abajo.

## Abaratar planificar

Ordenadas por ahorro estimado sobre estos 10 runs, y por lo simple que es cada una:

1. **Un rechazo del gate continúa la misma sesión.** Hoy abre una sesión nueva que explora el repo de
   nuevo. Reanudar la sesión del planificador, con el motivo del gate como mensaje nuevo, aprovecha
   el contexto en caché y corrige en pocos turnos. En estos runs: ML-1 #2 y VF-5 #2 costaron
   US$ 4,84 y 19,5 minutos, contra los US$ 0,7 a 1 de un replan con contexto.
2. **El gate como herramienta del planificador.** Los chequeos que no corren nada (llamadores fuera
   del alcance, tests existentes sin declarar, rutas protegidas, alcances que se pisan) se ofrecen
   como una herramienta que el planificador llama antes de entregar. Corrige en la misma sesión, y el
   gate de afuera casi nunca rechaza. Ataca los 5 rechazos de estos runs.
3. **Darle al planificador lo que ya se exploró.** La feature, escrita en Claude Code con la skill, ya
   cita el código con `archivo:línea`, y el planificador lo vuelve a explorar desde cero. Si recibe
   esas citas y un mapa de graft de los archivos que nombra la feature, el primer plan necesita
   muchos menos `Read`.
4. **Que explore un modelo barato.** Que el primer paso sea siempre el `explorador` (Haiku o Sonnet),
   con un informe corto, y que Opus planifique sobre ese informe, con un contexto chico. El costo por
   turno de Opus depende del tamaño del contexto que relee.
5. **Un replan conserva el código.** No es costo de planificar, pero viene con él: el código de las
   sub-tasks que el plan nuevo no cambia se queda. En VF-6 eran unos US$ 9 de los US$ 13 de
   implementar.

Para medir cada cambio: costo y turnos del primer plan, y cantidad de sesiones de planificar por run,
contra esta tabla.
