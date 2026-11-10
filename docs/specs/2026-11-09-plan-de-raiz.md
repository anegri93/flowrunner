# Plan para arreglar flowrunner de raíz

Plan · 2026-11-09 · sale de `2026-11-09-por-que-falla-y-tarda.md`

## El problema, en una línea

flowrunner falla por la suma de dos diseños. Pone a los agentes en un entorno **más restringido que
el de una persona**, y eso genera trabas que nadie tendría. Y **cada traba la recupera solo y caro**:
vueltas, diagnóstico y replan desde cero. Cuando nada se traba, un run sale en 9 a 12 minutos por
US$ 2 o 3. VF-6 se trabó y salió en 95 minutos por US$ 25,71.

## Principios

Cada cambio de este plan cumple estos principios, y cualquier cambio futuro también:

1. **Un agente tiene las herramientas de una persona**, salvo lo que es peligroso de verdad: escribir
   fuera del worktree, secretos, `push`, instalar sin declarar, tocar los tests bloqueados.
2. **Ante una traba, se detiene y pregunta.** No insiste solo, salvo en fallas de infraestructura,
   que no piden criterio.
3. **Nunca se tira trabajo hecho.** Un reintento, una pregunta o un replan parten de lo que ya está.
4. **Lo imposible se detecta antes de implementar**, en `feature check` o en el gate del plan, no
   después en verificar.
5. **Cada regla nueva cita el incidente que la justifica y la métrica que va a mover.** Una regla
   que no aparece en ningún run durante un mes se revisa.
6. **Cada fase se mide contra la línea de base** (abajo). Lo que no mejora el número no se queda.

## Línea de base

Son los 9 runs con datos. La tabla completa está en el diagnóstico.

| Métrica | Hoy |
|---|---|
| Tiempo activo por run (mediana) | 28 min |
| Costo por run (mediana) | US$ 6,85 |
| Costo de planificar sobre el total | 55 % (US$ 45,92 de 83) |
| Primer plan, promedio | US$ 2,76 · 10 min |
| Sesiones de planificar por run | 2,6 (23 en 9) |
| Comandos rechazados por run | 15 (135 en 9) |
| Runs sin ninguna traba | 1 de 9 (VF-2) |

**Objetivo al terminar las fases 1 a 4:** mediana de 15 min y US$ 4 por run; planificar por debajo
del 35 % del costo; 1,2 sesiones de planificar por run; menos de 2 comandos rechazados por run; al
menos 6 de cada 9 runs derechos, o detenidos con **una** pregunta.

---

## Fase 0 · Higiene, antes de tocar nada

Medio día. No cambia el comportamiento de los runs, y evita que se repita lo de ML-1.

### 0.1 Separar el flowrunner que corre del que se desarrolla

- **Problema:** `~/.local/bin/flowrunner` apunta a `bin/flowrunner.js` del checkout de desarrollo. Un
  run lee los prompts del disco en cada sesión, así que cambiar de rama con un run corriendo le
  cambia los prompts a mitad de camino. Así fallaron las tres revisiones de ML-1.
- **Cambio:**
  - Un worktree fijo, solo para correr: `~/.flowrunner/app`, en `origin/main`.
  - `flowrunner self-update`: hace `fetch` y lo mueve a `origin/main`, solo si no hay ningún run
    activo ni en cola. Si los hay, se niega y los nombra.
  - El link de `~/.local/bin` apunta a ese worktree. `init` y `doctor` lo instalan y lo verifican.
- **Aceptación:** cambiar de rama en el checkout de desarrollo con un run corriendo no cambia nada
  de ese run. Lo comprueba un test de integración: un run lanzado desde el worktree fijo sigue con su
  prompt aunque cambie el del checkout de desarrollo.

### 0.2 Las métricas, como comando

- **Cambio:** `flowrunner stats --runs [proyecto]` imprime la tabla de la línea de base: tiempo
  activo, costo por fase, sesiones de planificar, comandos rechazados, vueltas y si salió derecho.
  Lo que hoy hacen los scripts del diagnóstico, en `src/report/stats.ts`.
- **Aceptación:** sobre los runs actuales reproduce los números del diagnóstico.

### 0.3 Las PRs abiertas

| PR | Qué hace | Decisión |
|---|---|---|
| #72 | Formato y typecheck para las sub-tasks; fixers antes del commit | **Mergear**: es principio 1 |
| #71 | Verify como criterio, atribuido por archivo; salida de Prettier | **Mergear**: corrige a quién vuelve el trabajo |
| #70 | Rutas protegidas en el gate y en `feature check`; scripts de `package.json`; rechazos visibles para revisar | **Mergear**: es principio 4. Su parte de «la sub-task devuelta reintenta» la reemplaza la fase 2 |
| #69 | Avisos de escritorio en cada cambio de estado | **Mergear**, reapuntada a `main`: la fase 2 la usa para las preguntas |
| `docs/diagnostico-runs` | El diagnóstico y este plan | **Mergear** |

- **Ya mergeado:** #67 (varios runs por repo). Hasta terminar la fase 2, sugiero `max_runs: 1` en
  los repos: varios runs juntos multiplican las trabas que este plan ataca.

---

## Fase 1 · Las herramientas de una persona

La causa con más impacto. Son 2 PRs.

### 1.1 Comandos: de la lista exacta a una política

- **Problema:** la lista de comandos es exacta (`checkBash` en `src/tripwires/rules.ts`): solo pasa
  el texto idéntico, y cualquier `;`, `&&`, `|` o `>` se rechaza. De los 135 rechazos:
  - **unos 100 (74 %) eran de solo lectura**: `git status --short` cuando la lista tenía
    `git status`, `git log --oneline -5` cuando tenía `-10`, `ls`, `cat`, `grep`, `head`, `sed -n`,
    encadenados con `;`;
  - 20 eran de formato;
  - 5 eran el verify;
  - unos pocos eran un comando permitido con `| tail` al final;
  - 7 eran scripts a mano (`python3` con heredoc, `sh -c`, bucles);
  - 2 escribían (`mkdir -p`, `sed -i`).
- **Cambio:** `checkBash` parte el comando en tramos (`;`, `&&`, `||`, `|`) y evalúa cada uno.
  - **Permitido siempre:**
    - lectura: `git status|log|diff|show|grep` con cualquier opción, `ls`, `cat`, `head`, `tail`,
      `wc`, `grep`, `rg`, `find` sin `-exec` ni `-delete`, `sed -n`, `awk` sin `system`, `diff`,
      `echo`;
    - redirigir errores: `2>&1`, `2>/dev/null`.
  - **Permitido con el alcance:**
    - los comandos de sus criterios, con cualquier filtro detrás (`| tail`, `| head`, `| grep`);
    - formato, lint y typecheck;
    - `mkdir -p` dentro del alcance.
  - **Prohibido:**
    - escribir con redirección (`>`, `>>`, `tee`) fuera del alcance;
    - `git` que escribe (`commit`, `push`, `checkout`, `reset`, `rebase`, `config`);
    - `rm`, `curl`, `wget`, `ssh`;
    - instalar sin declarar (`npm i`, `pnpm add`, `pip install`);
    - `sh -c`, `eval`, `node -e`, `python3 -c` y los heredocs: un script ad hoc no se puede evaluar
      por tramos. El motivo del rechazo dice qué usar en su lugar.
  - **Doble control:** el control de después sobre el diff (`checkChanges`) se queda igual. Lo que un
    comando escriba fuera de las reglas se ve igual antes del commit.
- **Aceptación:**
  - Re-evaluados con la política nueva, los 135 comandos rechazados quedan permitidos, salvo los
    scripts ad hoc y las escrituras fuera del alcance.
  - Un test con esos comandos reales como tabla de casos, sacados de los logs.
  - En 3 runs nuevos: menos de 2 rechazos de Bash por run.
- **Riesgo:** un comando de lectura sobre un archivo con secretos, como `cat .env.local`. Los
  `env_files` se siguen chequeando en cada tramo, como hoy lo hace `checkReadPath`.

### 1.2 Formato, lint y typecheck

- Lo hace #72: las sub-tasks pueden correrlos, y flowrunner pasa los fixers antes de cada commit.
- **Agregado:** el formateador también pasa por los archivos de la sub-task cuando verificar le
  devuelve trabajo. El formato nunca tiene que volver a ser motivo de una vuelta.
- **Aceptación:** sobre los motivos de los runs viejos, ningún «sigue en rojo» por `prettier`,
  `format:check` ni `prefer-const`.

### 1.3 Menos reglas de alcance

- Revisar con el criterio del principio 5 las reglas de `checkWritePath`.
  - **Se quedan:** las rutas protegidas, fuera del worktree, los tests bloqueados, el lockfile sin
    dependencias declaradas y los secretos.
  - **Se relaja:** `package.json`, que ya lo hace #70.
- Los alcances siguen, porque evitan que dos sub-tasks paralelas se pisen. Pero un archivo fuera del
  alcance que la sub-task necesita deja de ser un rechazo mudo: pasa a la fase 2 como pregunta.

---

## Fase 2 · Detenerse y preguntar

Ataca la recuperación cara. Son 2 o 3 PRs.

### 2.1 Un estado nuevo: `esperando_decision`

- **Problema:** verificar, revisar y probar devuelven trabajo hasta 2 veces por fase (`MAX_ROUNDS` en
  `src/engine/engine.ts`). Además, diagnosticar y reparar (`src/phases/diagnosticar.ts` y
  `reparar.ts`) adivinan de quién es el rojo. En VF-6, una traba de cinco minutos se convirtió en 70
  minutos y US$ 17.
- **Cambio:** cuando verificar, revisar o probar encuentran un problema, el run pasa a
  `esperando_decision`. Es igual que `esperando_aprobacion`: sin proceso y sin lugar.
  - Deja una **pregunta** en el log, con:
    - qué falló: el criterio o el paso de verify, y el final de su salida;
    - de quién parece ser: la sub-task dueña del archivo, por la atribución de #71;
    - qué opciones hay.
  - **Opciones, como comandos:**
    - `flowrunner fix <run> [--unidad ST-n] "<instrucción>"`: una sola pasada de esa sub-task, con
      tu instrucción, sobre el código que ya está;
    - `flowrunner fix <run> --yo`: arreglás vos en el worktree, y flowrunner commitea y sigue
      verificando;
    - `flowrunner rerun <run> --desde planificar`, ahora sin tirar código (fase 3);
    - `flowrunner accept <run> "<por qué>"`: seguir igual. Es el mismo patrón que `accept-untested`,
      con el motivo en la PR;
    - `flowrunner abort <run>`.
  - **La pregunta llega** por el aviso de escritorio (#69), por el panel de Orca, que muestra las
    opciones como botones, y por la skill.
- **Las vueltas:** `vueltas` en la config, por defecto 0. Un repo que quiere el comportamiento de
  hoy pone 2.
- **Diagnosticar y reparar** dejan de correr solos. La atribución por archivo alcanza para la
  pregunta. Si después hace falta, un `flowrunner explain <run>` lo corre a pedido.
- **Aceptación:**
  - Reproduciendo VF-6 con fases simuladas, el run se detiene **una** vez, en verificar, con
    AC-12, `carpeta.ts` atribuido a ST-3 y `CLAUDE.md` como imposible.
  - `fix --unidad ST-3` corre una sola sesión.
  - Ninguna sesión de diagnosticar sin pedirla.

### 2.2 Una sub-task trabada pregunta

- **Problema:** una sub-task sin cambios reintenta hasta 3 veces (`MAX_UNIT_ATTEMPTS`). Con
  escrituras rechazadas, #70 la hace fallar con el motivo, pero después de dos intentos.
- **Cambio:** sin cambios, o con una escritura rechazada que dejó algo sin hacer, se detiene al
  primer intento con una pregunta. La pregunta lleva lo último que dijo el agente y lo que el
  bloqueo rechazó, y ofrece:
  - agrandar el alcance: `fix --unidad ST-n --alcance <ruta>`;
  - hacerlo a mano: `--yo`;
  - replanificar.
- **Aceptación:** ST-6 y ST-7 de VF-6 se detienen al primer intento.

### 2.3 Reintentos solo para infraestructura

- **Cambio:** un error de red reconocido (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`,
  `Could not resolve host`, un 5xx o un 529 de la API) se reintenta con más espera: 30 s, 2 min y
  5 min. Después se detiene, y el motivo dice `flowrunner resume`. Una credencial rechazada se
  detiene enseguida, con `flowrunner doctor`.
- **Aceptación:** con el corte de DNS de VF-6 simulado, el run espera y sigue en vez de morir a los
  25 s.

### 2.4 El origen de cada decisión

- **Cambio:** `aprobado`, `cambios_pedidos` y las respuestas nuevas de 2.1 guardan su `origen`:
  `terminal`, `claude` u `orca`. El worker de Orca y la skill pasan `--origen`.
- **Por qué:** en VF-6 hubo 4 aprobaciones entre 6 y 64 segundos después de quedar listo el plan, y
  no se pudo saber de dónde vinieron.
- **Queda para decidir:** si el botón de Orca se habilita recién después de abrir el plan. Es una
  decisión de producto.

---

## Fase 3 · Replanificar sin tirar el código

Una PR.

- **Problema:** cada planificar vuelve a la base (`resetHard(worktree, base_sha)` en
  `src/phases/planificar.ts`). En VF-6, ST-1 a ST-5 se reimplementaron 4 veces: unos US$ 9 de los
  US$ 13 de implementar.
- **Cambio:**
  - El planificador recibe las sub-tasks ya integradas: id, alcance y commit.
  - Su salida suma `subtareas[].conserva: boolean`. El gate la acepta solo si esa sub-task existía
    con el mismo alcance y no la nombran los pedidos de cambios.
  - Planificar arma la rama nueva así: la base, después el commit de los tests del plan nuevo,
    después el cherry-pick de los commits de las sub-tasks conservadas (los encuentra por el trailer
    `Flowrunner-Subtask`).
  - Si un cherry-pick choca, esa sub-task se reimplementa y queda un aviso.
  - Implementar arranca solo las que no se conservan.
- **Aceptación:** reproduciendo VF-6 con fases simuladas, el replan conserva ST-1 a ST-5 y solo
  corre las sesiones de las sub-tasks nuevas o cambiadas.
- **Riesgo:** un test nuevo del plan que rompe el código conservado. Lo ve verificar como cualquier
  rojo, y con la fase 2 se pregunta.

---

## Fase 4 · Planificar barato

Son 2 o 3 PRs. Ataca el 55 % del costo.

### 4.1 Si el gate rechaza, seguir en la misma sesión

- **Problema:** el plan se escribe recién después de pasar el gate (`planificar.ts:252`). Un rechazo
  abre una sesión nueva que explora todo de nuevo: ML-1 #2 y VF-5 #2 costaron US$ 4,84 y 19,5
  minutos para corregir una declaración.
- **Cambio:**
  - `runSession` guarda el id de la sesión. El reintento por el gate llama con `resume` (el SDK lo
    tiene: `resume?: string`) y manda un solo mensaje: el motivo del gate.
  - Si el resume falla, vuelve a una sesión nueva, como hoy.
- **Aceptación:** un rechazo del gate cuesta menos de US$ 1 y menos de 4 minutos. Lo comprueba un
  test con el SDK simulado: el segundo intento pide `resume` con el id del primero.

### 4.2 El gate como herramienta del planificador

- **Cambio:** un servidor MCP propio, `validar_plan`, recibe el plan en el mismo esquema y devuelve
  los problemas de los chequeos que no corren nada:
  - la forma del plan (`checkPlanShape`);
  - los llamadores fuera del alcance (`callersOutOfScope`);
  - los tests existentes sin declarar;
  - las rutas protegidas.

  El prompt pide llamarlo antes de entregar. El gate de afuera sigue igual, como red, y es el único
  que corre los tests en rojo.
- **Aceptación:** en 5 runs nuevos, a lo sumo un rechazo del gate de afuera.

### 4.3 Darle lo que ya se exploró

- **Problema:** la feature, escrita con la skill, cita el código con `archivo:línea`, y el
  planificador explora desde cero: el primer plan de VF-1 tuvo 97 `Read` en 267 turnos.
- **Cambio:**
  - La skill escribe esas citas en una sección `## Contexto` de la feature, y `parseFeature` la
    conserva.
  - Planificar le arma al planificador, antes de empezar, un mapa de graft de esos archivos: su API
    y quién los llama.
  - El prompt dice: «partí de esto; leé solo lo que no está».
- **Aceptación:** el primer plan, en promedio, baja de US$ 2,76 a menos de US$ 1,5, y de 10 a menos
  de 6 minutos.

### 4.4 Que explore un modelo barato

- **Problema:** el explorador (Haiku) existe, pero se usó en 5 de 23 sesiones, todas de ML-1 y VF-1.
  Opus explora solo y paga cada turno por el tamaño de lo que relee.
- **Cambio:** una sesión `explorar` antes de planificar, con Sonnet. Recibe la feature y el mapa de
  4.3, y entrega `exploracion.md`: archivos, funciones, tests existentes y riesgos, con
  `archivo:línea`. Opus planifica sobre ese informe, con un contexto chico, y puede pedir más al
  explorador.
- **Aceptación:** comparado con 4.3 sola, el costo total de explorar más planificar baja otro 30 %
  sin que suban los rechazos del gate. Si no baja, se saca.

### 4.5 El modelo según el tamaño

- **Experimento:** para una feature de hasta 3 criterios, planificar con Sonnet. Se mide la calidad
  del plan: rechazos del gate, vueltas, preguntas de la fase 2.
- **Se decide con datos.** Por defecto queda Opus.

---

## Fase 5 · Lo imposible, antes de implementar

La mayoría ya está en #70. Esto completa.

- **`feature check`:**
  - Sumar a los avisos de rutas protegidas un criterio que pide un comando inexistente. Por ejemplo,
    nombra `npm run x` y `package.json` no tiene `x`: en VF-6, `npm run mac`.
  - Un criterio que solo se puede probar buscando texto en la documentación: aviso de «este
    criterio no prueba que funcione».
- **Gate del plan:** un criterio cuyo comando es el verify del repo no se asigna a una sub-task.
  Pasa a ser un criterio del run, que comprueba verificar (con #71 ya se atribuye por archivo).
- **Aceptación:** las tres trabas de VF-6 (`CLAUDE.md`, `npm run mac` y AC-12) aparecen en
  `feature check` o en el gate, antes de implementar.

---

## Fase 6 · Decidir con los números

Al terminar las fases 1 a 4, antes de seguir agregando nada:

1. **Cinco features reales** con flowrunner, con `stats --runs` contra la línea de base y el
   objetivo.
2. **Una feature comparable en Claude Code solo**, con el mismo método: plan aprobado, tests en
   rojo primero, implementar, verify, revisión con un subagente y PR. Se mide tiempo, costo y
   cuántas veces corregiste.
3. **Se decide:**
   - si flowrunner llega al objetivo y le gana a Claude Code solo en lo que te importa (correr sin
     vos, guardas contra el «verde pero roto»), sigue;
   - si no, el método pasa a una skill de Claude Code con dos hooks (rutas protegidas y tests
     bloqueados), y flowrunner se archiva.

---

## Orden y dependencias

```
0.1 ─┬─ 0.2 ─┬─ 1.1 ── 1.2 ─┐
     └─ 0.3 ─┘              ├─ 2.1 ── 2.2 ── 3 ──┐
                 2.3, 2.4 ──┘                     ├─ 6
                 4.1 ── 4.2 ── 4.3 ── 4.4 ── 4.5 ─┘
                 5 (en paralelo con la fase 2)
```

- **Primero 0 y 1:** son baratos, y atacan la mitad de las trabas.
- **La fase 2 antes que la 3:** el replan conservador recién rinde cuando el run deja de replanificar
  solo.
- **4.1 y 4.2 no dependen de nada:** pueden ir en paralelo con la fase 2.

| Fase | PRs | Tamaño |
|---|---|---|
| 0 | 2 | chico |
| 1 | 2 | mediano: la política de comandos y su tabla de casos |
| 2 | 3 | grande: estado nuevo, comando `fix`, Orca |
| 3 | 1 | mediano |
| 4 | 3 o 4 | mediano |
| 5 | 1 | chico |

## Qué se saca

Por el principio 5, y porque las fases de arriba las reemplazan:

- **Las vueltas automáticas** como comportamiento por defecto (`MAX_ROUNDS` pasa a ser `vueltas`, en
  0).
- **Diagnosticar y reparar automáticos:** pasan a ser `flowrunner explain`, a pedido.
- **Los reintentos de una sub-task sin cambios.**
- **La lista exacta de comandos.**

Cada una se saca en su PR, con un test que muestre el comportamiento nuevo, y no a fuerza de dejar
código muerto.
