#!/usr/bin/env bash
# L12 多轮推进：每次 5 轮，靠跨 run 记忆累积。
# 每跑完一次就打印当前进度，跑够次数或达成目标为止。
set -u
cd "$(dirname "$0")/.."

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-<REDACTED-API-KEY>}"
BASE="https://api.example.test"
MODEL="virtual/opus"
GOAL="CbCbCbRb:CwCwCwCw"
N="${1:-10}"

for i in $(seq 1 "$N"); do
  echo "════════ run $i / $N ════════"
  node src/agent/loop.mjs --goal "$GOAL" --llm \
    --base-url "$BASE" --model "$MODEL" \
    --max-tokens 16000 --max-rounds 5 2>&1 | tail -6

  # 进度
  curl -s -m 20 -X POST http://127.0.0.1:7777/rpc -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"obs","params":{"include_resources":false}}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const g=JSON.parse(s).result.goal;
        console.log('→ L'+g.level, g.requirement.shape, g.requirement.delivered+'/'+g.requirement.required);
        if(g.level!==12) process.exit(3);
      }catch(e){console.log('→ 读取失败')}
    })" || { echo "L12 已达成或被推进到更高关卡，停止"; break; }
  sleep 3
done
