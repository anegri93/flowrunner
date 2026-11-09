#!/bin/sh
# Un flowrunner falso para los tests del worker: responde con lo de test/ y anota cada llamada en
# $FAKE_LOG, si está definido.
dir=$(dirname "$0")
[ -n "$FAKE_LOG" ] && printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  watch) cat "$dir/watch.json" ;;
  report) printf '{"ok":true,"sesion":"%s","texto":"Edit src/precio.ts\\nlisto"}\n' "$4" ;;
  plan) printf 'PIZ-3 · esperando_aprobacion\n1 sub-tasks\n' ;;
  approve) printf '{"ok":true,"id":"%s","accion":"aprobado: implementar arrancó"}\n' "$2" ;;
  changes) printf '{"ok":true,"id":"%s","accion":"cambios pedidos: planificar vuelve a correr"}\n' "$2" ;;
  resume) printf '{"ok":false,"error":{"message":"el run %s está en_curso, no detenido","next":"flowrunner status %s"}}\n' "$2" "$2"; exit 1 ;;
  *) echo "comando desconocido: $1" >&2; exit 1 ;;
esac
