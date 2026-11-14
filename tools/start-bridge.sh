#!/bin/sh
# 启动桥，脱离父进程。用 nohup + &，比 PowerShell Start-Process 可靠。
cd "$(dirname "$0")/.." || exit 1
if netstat -ano 2>/dev/null | grep -q ":7777.*LISTENING"; then
  echo "桥已经在跑（7777 已监听）"
  exit 0
fi
nohup node src/bridge/bridge.mjs > .bridge.log 2>&1 &
echo "桥已启动 pid=$!"
sleep 3
if netstat -ano 2>/dev/null | grep -q ":7777.*LISTENING"; then
  echo "✓ 7777 已监听"
else
  echo "✗ 启动失败，看 .bridge.log"
  tail -20 .bridge.log
  exit 1
fi
