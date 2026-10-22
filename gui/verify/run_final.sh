#!/bin/bash
# T5 orchestrator round 8: wait until server.mjs is complete AND starts, then run everything.
set -u
cd "/d/Projects/rea/Project work/shapez"

echo "[T5r9] waiting for server.mjs that (a) has no skeleton TODO markers and (b) actually starts — max 120 min..."
READY=0
for i in $(seq 1 480); do
  if [ -f gui/server.mjs ] && ! grep -q "TODO-5\|TODO(落盘后再补)\|见 TODO-5" gui/server.mjs; then
    # start test on a probe port
    node gui/server.mjs --no-open --port 7810 > /tmp/t5r8-start.log 2>&1 &
    SPID=$!
    OK=0
    for j in $(seq 1 10); do
      sleep 1
      if curl -s -m 2 http://127.0.0.1:7810/api/healthz | grep -q '"ok":true'; then OK=1; break; fi
      kill -0 $SPID 2>/dev/null || break
    done
    kill $SPID 2>/dev/null
    [ "$OK" = "1" ] && { echo "[T5r9] server.mjs complete and starts after $((i*15))s"; READY=1; break; }
  fi
  sleep 15
  if [ $((i % 20)) -eq 0 ]; then echo "[T5r9] still waiting ($((i*15))s)"; fi
done

if [ "$READY" != "1" ]; then
  echo "[T5r9] TIMEOUT — server.mjs never became complete+startable"
  exit 1
fi

sleep 10

echo "[T5r9] === 0. G4 regression (final) ==="
for t in test/mod_selftest.mjs test/mod_rpc_selftest.mjs test/blueprint_selftest.mjs test/lzstring_interop.mjs src/bridge/selftest.mjs src/mcp/selftest.mjs; do
  name=$(basename "$(dirname "$t")")_$(basename "$t" .mjs)
  node "$t" > "docs/gui/post-g4-$name.log" 2>&1
  echo "[T5r9] G4 $t -> exit $?"
done

echo "[T5r9] === 1. api_acceptance ==="
node gui/verify/api_acceptance.mjs --port 7801 > docs/gui/logs/api_acceptance.out 2>&1
echo "[T5r9] api_acceptance exit=$?"

echo "[T5r9] === 2. red_team ==="
node gui/verify/red_team.mjs --port 7802 > docs/gui/logs/red_team.out 2>&1
echo "[T5r9] red_team exit=$?"

echo "[T5r9] === 3. dom_gate ==="
node gui/verify/dom_gate.mjs --port 7803 > docs/gui/logs/dom_gate.out 2>&1
echo "[T5r9] dom_gate exit=$?"

echo "[T5r9] === 4. wizard_shots ==="
node gui/verify/wizard_shots.mjs --port 7804 > docs/gui/logs/wizard_shots.out 2>&1
echo "[T5r9] wizard_shots exit=$?"

echo "[T5r9] === DONE ==="
tail -3 docs/gui/logs/*.out 2>/dev/null
