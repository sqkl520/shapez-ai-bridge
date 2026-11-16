#!/usr/bin/env bash
# Run the agent loop N times in sequence, printing progress after each run.
# Stops early when the level changes (goal reached or advanced).
#
# Usage:
#   ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... ./tools/run-level.sh [COUNT]
#
# Environment:
#   ANTHROPIC_API_KEY   required — your API key
#   ANTHROPIC_BASE_URL  required — API base URL (e.g. https://api.anthropic.com)
#   AGENT_MODEL         optional — model id (default: claude-sonnet-5-5)
#   AGENT_GOAL          optional — target shape (default: CbCbCbRb:CwCwCwCw)
#   AGENT_LEVEL         optional — expected level number (default: 12)
#   BRIDGE_URL          optional — bridge RPC endpoint (default: http://127.0.0.1:7777)
set -u
cd "$(dirname "$0")/.."

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL is required}"

BASE="$ANTHROPIC_BASE_URL"
MODEL="${AGENT_MODEL:-claude-sonnet-5-5}"
GOAL="${AGENT_GOAL:-CbCbCbRb:CwCwCwCw}"
LEVEL="${AGENT_LEVEL:-12}"
RPC="${BRIDGE_URL:-http://127.0.0.1:7777}"
N="${1:-10}"

# Exported for the node one-liner inside the loop (it reads AGENT_LEVEL).
export ANTHROPIC_API_KEY AGENT_LEVEL="$LEVEL"

for i in $(seq 1 "$N"); do
  echo "════════ run $i / $N ════════"
  node src/agent/loop.mjs --goal "$GOAL" --llm \
    --base-url "$BASE" --model "$MODEL" \
    --max-tokens 16000 --max-rounds 5 2>&1 | tail -6

  # Progress: read the current goal from the running game via the bridge.
  curl -s -m 20 -X POST "$RPC/rpc" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"obs","params":{"include_resources":false}}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const g=JSON.parse(s).result.goal;
        console.log('→ L'+g.level, g.requirement.shape, g.requirement.delivered+'/'+g.requirement.required);
        if(g.level!==Number(process.env.AGENT_LEVEL)) process.exit(3);
      }catch(e){console.log('→ read failed')}
    })" || { echo "level changed — stopping"; break; }
  sleep 3
done
