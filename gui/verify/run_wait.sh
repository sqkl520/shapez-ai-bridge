#!/bin/bash
# T5 orchestrator: wait for T1-T4 artifacts, then run the full verification chain.
# Usage: bash gui/verify/run_all.sh
set -u
cd "/d/Projects/rea/Project work/shapez"

echo "[T5] waiting for gui/server.mjs + gui/ui/index.html (max 100 min)..."
for i in $(seq 1 200); do
  if [ -f gui/server.mjs ] && [ -f gui/ui/index.html ]; then
    echo "[T5] artifacts present after $((i*30))s"
    break
  fi
  sleep 30
  if [ $((i % 10)) -eq 0 ]; then
    echo "[T5] still waiting ($((i*30))s): server=$([ -f gui/server.mjs ] && echo yes || echo no) ui=$([ -f gui/ui/index.html ] && echo yes || echo no)"
  fi
done

if [ ! -f gui/server.mjs ] || [ ! -f gui/ui/index.html ]; then
  echo "[T5] TIMEOUT — artifacts never arrived; writing blocked state"
  exit 1
fi

# let T2/T3 finish writing (settle 20s, check stability)
sleep 20

echo "[T5] === 0. G4 regression (post-merge) ==="
for t in test/mod_selftest.mjs test/mod_rpc_selftest.mjs test/blueprint_selftest.mjs test/lzstring_interop.mjs src/bridge/selftest.mjs src/mcp/selftest.mjs; do
  name=$(basename "$(dirname "$t")")_$(basename "$t" .mjs)
  node "$t" > "docs/gui/post-g4-$name.log" 2>&1
  echo "[T5] G4 $t -> exit $?"
done

echo "[T5] === 1. api_acceptance ==="
node gui/verify/api_acceptance.mjs --port 7801 > docs/gui/logs/api_acceptance.out 2>&1
echo "[T5] api_acceptance exit=$?"

echo "[T5] === 2. red_team ==="
node gui/verify/red_team.mjs --port 7802 > docs/gui/logs/red_team.out 2>&1
echo "[T5] red_team exit=$?"

echo "[T5] === 3. dom_gate ==="
node gui/verify/dom_gate.mjs --port 7803 > docs/gui/logs/dom_gate.out 2>&1
echo "[T5] dom_gate exit=$?"

echo "[T5] === 4. wizard_shots ==="
node gui/verify/wizard_shots.mjs --port 7804 > docs/gui/logs/wizard_shots.out 2>&1
echo "[T5] wizard_shots exit=$?"

echo "[T5] === DONE ==="
tail -3 docs/gui/logs/*.out
