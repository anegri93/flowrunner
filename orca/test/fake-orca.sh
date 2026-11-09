#!/bin/sh
# Un CLI de Orca falso para los tests del worker: anota la llamada en $FAKE_LOG.
[ -n "$FAKE_LOG" ] && printf 'orca %s\n' "$*" >> "$FAKE_LOG"
exit 0
