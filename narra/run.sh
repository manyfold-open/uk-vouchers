#!/bin/bash
set -eu
umask 077
cd "$(dirname "$0")"
set -a; source ./.env; set +a   # export so mf (model calls) sees MF_* too
exec 9>runtime.lock
flock -n 9 || exit 0
exec python3 -u runtime.py >>logs/runtime.log 2>&1
