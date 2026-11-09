#!/bin/sh
# Un flowrunner falso para los tests del worker: responde con lo de test/, o con $FAKE_WATCH para
# watch, y anota cada llamada en $FAKE_LOG, si está definido.
dir=$(dirname "$0")
[ -n "$FAKE_LOG" ] && printf '%s\n' "$*" >> "$FAKE_LOG"
# El entorno con que llegó, para comprobar que el worker no pasa el de Orca tal cual.
[ -n "$FAKE_ENV_LOG" ] && printf 'USER=%s LOGNAME=%s ELECTRON_RUN_AS_NODE=%s NODE_CHANNEL_FD=%s\n' "$USER" "$LOGNAME" "$ELECTRON_RUN_AS_NODE" "$NODE_CHANNEL_FD" >> "$FAKE_ENV_LOG"
case "$1" in
  watch) cat "${FAKE_WATCH:-$dir/watch.json}" ;;
  report)
    if [ "$3" = "--sesion" ]; then printf '{"ok":true,"sesion":"%s","texto":"Edit src/precio.ts\\nlisto"}\n' "$4"
    else printf '{"ok":true,"informe":"# %s\\n\\n- **Estado:** cerrado"}\n' "$2"; fi ;;
  status) printf '{"ok":true,"run":{"id":"%s","clave":"%s","repo":"%s"}}\n' "$2" "${2%-*-*}" "${FAKE_REPO:-/r}" ;;
  plan) printf '{"ok":true,"plan":"# Plan\\nModo oscuro con variables.","subtareas":[{"id":"ST-1","titulo":"Variables de color"}],"criterios":[{"id":"AC-1"}],"cambios":{"subtareas_agregadas":["ST-1 Variables de color"],"subtareas_quitadas":[]}}\n' ;;
  approve) printf '{"ok":true,"id":"%s","accion":"aprobado: implementar arrancó"}\n' "$2" ;;
  changes) printf '{"ok":true,"id":"%s","accion":"cambios pedidos: planificar vuelve a correr"}\n' "$2" ;;
  abort) printf '{"ok":true,"id":"%s","accion":"abortado; las ramas quedan"}\n' "$2" ;;
  learn) printf '{"ok":true,"id":"%s","resultado":"la PR sigue abierta"}\n' "$2" ;;
  resume) printf '{"ok":false,"error":{"message":"el run %s está en_curso, no detenido","next":"flowrunner status %s"}}\n' "$2" "$2"; exit 1 ;;
  *) echo "comando desconocido: $1" >&2; exit 1 ;;
esac
