#!/bin/bash
# T5 helper: wait until T1/T2/T3 outputs exist (max 3h), checking every 30s.
cd "/d/Projects/rea/Project work/shapez"
for i in $(seq 1 360); do
  if [ -f gui/server.mjs ] && [ -f gui/ui/index.html ]; then
    echo "READY after $((i*30))s: gui/server.mjs + gui/ui/index.html exist"
    ls -la gui/server.mjs gui/ui/index.html
    exit 0
  fi
  sleep 30
done
echo "TIMEOUT after 3h; still missing:"
[ -f gui/server.mjs ] || echo "  gui/server.mjs MISSING"
[ -f gui/ui/index.html ] || echo "  gui/ui/index.html MISSING"
exit 1
