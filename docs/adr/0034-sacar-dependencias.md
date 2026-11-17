# 0034 · Una sub-task puede declarar los paquetes que saca

Estado: Aceptada · 2026-11-17 · Amplía 0029

## Contexto

Una sub-task solo puede tocar el manifiesto y el lockfile si declaró dependencias, y el plan solo tenía
cómo declarar las que agrega (`dependencias`, `dependencias_dev`). En PIZ-9 (2026-11-12), AC-9 pedía
sacar `@anthropic-ai/claude-agent-sdk`: ST-1 intentó editar `package-lock.json` y correr
`npm uninstall` cinco veces, el bloqueo lo rechazó cada vez y el run terminó en un arreglo a mano.

## Decisión

1. **`quita_dependencias` en la sub-task:** los paquetes que saca, solo el nombre.
2. **Cuenta como cambiar dependencias** (`tocaDependencias`): suma el manifiesto y el lockfile a su
   alcance efectivo, así no corre a la vez que otra que los toca, y el bloqueo la deja escribirlos.
3. **flowrunner arma el comando de desinstalar** según el lockfile: `npm uninstall`, `pnpm remove` o
   `yarn remove`, como los de instalar (ADR 0029). Aprobar no les elige versión.
4. **El plan que se aprueba lo muestra** («saca …»), y el prompt del planificador pide declararlo
   cuando un criterio o la feature pide sacar un paquete.

## Verificación

- `src/phases/implementar.test.ts`: una sub-task que saca paquetes tiene su comando de desinstalar,
  según el lockfile, y puede tocar el manifiesto.
- `src/gates/plan.test.ts`: sacar paquetes suma el manifiesto y el lockfile al alcance, como
  agregarlos.
