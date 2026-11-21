#!/usr/bin/env bash
# live-run.sh —— 安全地跑一轮**真机** agent loop，并给出「世界到底变没变」的可读摘要。
#
# ══════════════════════════════════════════════════════════════════════════
# 这个脚本解决的是「手工拼命令」的四个坑
# ══════════════════════════════════════════════════════════════════════════
#
# 坑 1｜本机 gateway 只支持 Codex 协议
#   POST /v1/messages → 503 · POST /responses → 200
#   所以默认 `--base-url` 指向 `…/responses`，llm.mjs 会自动切到 codex 适配。
#
# 坑 2｜`ANTHROPIC_BASE_URL` 被 Claude Desktop 占用
#   本机它是 `http://127.0.0.1:15721/claude-desktop`（那个前缀是给 IDE 用的，
#   直接拿它当网关会 401）。本脚本**刻意清掉**这个变量，绝不读它。
#
# 坑 3｜跑一次要手工拼一长串参数 + 备份
#   参数显式传；跑前自动抓基线，跑后自动抓对比，结束打印一段人话摘要。
#
# 坑 4｜没有「改得好不好」的判据
#   摘要由 tools/live-diff.mjs 生成：`delivered` 之外还看 `produced_total`
#   与死带子的 uid 级归因，能区分「什么都没做」「施工中」「改坏了」。
#
# ══════════════════════════════════════════════════════════════════════════
# 用法
# ══════════════════════════════════════════════════════════════════════════
#
#   bash tools/live-run.sh --dry-run
#   bash tools/live-run.sh --goal "CbCbCbRb:CwCwCwCw" --rounds 2
#   bash tools/live-run.sh --goal ... --rounds 3 --checkpoint pre-run
#   bash tools/live-run.sh --rollback pre-run        # 不满意就回滚
#   bash tools/live-run.sh --list-checkpoints
#
# 参数：
#   --goal SHAPE          目标形状（默认 CbCbCbRb:CwCwCwCw）
#   --rounds N            最多轮数（默认 2）
#   --model ID            LLM 模型（默认 gpt-5.6-luna）
#   --base-url URL        网关地址（默认 http://127.0.0.1:15721/responses）
#   --api-key KEY         密钥（默认 PROXY_MANAGED：网关自己管鉴权）
#   --bridge URL          桥地址（默认 http://127.0.0.1:7777）
#   --run-root DIR        run 产物根目录（默认 research/ai-plan/runs）
#   --checkpoint NAME     跑之前拍一个 checkpoint（默认 <run-id>）
#   --rollback NAME       不跑 loop，只调 checkpoint_restore 并报告
#   --list-checkpoints    列出游戏里的 checkpoint 然后退出
#   --dry-run             只做检查 + 基线，不跑 loop（世界零写入）
#   --no-checkpoint       跑前不拍 checkpoint（不推荐）
#   --yes                 跳过「实验存档确认」的交互确认（非 tty 时必须给）
#
# 安全边界（硬约束，写在代码里而不是文档里）：
#   · 只许碰实验存档 7c93b3dd…；用户存档 5c967065… 连读都不许 → --check 里硬拒
#   · 绝不 Stop-Process / kill 游戏进程
#   · 绝不读 ANTHROPIC_BASE_URL
#   · --dry-run 绝不发 tx / act / save / checkpoint_save
#
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

BRIDGE="${BRIDGE_URL:-http://127.0.0.1:7777}"
GOAL="CbCbCbRb:CwCwCwCw"
ROUNDS=2
MODEL="gpt-5.6-luna"
BASE_URL="http://127.0.0.1:15721/responses"
API_KEY="PROXY_MANAGED"
RUN_ROOT="research/ai-plan/runs"
CKPT=""
ROLLBACK=""
LIST_CKPTS=0
DRY_RUN=0
NO_CKPT=0
ASSUME_YES=0

EXPECT_SAVE_FULL="7c93b3dd9e949c561e5aa529974973b18c856b45"
EXPECT_SAVE_SHORT="7c93b3dd"

while [ $# -gt 0 ]; do
  case "$1" in
    --goal)            GOAL="${2:-}"; shift 2 ;;
    --rounds)          ROUNDS="${2:-}"; shift 2 ;;
    --model)           MODEL="${2:-}"; shift 2 ;;
    --base-url)        BASE_URL="${2:-}"; shift 2 ;;
    --api-key)         API_KEY="${2:-}"; shift 2 ;;
    --bridge)          BRIDGE="${2:-}"; shift 2 ;;
    --run-root)        RUN_ROOT="${2:-}"; shift 2 ;;
    --checkpoint)      CKPT="${2:-}"; shift 2 ;;
    --rollback)        ROLLBACK="${2:-}"; shift 2 ;;
    --list-checkpoints) LIST_CKPTS=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --no-checkpoint)   NO_CKPT=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    --help|-h)
      sed -n '30,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "✗ 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
hdr()  { say ""; say "════════════════════════════════════════════════════════════"; say "$*"; say "════════════════════════════════════════════════════════════"; }
ok()   { say "  ✓ $*"; }
warn() { say "  ⚠ $*"; }
bad()  { say "  ✗ $*"; }
die()  { say ""; say "✗ 中止：$*"; exit 3; }

# ── 桥 RPC 小工具（只读方法用）──────────────────────────────────────────────
rpc() { # rpc <method> <json-params>
  curl -s -m "${3:-60}" -X POST "$BRIDGE/rpc" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-{\}}}" 2>/dev/null
}
rpc_field() { # rpc_field <method> <js-expr> [params]
  rpc "$1" "${3:-{\}}" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const j=JSON.parse(s); const v=(function(r){ return $2; })(j.result);
        if(v===undefined||v===null) process.stdout.write(''); else process.stdout.write(String(v));
      }catch(e){process.stdout.write('')}
    })"
}

# ── 0. 环境自检：绝不读 ANTHROPIC_BASE_URL ──────────────────────────────────
# 本机这个变量指向 Claude Desktop 的 IDE 网关（…/claude-desktop），拿它当 LLM
# 网关会 401。显式 unset，防止任何下游库偷偷读它。
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  warn "环境里有 ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}（Claude Desktop 占用）—— 已刻意忽略并清除"
fi
unset ANTHROPIC_BASE_URL
# 密钥同理：本脚本用 --api-key 显式传，不依赖环境变量。
export ANTHROPIC_API_KEY="$API_KEY"

hdr "live-run  —  goal=$GOAL  rounds=$ROUNDS  model=$MODEL"
say "  网关    $BASE_URL"
say "  桥      $BRIDGE"
say "  run 根  $RUN_ROOT"
[ "$DRY_RUN" = 1 ] && say "  ★ DRY-RUN：只做检查与基线，世界零写入"

# ── 1. 只列 checkpoint ──────────────────────────────────────────────────────
if [ "$LIST_CKPTS" = 1 ]; then
  hdr "checkpoint 列表"
  rpc checkpoint_list '{}' | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const j=JSON.parse(s);
        if(j.error){console.log('✗ '+j.error.message);return}
        const r=j.result||{};
        console.log('总数 '+r.total_entities+' 实体, 上限 '+r.max_count+' 个');
        for(const it of (r.items||[])) console.log('  · '+(it.name||'?')+'  entities='+it.entities+'  tick='+(it.tick==null?'-':Math.round(it.tick)));
      }catch(e){console.log('✗ 解析失败：'+e.message)}
    })"
  exit 0
fi

# ── 2. 回滚模式：不跑 loop ──────────────────────────────────────────────────
if [ -n "$ROLLBACK" ]; then
  hdr "回滚到 checkpoint：$ROLLBACK"
  SAVE="$(rpc_field debug_app_state 'r.savegame&&r.savegame.internal_id')"
  if [ "$SAVE" != "$EXPECT_SAVE_FULL" ]; then
    die "当前载入的存档是 ${SAVE:-<读不到>}，不是实验存档 $EXPECT_SAVE_SHORT —— 拒绝回滚"
  fi
  BEFORE_SEEN="$(rpc_field status 'r.hub_level')"
  # checkpoint_restore 会改世界：是写操作，所以 --dry-run 下不许执行。
  if [ "$DRY_RUN" = 1 ]; then
    warn "DRY-RUN 下不执行 checkpoint_restore（它改写世界）。去掉 --dry-run 才会真回滚。"
    exit 0
  fi
  RES="$(rpc checkpoint_restore "{\"name\":\"$ROLLBACK\"}" 180)"
  echo "$RES" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const j=JSON.parse(s);
        if(j.error){console.log('✗ restore 失败: '+j.error.message);process.exitCode=1;return}
        const r=j.result||{};
        console.log('  ok='+r.ok+'  name='+(r.name||'-'));
        if(r.after) console.log('  实体 '+r.after.entities+' / 期望 '+r.after.expected);
        if(r.verified!==undefined) console.log('  自证 verified='+r.verified+'  uid_set_equal='+r.uid_set_equal+'  geometry_mismatch='+r.geometry_mismatch);
        if(Array.isArray(r.errors)&&r.errors.length) console.log('  错误: '+JSON.stringify(r.errors).slice(0,300));
        console.log((r.ok===true&&r.verified!==false)?'  ✓ 已回滚':'  ✗ 回滚未确认成功');
      }catch(e){console.log('✗ 解析失败：'+e.message)}
    })"
  say ""
  say "  回滚只恢复**拓扑**。带上货与已入库的交付恢复不了（见 tx-last.json boundaries.non_serialized_state）。"
  exit 0
fi

# ── 3. 健康 + 存档身份检查（硬门禁）────────────────────────────────────────
hdr "① 桥健康 / 存档身份"
CHK_OUT="$(node tools/live-diff.mjs --check --bridge "$BRIDGE" 2>&1)"
CHK_CODE=$?
say "$CHK_OUT"
if [ "$CHK_CODE" != 0 ]; then
  die "安全检查没过（退出码 $CHK_CODE）。上面每一条 ✗ 都要先解决。"
fi
SAVE_ID="$(rpc_field debug_app_state '(r.savegame&&r.savegame.internal_id)||""')"
case "$SAVE_ID" in
  "$EXPECT_SAVE_SHORT"*) ok "载入存档 = $SAVE_ID" ;;
  *) die "载入存档 ${SAVE_ID:-<读不到>} ≠ 实验存档 $EXPECT_SAVE_SHORT" ;;
esac

# ── 3b. LLM 网关预检（花 0 次调用，只探连通性与协议）────────────────────────
# 为什么必须**在跑 loop 之前**查：`--base-url` 写成 Anthropic 形状的地址时，
# 本机 gateway 会回 503，而 loop 里那条失败会表现为 `LLM_NOT_JSON: output is empty`
# —— 看起来像模型不会输出 JSON，实际是打错了协议。方向会被带偏一整轮。
case "$BASE_URL" in
  */responses) ok "网关走 Codex 协议（…/responses）—— llm.mjs 会自动切 protocol=codex" ;;
  */v1/messages) bad "网关地址是 Anthropic Messages 形状。本机 gateway 的 /v1/messages 会 503 —— 换成 …/responses" ;;
  *) warn "网关地址既不以 /responses 也不以 /v1/messages 结尾，llm.mjs 会拼成 <base>/v1/messages" ;;
esac
GW_ORIGIN="$(printf '%s' "$BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
GW_CODE="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$GW_ORIGIN" 2>/dev/null || echo '000')"
if [ "$GW_CODE" = "000" ]; then
  bad "网关不可达：$GW_ORIGIN（连 TCP 都不通）"
  [ "$DRY_RUN" = 1 ] || die "网关不可达，跑 loop 只会得到 LLM_TRANSPORT"
else
  ok "网关可达：$GW_ORIGIN（HTTP $GW_CODE）"
fi

# ── 4. 交互确认（非 tty 时必须 --yes / --dry-run）────────────────────────────
if [ "$DRY_RUN" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  if [ -t 0 ]; then
    say ""
    printf '即将在实验存档 %s 上真机跑 %s 轮 loop（会写入世界）。继续？[y/N] ' "$EXPECT_SAVE_SHORT" "$ROUNDS"
    read -r ANS
    case "$ANS" in y|Y|yes|YES) ;; *) die "用户取消" ;; esac
  else
    die "非交互环境下要真机跑必须显式给 --yes（或先用 --dry-run 看检查）"
  fi
fi

# ── 5. 基线快照 + checkpoint ────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SESSION_DIR="$ROOT/.tmp-live/run-$STAMP"
mkdir -p "$SESSION_DIR"
hdr "② 基线"
node tools/live-diff.mjs --capture --bridge "$BRIDGE" --label before --out "$SESSION_DIR/baseline.json" \
  || die "基线抓取失败"
# 路径里可能有空格（本仓就在 "Project work" 下），所以把文件走 argv 传，
# 不要把路径拼进 -e 的源码字符串里。
BASE_TICK="$(node -e 'const fs=require("fs");console.log(Math.round(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).obs.tick))' "$SESSION_DIR/baseline.json" 2>/dev/null || echo '?')"

# 记下跑之前已存在的 run 目录，跑完只认**新增**的那个
# （否则 loop 崩溃没写盘时，会把上一次的旧 run 当成这次的）。
RUNS_BEFORE="$SESSION_DIR/runs-before.txt"
ls -1 "$RUN_ROOT" 2>/dev/null | grep '^r-' | sort > "$RUNS_BEFORE" || : > "$RUNS_BEFORE"

if [ "$NO_CKPT" = 0 ]; then
  CKPT="${CKPT:-live-$STAMP}"
  hdr "③ checkpoint"
  if [ "$DRY_RUN" = 1 ]; then
    warn "DRY-RUN：跳过 checkpoint_save（它本身不写世界，但没必要）—— 真跑时会拍 \"$CKPT\""
  else
    CK_OUT="$(rpc checkpoint_save "{\"name\":\"$CKPT\"}" 120)"
    echo "$CK_OUT" | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const j=JSON.parse(s);
          if(j.error){console.log('  ✗ checkpoint_save 失败: '+j.error.message);process.exitCode=1;return}
          const r=j.result||{};
          console.log('  ✓ checkpoint \"'+(r.name||'?')+'\" entities='+r.entities+' skipped='+r.skipped+(r.dropped&&r.dropped.length?' dropped='+r.dropped.join(','):''));
        }catch(e){console.log('  ✗ 解析失败：'+e.message)}
      })"
    CK_SAVED=$?
    [ "$CK_SAVED" != 0 ] && warn "checkpoint 没拍成 —— 跑完之后若想回滚将没有退路（继续，但请谨慎）"
  fi
else
  warn "按 --no-checkpoint 跳过了 checkpoint —— 跑完不满意**无法回滚**"
fi

if [ "$DRY_RUN" = 1 ]; then
  hdr "DRY-RUN 结束"
  say "  检查全过、基线已抓（tick=$BASE_TICK）。没有跑 loop，世界零写入。"
  say "  基线文件：$SESSION_DIR/baseline.json"
  say ""
  say "  真跑会执行："
  say "    node src/agent/loop.mjs --goal \"$GOAL\" --llm --base-url \"$BASE_URL\" \\"
  say "      --model \"$MODEL\" --api-key '$API_KEY' --max-rounds $ROUNDS --run-dir \"$RUN_ROOT\""
  say "    （然后抓对比快照并输出摘要）"
  exit 0
fi

# ── 6. 跑 loop ──────────────────────────────────────────────────────────────
hdr "④ 跑 loop（rounds=$ROUNDS）"
LOOP_LOG="$SESSION_DIR/loop.log"
# 不用 `set -e`，所以退出码直接取 —— 但管道要显式取第一个进程的码（tee 的码恒 0）。
node src/agent/loop.mjs \
  --goal "$GOAL" \
  --llm \
  --base-url "$BASE_URL" \
  --model "$MODEL" \
  --api-key "$API_KEY" \
  --max-rounds "$ROUNDS" \
  --run-dir "$RUN_ROOT" 2>&1 | tee "$LOOP_LOG"
LOOP_CODE="${PIPESTATUS[0]}"
say ""
case "$LOOP_CODE" in
  0) ok "loop 退出码 0（outcome=success：目标达成）" ;;
  2) ok "loop 退出码 2（outcome=halt：预算用尽/无进展，正常结束）" ;;
  *) bad "loop 退出码 $LOOP_CODE —— 见 $LOOP_LOG" ;;
esac

# 找出这次**新增**的 run 目录。不能取 mtime 最新的那个 —— loop 崩溃没写盘时，
# 那会把上一次的旧 run 当成这次的，摘要就答非所问。
RUN_ID="$(node -e '
  const fs=require("fs");
  const root=process.argv[1], beforeFile=process.argv[2];
  const before=new Set(fs.readFileSync(beforeFile,"utf8").split(/\r?\n/).filter(Boolean));
  const fresh=fs.readdirSync(root).filter(d=>d.startsWith("r-")&&!before.has(d));
  if(fresh.length) process.stdout.write(fresh.sort().slice(-1)[0]);
' "$RUN_ROOT" "$RUNS_BEFORE" 2>/dev/null || echo '')"
if [ -z "$RUN_ID" ]; then
  warn "在 $RUN_ROOT 里没有新增 run 目录 —— 跳过 run 内部对比（loop 可能没跑到写盘）"
else
  ok "本次 run 目录：$RUN_ROOT/$RUN_ID"
fi

# ── 7. 抓对比快照 + 摘要 ────────────────────────────────────────────────────
hdr "⑤ 世界到底变没变"
# 给产线一点时间把货淌出来。这个等待是**必须**的，不是保险：
# 真机实测（`.findings/LIVE-E2E-2026-11-21.md` §5）tx 落地后货立刻开始淌，
# 但 painter→stacker→rotater 三层链的第一件货要 60 秒以上才到 hub，
# 而那一次 run 的 9 件真交付**全部发生在 run 结束之后**。
# 默认 45 秒是折中；链条更深时用 LIVE_RUN_SETTLE_SECS=120 覆盖。
WAIT_SECS="${LIVE_RUN_SETTLE_SECS:-45}"
say "  等待 ${WAIT_SECS}s 让产线淌货（LIVE_RUN_SETTLE_SECS 可覆盖）…"
sleep "$WAIT_SECS"
CAPTURE_OK=0
if node tools/live-diff.mjs --capture --bridge "$BRIDGE" --label after --out "$SESSION_DIR/after.json" 2>"$SESSION_DIR/capture.err"; then
  CAPTURE_OK=1
else
  bad "对比快照抓取失败：$(head -3 "$SESSION_DIR/capture.err" 2>/dev/null)"
fi

if [ "$CAPTURE_OK" = 1 ]; then
  say ""
  say "  ── A. 这次 run 到底把世界改成了什么样（跑前基线 → 跑完 ${WAIT_SECS}s 后）──"
  say "     这是**主判据**：目标有没有进展、产出有没有从零到有、原有活线有没有被改死"
  node tools/live-diff.mjs --baseline "$SESSION_DIR/baseline.json" --after "$SESSION_DIR/after.json" || true
  if [ -n "$RUN_ID" ] && [ -f "$RUN_ROOT/$RUN_ID/obs-last.json" ]; then
    say ""
    say "  ── B. run 自己判得对不对（run 末轮快照 → 跑完 ${WAIT_SECS}s 后）──"
    say "     B 里头新冒出来的产出，就是 run 的 L4 窗口**关早了一步**漏掉的"
    node tools/live-diff.mjs --a "$RUN_ROOT/$RUN_ID" --b "$SESSION_DIR/after.json" || true
  fi
fi

# ── 8. 收尾 ─────────────────────────────────────────────────────────────────
hdr "结束"
say "  会话目录：$SESSION_DIR"
say "    baseline.json  跑前世界"
say "    after.json     跑后世界（${WAIT_SECS}s 后）"
say "    loop.log       loop 的完整终端输出"
[ -n "$RUN_ID" ] && say "    run 产物      $RUN_ROOT/$RUN_ID（timeline.log 是人读版）"
if [ "$NO_CKPT" = 0 ]; then
  say ""
  say "  不满意就回滚："
  say "    bash tools/live-run.sh --rollback ${CKPT:-live-$STAMP}"
fi
say "  注意：回滚只恢复拓扑，带上货与已入库的交付恢复不了。"
exit 0
