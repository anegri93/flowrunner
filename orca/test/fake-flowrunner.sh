#!/bin/sh
# Un flowrunner falso para los tests del worker: responde watch y report con lo de test/.
dir=$(dirname "$0")
case "$1" in
  watch) cat "$dir/watch.json" ;;
  report) printf '{"ok":true,"sesion":"%s","texto":"Edit src/precio.ts\\nlisto"}\n' "$4" ;;
  *) echo "comando desconocido: $1" >&2; exit 1 ;;
esac
