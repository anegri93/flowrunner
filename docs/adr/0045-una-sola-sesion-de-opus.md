# 0045 · Experimento: una sola sesión de Opus planifica e implementa

Estado: Experimento · 2026-11-19 · Detrás de `implementar: una_sesion`; se decide en la Fase 5 del plan de flowrunner 2.0

## Contexto

En los 33 runs de pizarra-en-vivo hubo 145 sesiones de implementar, casi sin paralelismo: 206 de los 242
minutos de la fase corrieron en serie. Cada sub-task de Sonnet arranca de cero con su parte del plan, y
varios bloqueantes de la revisión nacieron de leer mal el plan, no del código: en PIZ-13 «el plan da por
hecho que `crearYa` ya resetea»; en PIZ-18 el `clip-path` del plan dejaba ver el fondo blanco de la ficha y
quedaron funciones del enfoque descartado. La sesión de Opus que planificó ya leyó el código y entendió el
problema; esa comprensión se pierde en el traspaso.

## Hipótesis

Si la misma sesión de Opus que planificó también implementa, con todo su contexto, bajan las vueltas de
revisar y el tiempo de punta a punta, sin subir el costo por run: Opus cuesta más por token que Sonnet,
pero se ahorran sesiones y vueltas.

## Prueba previa (T4.1)

`smoke/retomar-sesion.smoke.ts`, con el SDK real (Haiku, effort bajo) sobre el repo de juguete: una sesión
de solo lectura abierta en la carpeta A lee `src/pedidos.js`; después se retoma con `resume` desde otra
carpeta B, y desde A, en las dos con Read y Write. En las dos la sesión escribe el archivo pedido y
contesta qué archivo había leído: la conversación sigue, no arranca de cero. El primer turno retomado
cuesta casi lo mismo que la sesión original, porque la conversación se lee de nuevo (con caché).

```json
{
  "planificador": {
    "subtype": "success",
    "error": "",
    "respuesta": "listo",
    "entrada": 34559
  },
  "otra_carpeta": {
    "subtype": "success",
    "error": "",
    "respuesta": "src/pedidos.js",
    "entrada": 35765,
    "escribio": true
  },
  "misma_carpeta": {
    "subtype": "success",
    "error": "",
    "respuesta": "src/pedidos.js",
    "entrada": 36920,
    "escribio": true
  }
}
```

## Decisión

1. **`implementar: sub_tasks | una_sesion`** en la config del repo, por defecto `sub_tasks`, congelado en
   `run_creado`.
2. **Con `una_sesion`, el plan tiene una sola sub-task**, `ST-1`, con todo el alcance. El gate rechaza un plan
   con más. Todo lo que depende de las sub-tasks (`fix --unidad`, conservar al replanificar, el informe,
   Orca) sigue igual porque hay una.
3. **Camino A: `ST-1` sigue en su propio worktree** y retoma la sesión del planificador desde ahí, con el
   modelo de planificar y el alcance y la política de comandos de `ST-1`. La prueba muestra que retomar
   desde otra carpeta funciona, así que no hace falta cambiar cómo se integra (worktree propio, fixers,
   doble control del diff, cherry-pick). El mensaje al retomar le dice la ruta nueva: el planificador leyó
   con rutas absolutas del worktree de la feature, y el hook rechaza escribir ahí.
4. **Si la sesión no se puede retomar**, implementar abre una sesión nueva de Opus con el plan y la feature,
   y deja un aviso.
5. **Con una sola sub-task, el que implementa puede correr el verify del repo**: el motivo para no dejarlo,
   que con varias sale rojo por el trabajo pendiente de las otras, no existe.

## Alternativas descartadas

- **Camino B: implementar en el worktree de la feature, sin worktree propio.** Evita las rutas viejas, pero
  cambia cómo se integra el trabajo; la prueba muestra que no hace falta.
- **Opus implementando sub-tasks separadas.** Paga Opus sin conservar el contexto, que es la hipótesis.

## Cómo se mide

`flowrunner stats --runs` separa los runs por modo (T4.5). En la Fase 5, 5 features con cada modo, contra
la línea de base de `docs/flowrunner-2/medicion.md`: tiempo, vueltas, rechazos y costo. Si `una_sesion` no
baja el p90 ni las vueltas, se borra.
