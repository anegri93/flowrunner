#!/bin/sh
# Sale 0 solo si el repo está en verde. flowrunner lo corre sobre la base y sobre cada feature.
set -e
pnpm lint
pnpm test
