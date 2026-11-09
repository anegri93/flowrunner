#!/bin/sh
# Un CLI de Orca falso para los tests del worker: anota la llamada en $FAKE_LOG.
# `terminal list` contesta la terminal de $FAKE_TERMINAL en el worktree $FAKE_TERMINAL_PATH, como el
# CLI de Orca; lo demás solo se anota.
[ -n "$FAKE_LOG" ] && [ "$1" != "terminal" ] && printf 'orca %s\n' "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "terminal list" ] && [ -n "$FAKE_TERMINAL" ]; then
  printf '{"ok":true,"result":{"terminals":[{"handle":"%s","worktreePath":"%s"}]}}\n' "$FAKE_TERMINAL" "$FAKE_TERMINAL_PATH"
fi
exit 0
