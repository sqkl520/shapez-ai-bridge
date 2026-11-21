# 真机跑一轮 loop：可重复的范式（LIVE-RUN）

> 本文档写给「要在真机上跑一次 agent loop」的人/agent。
> 两个工具：`tools/live-run.sh`（安全地跑）与 `tools/live-diff.mjs`（判断改得好好）。
> 协议层的坑（本机 gateway 只支持 Codex）见
> `research/ai-plan/LIVE-VERIFY-BRIEF.md` §2.2b，本文只讲**怎么用**。

---

## 0. 安全边界（违反即事故）

| 规则 | 实现位置 |
|---|---|
| 只许碰实验存档 `7c93b3dd…` | `live-diff.mjs --check` 硬拒；`live-run.sh` 跑前再查一次 |
| 用户正式存档 `5c967065…` **连读都不许** | `--check` 里是一级错误（不是警告） |
| 绝不 `Stop-Process -Force` / kill 游戏 | 两个工具都**不碰进程**，只发 RPC |
| 只读工具不发写操作 | `--check` / `--capture` 只发 obs/items/production/status/debug_app_state |
| `--dry-run` 世界零写入 | 不跑 loop、不拍 checkpoint、不 restore |

回滚**只恢复拓扑**：`BeltPath.items` 不在实体 schema 里，带上货与已入库的交付恢复不了
（见任何 `tx-last.json` 的 `boundaries.non_serialized_state`）。

---

## 1. `tools/live-run.sh`

### 1.1 它替你做了什么

```
① 桥健康 + 存档身份（硬门禁，不过就中止）
② 抓基线快照（delivered / items_on_belts / belts_deliverable / tick）
③ 拍 checkpoint（跑完不满意可回滚）
④ 跑 loop（参数显式，不读 ANTHROPIC_BASE_URL）
⑤ 等产线淌货 → 抓对比快照 → 输出人话摘要
```

### 1.2 用法

```bash
# 只做检查与基线，不跑 loop（世界零写入）—— 永远先跑这个
bash tools/live-run.sh --dry-run

# 真跑
bash tools/live-run.sh --goal "CbCbCbRb:CwCwCwCw" --rounds 2 --yes

# 跑完不满意 → 回滚（用第 ⑤ 步打印的 checkpoint 名）
bash tools/live-run.sh --rollback live-20261121-223920

# 看游戏里现有哪些 checkpoint
bash tools/live-run.sh --list-checkpoints
```

### 1.3 全部参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--goal SHAPE` | `CbCbCbRb:CwCwCwCw` | 目标形状 |
| `--rounds N` | `2` | `--max-rounds` |
| `--model ID` | `gpt-5.6-luna` | gateway 上的模型 |
| `--base-url URL` | `http://127.0.0.1:15721/responses` | 必须以 `/responses` 结尾（Codex 协议） |
| `--api-key KEY` | `PROXY_MANAGED` | 网关自己管上游鉴权，非空即可 |
| `--bridge URL` | `http://127.0.0.1:7777` | 也读 `BRIDGE_URL` |
| `--run-root DIR` | `research/ai-plan/runs` | run 产物根目录 |
| `--checkpoint NAME` | `live-<时间戳>` | 跑前拍的 checkpoint 名 |
| `--rollback NAME` | — | 不跑 loop，只 restore 并报告 |
| `--list-checkpoints` | — | 列 checkpoint 后退出 |
| `--dry-run` | — | 只检查 + 基线 |
| `--no-checkpoint` | — | 跑前不拍（不推荐） |
| `--yes` | — | 非 tty 下真跑必须给 |
| `LIVE_RUN_SETTLE_SECS`（env） | `45` | 跑完等多久让产线淌货再抓对比（三层链建议 120） |

### 1.4 为什么 `--check` 是硬门禁而不是提示

三个**看起来正常、实则会让整轮 run 白跑**的状态：

1. **载入的是别的存档** → 所有写入落到错误的世界（最严重）。
2. **`paused=true` 或 tick 不推进** → 产线不流动，L4 必然判「一件都没产出」，
   而那不是修法无效（实测 `raf-stall-not-window`：加载链挂在 rAF 上）。
   `--check` 采两次 tick 间隔 2 秒，Δ≤0 就警告。
3. **`allow_write=false`（read_only 桥）** → 每个 tx 都被 1004 拒，但 loop 不会崩，
   只会一路报 `NO_REVERSIBLE_CALL`，看起来像模型不会写计划。

`--check` 的 tick 活性采样用 `max_entities:1`，耗时与 payload 都可忽略。

### 1.5 退出码

| 码 | 含义 |
|---|---|
| `0` | 正常（dry-run 结束 / 真跑结束 / 回滚完成） |
| `2` | 参数错误 |
| `3` | 安全检查没过 / 存档身份不对 / 用户取消 |

---

## 2. `tools/live-diff.mjs`

### 2.1 四种模式

```bash
# 两个 run 目录对比（离线，最常用）
node tools/live-diff.mjs --a research/ai-plan/runs/r-20261121072433-521e \
                         --b research/ai-plan/runs/r-20261121190439-6190

# 快照文件 / run 目录混用
node tools/live-diff.mjs --baseline .tmp-live/run-xxx/baseline.json --after <run-dir>

# 抓当前真机世界成快照（只读）
node tools/live-diff.mjs --capture --out .tmp-live/base.json --label before

# 只做安全检查（live-run.sh 的①步就是它）
node tools/live-diff.mjs --check

# 机器可读
node tools/live-diff.mjs --a ... --b ... --json
```

`--a`/`--b` 可以是 ：run 目录 · 本工具的快照 JSON · 裸 obs dump（有 `entities`+`goal` 即可）。

### 2.2 它比「读 transcript」多看到了什么

**① 产出 ≠ 交付。**
`delivered` 是两个 *窗口* 的增量，窗口一关就归零。真机
`r-20261121190439-6190`：`delivered` 0→0，但 `produced_total` 从 `{}` 变成
`{----CgCg:4}`，`hub.stored` 里 `CgScScCg` 真的 +9。只盯 delivered 会以为世界没动。

**② 死带子的 uid 级归因。**
`belts_dead` 390→413 会被判 regressive，但归因显示：

```
原有活线变死 : 0 条
新铺的死带子 : 29 条  17649..17677   （源头 miner×14 / mixer×15）
删掉的死带子 : 6 条   17024, 17179..17183
→ 原有活线一条没死
```

+23 = 新铺 29 − 删 6，**一条原有活线都没变死**。指标方向与事实相反。
归因对两份口径都做：几何口径（`belts_dead`）与类型口径（`belts_undeliverable`，
扣掉「几何通到 hub 但运颜料」）。

**③ 同世界校验。**
两份快照 `savegame_internal_id` 不同时会明确警告「下面的增量没有意义」，
不会静默把两个世界的数字相减。

### 2.3 指标口径从哪来

**不复制**第二套几何：

| 量 | 来源 |
|---|---|
| `belts_reaching_hub` / `belts_dead` / `belts_deliverable` / `items_on_belts` | `health.mjs#worldHealth` |
| uid 集合与源头归因 | `topology.mjs#flowReachable`，与 `worldHealth` 同一调用方式、同一 `itemsDoc` 门槛 |
| `debug_items` 的 region | `loop.mjs#debugItemsRegion` |

这样 `live-diff` 的数字与 `timeline.log` / `verify-last.json` 里的**逐字一致**，
不会出现「两个工具两份世界」。

### 2.4 退出码

| 码 | 含义 |
|---|---|
| `0` | 没有原有活线变死，且 `belts_reaching_hub` 没降 |
| `1` | 原有活线变死 **或** 到 hub 的带子变少（给脚本用的粗判据） |
| `2` | 参数错误 |
| `3` | `--check` 没过 |

---

## 3. 一次完整的真机会话长什么样

```bash
# 1. 预检（不花 LLM 调用）
$ bash tools/live-run.sh --dry-run
   ✓ 载入存档 = 7c93b3dd9e949c561e5aa529974973b18c856b45
   ✓ 网关走 Codex 协议（…/responses）
   基线: delivered 0  items_on_belts 369  belts_deliverable 309  belts_dead 390

# 2. 真跑（会自动拍 checkpoint live-<ts>）
$ bash tools/live-run.sh --goal "CbCbCbRb:CwCwCwCw" --rounds 3 --yes
   …
   ⑤ 世界到底变没变
   ── A. run 自己记的世界（run 末轮快照 → 跑完 20s 后）──
     原有活线变死 : 0 条
     新铺的死带子 : 29 条 …
   ✓ 世界上真的发生了事：产出从「{}」变成有货（----CgCg +4）
   ⚠ 产出的是 ----CgCg，不是目标 CbCbCbRb:CwCwCwCw —— 线通了，形状不对

# 3. 不满意就回滚
$ bash tools/live-run.sh --rollback live-<ts>
   ok=true  verified=true  uid_set_equal=true
```

---

## 4. 已知坑（都实测过）

| 坑 | 现象 | 处置 |
|---|---|---|
| gateway 协议 | `/v1/messages` → 503「模型无可用渠道」 | 用 `…/responses`；503 消息里的模型名是网关兜底，不是你传的 |
| `ANTHROPIC_BASE_URL` | 本机值是 `…:15721/claude-desktop`，打过去 401 | 两个工具都不读它；`live-run.sh` 显式 `unset` |
| L4 窗口太短 | 三层链 60 秒才出第一件，L4 判「没产出」 | 看 `live-diff` 的「跑完 N 秒后」对比，别只看 `verify-last.json` |
| 回滚不恢复流动状态 | 拓扑复原但带上货丢了、hub 已入的账不撤 | 预期的；见 `tx-last.json` `boundaries` |
| `page_visible=false` | 本机常驻 false 但 tick 正常 | `--check` 用 tick 推进与否判真伪，不单看这个字段 |
| 每轮 LLM ~30 秒 | n 轮 ≈ 30n 秒墙钟 | 预算按这个量级排 |
