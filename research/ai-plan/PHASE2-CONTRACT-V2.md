# 阶段 2 契约 · 红队修正补丁 v2

日期 2026-10-28。输入：`REDTEAM-PHASE2.md`（红队）+ 主线程逐条复核。
**本补丁优先于 `PHASE2-CONTRACT.md` v1。** 两者冲突处以本文为准。

---

## 0. 复核结论

红队提出 8 条致命指控。主线程**逐条复核，全部成立或部分成立**。其中一条是**红队对、我错**：

| # | 指控 | 复核结果 | 证据 |
|---|---|---|---|
| 1 | `produced_delta` 已被删除，契约 §1.5 规则 5 依赖它 → live 永远判红 | **成立** | `verify_runtime.test.mjs:634` 有 `!("produced_delta" in evidence)` 断言 |
| 2 | `tx.verify.uid_set_equal` 在成功时抛 TypeError | **成立** | `shapez-ai-bridge.js:3361` `if (doVerify && mustRollback)` —— 成功时 `verify===null` |
| 3 | `tx.results[i].mismatch` 不存在 | **成立** | `:3402-3406` 只有 `index/op/ok/uid/applied` |
| 4 | `report.uidDiff` 不存在 | **成立** | 全库 0 命中 |
| 5 | **F7 是测量错误**：我只枚举 cutter/trash/hub、port 只试 left/right，漏了 balancer 与 `primary/secondary` | **成立，是红队对、我错** | 正确枚举后 **27 种组合成功，含直达 hub**（来源 balancer） |
| 6 | flows 的语义没定义，`from==to` 恒绿 | **成立** | `checkFlow.reach()` 以 `start.uid` 起手 |
| 7 | `DIAG_CODES` 块不是合法 JS；声明数与实际不符 | **成立** | 我写的是 `OBS_TRUNCATED, OBS_STALE, ...` —— 裸标识符，`ReferenceError` |
| 8 | `FakeGame` 与真 mod 的 `debug_items` 语义相反（pathCount 全局 vs 过滤） | **成立** | mod `shapez-ai-bridge.js:1000-1003`；FakeGame 会按 region 过滤 |

**另外的准确性问题**（不影响设计，但要改）：`ok=checks.every` 的行号是 **919**（我写 850）；`tx` 上限在 `:3258`（我写 3255）。

---

## 1. F7 更正（最重要）

**v1 §0 F7 的结论作废。** 正确事实：

在真实 L5 存档（181 实体）上，**正确地**枚举（所有非带子实体 × 所有模板角色名 × index 0..2）：

```
成功 27 种组合，其中多条直达 hub
来源类型：balancer（10084/10085/10186/10187/10188）
拒绝分布：endpoint_not_a_port 1308 / bad_type 1576 / ambiguous_port 777
          port_already_bound 563 / endpoint_not_found 246 / occupied 117 / target_already_fed 111
```

**对设计的影响（与 v1 相反）**：
- `connect` 在真实存档上**是可用的**，尤其是 balancer→hub 这条路。
- v1 因此推出的「候选宏权重要下调 connect」「拆建必须分两轮」「ROUNDS_MAX=6 由此获得依据」**三条全部撤回**。
- 但另一条独立事实仍然成立：**L4 的正解是一条 `replace_run`，不需要 `connect`**（`coldstart_l4.test.mjs` 28 条）。
  所以「connect 可用」≠「connect 是主力」。

**教训（写进流程）**：穷举法得出的「不可能」结论，必须先证明枚举空间完整 ——
要枚举的量来自**运行时数据**（模板的角色表、世界的实体类型），不是我以为的那几个。

---

## 2. 判据源码修正

### 2.1 `strictVerdict` 规则 5（L4 行为）

v1 依赖 `evidence.produced_delta`，**该字段已被删除**（删它是对的：跨窗口相减无意义）。
改为读当前实现真实提供的字段：

```js
// verify_runtime.mjs 的 L4-behavior evidence（当前真实字段）
{
  shape, ticks,
  produced_window_before, produced_window_after,       // 窗口求和，**不可相减**
  produced_window_secs_before, produced_window_secs_after,
  delivered_in_window_after, delivered_in_window_before,
  goal_delivered_before, goal_delivered_after, goal_delivered_delta,   // ← 唯一可用于增量的
  rate_per_sec, window_seconds, caveat
}
```

规则 5 改为：

```js
L4-behavior:
  mode==="live" 时：
    · 不得 skipped
    · evidence.goal_delivered_delta > 0   ← 用这个，不是 produced_delta
      或 evidence.delivered_in_window_after > 0
    · 若 goal_delivered_* 为 null（读不到 hub），则判 undetermined → 红
      （读不到权威计数时不许假设它涨了）
  mode!=="live" 时：允许 skipped，但 run_end 必须标 mode，验收脚本拒收
```

### 2.2 apply 的三件检查（v1 §5.3）—— 全部改写

v1 写的三个字段两个不存在。真实可用的判据：

```js
// tx 返回（shapez-ai-bridge.js:3376-3408）
{
  ok, applied, requested, rolled_back, dry_run, aborted, failures,
  diff: {added:[], removed:[], modified:[]},   // 最终世界相对快照
  net: null | {...},                            // 仅回滚时非 null
  verify: null | {ran, uid_set_equal, entities_equal, modified, diffs, diff_truncated},
                                                // ★ 仅回滚时非 null ★
  rollback, results:[{index,op,ok,uid,applied}],
  belt:{...}
}
```

正确的 apply 判据：

```js
function applyVerdict(tx, { requestedOps }) {
  const why = [];
  if (tx.dry_run) why.push("tx.dry_run=true（loop 不该传）");
  if (!tx.ok) why.push("tx.ok=false");
  if (tx.rolled_back) {
    why.push("tx.rolled_back=true");
    // ★ 只有回滚时才检查 verify；成功时它是 null，不能读 ★
    if (tx.verify && tx.verify.uid_set_equal === false) {
      why.push("回滚后世界没洗干净（uid 集合不等）→ 硬停，继续写会污染下一次尝试");
      return { ok: false, hardStop: true, why };
    }
  }
  if (tx.applied !== requestedOps) why.push(`applied ${tx.applied} ≠ requested ${requestedOps}`);
  if (!tx.rolled_back && tx.diff && (tx.diff.added.length === 0 && tx.diff.removed.length === 0)) {
    why.push("NO_WORLD_CHANGE：tx 成功但世界没变");
  }
  return { ok: why.length === 0, hardStop: false, why };
}
```

**`uid_set_equal` 只在回滚路径上有意义** —— 这一点必须在代码里写死，不能靠记性。

### 2.3 `GAME_COERCED` —— 防线换了位置

`tx.results[i].mismatch` 不存在。可用的是 `results[i].uid`（place 的 `entity_uid` 被归一成 `uid`）。

所以 `GAME_COERCED`（游戏把 rv 改了）**不能在 apply 阶段判**，只能：

1. **apply 后立刻重读 obs**，按 `results[i].uid` 找到那一格，比 `rotation_variant`；
2. 或交给 `verifyRuntime` 的 L1（`wrong_rv` / `wrong_code`）—— **这是更正确的做法**，
   因为 L1 的比较依据是世界，不是 op 的返回值。

**裁决**：删掉 apply 阶段的 `mismatch` 检查，`GAME_COERCED` 由 L1 的 `wrong_rv/wrong_code` 触发。
`pendingByOp` 的 uid 桥接改用 `results[i].uid`（这个字段是真实存在的）。

### 2.4 `UNDECLARED_DESTRUCTION` —— 得自己算

`report.uidDiff` 不存在。必须由 loop 自己算：

```js
// 在 verify 阶段，loop 手里有两份 obs（apply 前 / 后）
function undeclaredDestruction(beforeObs, afterObs, declaredDestroys) {
  const b = new Set(beforeObs.entities.map(e => e.uid));
  const a = new Set(afterObs.entities.map(e => e.uid));
  const vanished = [...b].filter(u => !a.has(u));
  const declared = new Set(declaredDestroys);
  return vanished.filter(u => !declared.has(u));
}
// 非空 ⇒ 硬停（HALT），不是"继续修"
```

**注意**：这需要 loop **在 apply 前后各存一份完整 obs**。契约 §1.4 的 transcript 必须记 `world_hash`，
但 hash 不足以定位"谁消失了" —— 要把 `before_uid_set` 与 `after_uid_set` 都落盘（或落差值）。

### 2.5 `DIAG_CODES` —— 修成合法 JS

v1 写的是裸标识符，运行即 `ReferenceError`。正确写法：

```js
export const DIAG_CODES = Object.freeze({
    /* observation */
    OBS_TRUNCATED: "world observation was truncated; no criterion above this is trustworthy",
    OBS_STALE: "a handle/uid referenced a world that is no longer current",
    PATHS_TRUNCATED: "debug_items returned fewer paths than pathCount",
    PRODUCTION_UNAVAILABLE: "production() failed or lacked slice_seconds",
    ITEMS_UNAVAILABLE: "debug_items failed or had no paths[]",
    /* llm */
    LLM_TRANSPORT: "network/API failure",
    LLM_PARSE: "response was not valid JSON after fence-stripping",
    LLM_EMPTY_PLAN: "calls[] was empty",
    LLM_COORD: "literal coordinate detected in LLM output (V1..V6)",
    LLM_UNKNOWN_MACRO: "macro not in the 6-name whitelist",
    LLM_ARGS: "validateMacroCall rejected the args",
    LLM_LINT: "lintNoBareCoords rejected the args",
    /* plan / macro */
    MACRO_REFUSED: "a macro returned ok:false",
    MACRO_HALF_DONE: "macro returned ok:true but cells_placed !== cells_planned",
    PLAN_REJECTED: "planToTxOps rejected the merged plan",
    COORD_PROVENANCE: "a coordinate had no valid provenance tag",
    /* apply */
    TX_ROLLED_BACK: "tx rolled back",
    TX_UNAVAILABLE: "mod has no tx, or it errored before running",
    GAME_COERCED: "the world did not match the plan after landing (L1 wrong_rv/wrong_code)",
    /* runtime L0..L4 */
    LANDING_MISSING: "L1: planned entity absent",
    LANDING_MISMATCH: "L1: type/uid/rot/rv/code differs",
    DELETE_NOT_REPLAYED: "L1: a declared delete did not happen",
    UNDECLARED_DESTRUCTION: "an entity vanished that was not in destroys[]",
    SLOT_STARVED: "L2: an input slot has no upstream",
    OUTPUT_UNROUTED: "L2: an output slot has no downstream",
    FLOW_UNREACHABLE: "L3: a declared flow does not reach its target",
    FLOW_UNVERIFIED: "L3 was degraded (no flows supplied) — not a pass",
    DEAD_END: "L3: a belt run terminates with no acceptor",
    NO_PRODUCTION: "L4: nothing produced",
    WRONG_SHAPE_PRODUCED: "L4: production exists but under a different shape key",
    PRODUCED_NOT_DELIVERED: "L4: produced > 0 but delivered == 0",
    PRODUCTION_UNTRUSTED: "L4: delivered slices unusable (<2 slices or empty)",
    /* meta */
    NO_DIAGNOSIS: "diagnose() produced nothing — treated as a loop bug",
    NO_PROGRESS: "same fingerprint with the same action",
    NO_PROGRESS_3X: "same fingerprint three times",
    NO_WORLD_CHANGE: "tx succeeded but the world hash did not change",
    NET_REGRESSION: "hardFails grew, or a new code appeared",
    BUDGET_EXHAUSTED: "a budget was exhausted",
    BUDGET_ROUNDS: "round budget exhausted",
    BUDGET_LLM_CALLS: "LLM call budget exhausted",
    BUDGET_TX: "tx budget exhausted",
    BUDGET_TICKS: "tick budget exhausted",
    BUDGET_WALL: "wall-clock budget exhausted",
    MOCK_EXHAUSTED: "MockLLMClient ran out of fixture rounds",
    RV_UNSTABLE: "rv still wrong after one rv_settle",
    INTERNAL: "loop bug — do not retry",
});
```

**闭集测试**：`Object.keys(DIAG_CODES).length` 冻结，且 `defineProperty` 使新增失败。

### 2.6 flows 的语义必须定义

`checkFlow` 的 `reach()` 从 `start.uid` 起手、`seen` 初始含它自己 ⇒ **`from===to` 恒绿**（红队实测）。
而 live 模式要求「L3 必须给 flows」，否则永远过不了。所以必须定义**谁产出 flows**：

**裁决：flows 由 `TxPlan` 自己产出，不接受外部输入。**

```js
// planToTxOps 在生成 placements 的同时，为每条「机器输出 → 下游机器输入」生成一条 flow
// 数据来源：placements 里每台机器的 slotsOf(outputs) 与既有世界的 acceptorOf(paths)
function deriveFlows(placements, obs, items) {
  const flows = [];
  for (const p of placements) {
    const s = slotsOf(p.kind, p.variant, p.x, p.y, p.rot);
    for (const out of (s && s.outputs) || []) {
      const downstream = followAcceptors(out.cell, obs, items);   // 沿 paths 走
      if (downstream) flows.push({ from: p.uid_or_pending, to: downstream.uid, via_slot: out.role });
    }
  }
  return flows;
}
```

硬规矩（配测试）：
- `from === to` 的 flow **必须被丢弃**（否则恒绿）；
- 新放的机器若某输出槽**找不到下游**，要产出一条 `OUTPUT_UNROUTED` 诊断，而不是造一个自环 flow；
- flows 为空 且 计划里有机器 ⇒ `FLOW_UNVERIFIED`（红），不许当成"没有货流要验"。

---

## 3. FakeGame 与真 mod 的语义差（必须修，否则 mock 全绿而实机失败）

| 项 | 真 mod | 当前 FakeGame | 修法 |
|---|---|---|---|
| `debug_items.pathCount` | **全局**路径总数（不受 region 影响） | 按 region 过滤后的数 | FakeGame 保留全局 pathCount；`paths[]` 也不按 region 过滤（与 mod 对齐） |
| `step()` 对 `production` | 真推进产线，产出真的变 | 只加 tick | 提供 `simulateProduction(fn)` 让用例显式注入"推进后产量"，并**在文档里写明这是模拟** |
| place 的 rv 重算 | 游戏按邻居重算 rv | 直接存下给的值 | 提供 `strictRv:true` 模式：place 后按邻居重算、与请求不符时记 `coerced[]` |

**最重要的一条**：FakeGame **能**证明「决策链是否走通」，**不能**证明「落盘是否正确」。
所有落在后者的断言必须标 `requires: live` 并**在验收脚本里被跳过而不是通过**。

---

## 4. 该砍的过度设计（采纳红队意见）

| 项 | 裁决 | 理由 |
|---|---|---|
| `ROUNDS_MAX=6` | **降到 3**，并把理由换成"L4 只需 1 次 replace_run，3 轮是给失败重试的余量" | v1 用 F7（错的）推出 6 轮 |
| `$bbox_of` 的 footprint 并集 | **保留但降级为可选**：belt 恒 1×1，只有含机器时才需要 | 红队对；但 `coldstart_l4.test.mjs` 的反例证明含机器时它必要 |
| `LLM_CALLS_PER_ROUND=1` 与「同轮重试」 | **改成**：解析失败也算一轮，`LLM_CALLS_PER_ROUND` 删除 | 两条规定互相否证 |
| `LLM_NARRATION` | **保留**（防 LLM 用自然语言夹带坐标，V4 的实现载体） | 红队说可砍，但它把 V4 从"检查字符串"变成"有码可诊断" |
| `SAME_FINGERPRINT_MAX=2` 三层 | **简化成两层**：同 fp 第 2 次必须换动作；第 3 次 halt | 三层规则里有一层是重复的 |

---

## 5. 遗漏项（红队指出，必须补进契约）

1. **多次 live 之间怎么复位存档**：`fixture_hash` 只说了要有，没说怎么用。
   裁决：验收脚本在每次 attempt 前 `load_save` 到同一份备份，并断言 `obs_hash` 与 `fixture_hash` 相等。
2. **LLM 参数名拼错**（`from` 写成 `source`）：`validateMacroCall` 返回 `unknown_field`，
   当前映射表里没有这个码 → `candidates` 为空 → 一次就 halt。
   **裁决**：`unknown_field` / `bad_type` 这类**结构错误**必须映射成 `LLM_ARGS` 且 `candidates=[该宏自身]`，
   允许重试一次（LLM 能看到自己的错误）。
3. **同轮里多个宏互相依赖的排序**：`planToTxOps` 已有 R9 排序规则，但要补一条：
   若宏 A 的 `pending` 被宏 B 引用，A 的 place 必须排在 B 之前；否则 `plan_conflict`。
4. **Ctrl-C 中间态**：`finally` 里写 `run_end` + `HALT.json`，`world_state:"unknown"`，并**不自动回滚**。
5. **`rpc.mjs` 的 reader 契约**：必须与 `verify_runtime.mjs` 的 `BRIDGE_READER` 完全一致
   （`obs` 带 `max_entities:50000`、`layer:"all"`、`include_stats:true`），否则两处读到的世界不同。
6. **`production` 窗口与 `step` 的配合**：`step(2400)` = 20 秒，而最短窗口 `slices:2` = 20 秒 ——
   **刚好一片边界**。裁决：`step` 至少要跑 `(slices+1) * 10 秒`，否则窗口里混着推进前的数据。

---

## 6. 验收判据（修订）

阶段 2 达成的**唯一**判据（v1 的 5 条里有 3 条依赖不存在的字段，作废）：

1. **冷启动**：从 `L4-obs.json` 起，唯一输入是 3 个 uid + 目标形状；人工输入坐标 = 0。
2. **无人工坐标**：`assertNoHumanCoords` 绿 + `assertProvenance` 绿 + transcript 里每个 `place.x/y` 有 provenance。
3. **实机 goal 推进**：`goal.requirement.delivered` 在 `step` 后**增量 > 0**（`mode==="live"` 才计）。
4. **连续 5 次独立尝试 ≥3 次成功**：5 个不同 `run_id`、5 个不同 `transcript_sha`、同一 `fixture_hash`。
5. **不破坏既有**：全部既有测试与基线一致。

**离线（FakeGame）跑通 = 决策链通过，不构成阶段 2 达成。** 这一条要写在验收脚本的第一行注释里。

---

## 7. 实施顺序（据此收敛）

红队指出 v1 的 17 个文件是过度拆分。收敛为 **7 个文件 + 测试**：

| # | 文件 | 职责 | 依赖 |
|---|---|---|---|
| 1 | `loop/constants.mjs` | `BUDGET` / `DIAG_CODES`（合法 JS）/ `MODES` | 无 |
| 2 | `loop/handles.mjs` | obs → 句柄表（无坐标）+ `$bbox_of` / `$uids` 解析 | 1 |
| 3 | `loop/coords.mjs` | `assertNoHumanCoords` + `assertProvenance`（含 `$ref/$uids/$bbox_of`） | 2 |
| 4 | `loop/planToTxOps.mjs` | 宏结果 → ops + `deriveFlows` + 12 条自检 | 1,3 |
| 5 | `loop/verify.mjs` | `verifyRound` + `strictVerdict` + `applyVerdict` + `undeclaredDestruction` | 4 |
| 6 | `loop/llm.mjs` | `LLMClient` / `AnthropicClient` / `MockLLMClient` / `ReplayLLMClient` + prompt 渲染 | 1,2 |
| 7 | `loop.mjs` | 状态机 + transcript + CLI | 1–6 |

`diagnose.mjs` / `retrieve.mjs` / `repair.mjs` 先**不做独立文件**：
- `diagnose` 的第一版只需把 `verifyRuntime` 的 checks 映射成 `Diagnosis[]`（含 `handle`），放在 `verify.mjs` 里；
- `retrieve` 的第一版是静态表（哪个码 → 哪几个宏），放 `constants.mjs`；
- `repair` 的第一版只有「同指纹规则」，放 `loop.mjs`。

**理由**：先跑通一次冷启动，再看哪些抽象真的需要。v1 的 17 文件拆分在还没跑通任何一次的情况下，
是在为想象中的复杂度付账。

---

## 8. 一句话总结

v1 契约**方向对、事实有 5 处错**（其中 F7 是我自己的测量错误，红队抓到）。
本补丁把每一条判据都换成**当前代码真实提供的字段**，把 F7 更正为相反结论，
并把 17 个文件收敛到 7 个。**开工前必须先按 §2 的判据改掉 v1 的五处引用。**
