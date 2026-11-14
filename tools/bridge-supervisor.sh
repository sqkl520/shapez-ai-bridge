#!/bin/sh
# bridge-supervisor.sh —— 桥的看护进程：挂了就自动拉起，永不放弃。
#
# 为什么需要它：实测（2026-11-14）桥会在「mod ready」之后静默消失，
# 而崩溃兜底记的是 crashes=0 —— 说明**不是异常退出，是被外部杀掉**。
# 心跳日志能精确到「最后一条存活记录」，但没法回答「谁杀的」。
#
# 在不查清凶手之前，最实用的对策是**自动拉起**：AI 后台循环不该因为
# 一个外部干扰就整夜停摆。
#
# 用法：
#   sh tools/bridge-supervisor.sh            # 前台看护（Ctrl-C 退出）
#   sh tools/bridge-supervisor.sh --daemon   # 后台看护（写 pid 文件）
#
# 行为：
#   · 每 5 秒检查一次 7777 是否在监听
#   · 不在就重启桥，并把这次重启记进 .bridge-restarts.log
#   · 重启间隔做指数退避（1s → 2s → 4s … 封顶 30s），防止「起来就崩」的空转
#   · 连续运行 60 秒后重置退避（说明这次启动是健康的）

cd "$(dirname "$0")/.." || exit 1

DAEMON=0
[ "$1" = "--daemon" ] && DAEMON=1

LOG=".bridge-restarts.log"
PIDFILE=".bridge-supervisor.pid"
BACKOFF=1

listening() {
    netstat -ano 2>/dev/null | grep -q ":7777.*LISTENING"
}

start_bridge() {
    nohup node src/bridge/bridge.mjs >> .bridge.log 2>&1 &
    echo $! > .bridge.pid
}

logrestart() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restart #$1 (backoff ${BACKOFF}s)" >> "$LOG"
}

supervise() {
    N=0
    while :; do
        if ! listening; then
            N=$((N + 1))
            logrestart "$N"
            sleep "$BACKOFF"
            start_bridge
            # 指数退避，封顶 30 秒
            BACKOFF=$((BACKOFF * 2))
            [ "$BACKOFF" -gt 30 ] && BACKOFF=30
            sleep 5
            continue
        fi
        # 活着：连续 60 秒健康就重置退避
        BACKOFF=1
        sleep 5
    done
}

if [ "$DAEMON" = "1" ]; then
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "supervisor 已在跑 (pid $(cat "$PIDFILE"))"
        exit 0
    fi
    nohup sh "$0" >> .bridge-supervisor.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "✓ supervisor 已后台启动 pid=$(cat "$PIDFILE")"
    exit 0
fi

echo "supervisor 启动（Ctrl-C 退出）。日志：$LOG"
supervise
