# 阶段 2 实现契约：loop.mjs + LLM 层

版本 v1（2026-10-28）。读者：下游 4–6 个并行实现 agent。
本文件是**唯一真值**。与 `llm-layer-DESIGN.md` 冲突处以本文件为准（第 1 节逐项裁决）。

**本契约不修改任何既有文件。** 新增代码全部在 `src/agent/loop/` 下；唯一被只读 import 的既有模块是
`src/agent/macros/contract.mjs`、`src/agent/verify_runtime.mjs`、`src/agent/macros/*.mjs`、
`src/ai/op-templates.mjs`、`src/ai/belt-rules.mjs`、`src/agent/fake_game.mjs`。

---

## 0. 开工前必须知道的六条实测事实（不是设计选择，是现状）

这六条决定了后面每一个设计。全部只读核对，附证据位置。

| # | 事实 | 证据 | 对设计的影响 |
|---|---|---|---|
| F1 | **`verifyRuntime` 的顶层 `ok` 把 `skipped` 当绿**：`const ok = checks.every(c => c.ok \|\| c.skipped)` | `verify_runtime.mjs:850` | loop **绝不能**用 `r.ok` 判成功。必须有独立的 `strictVerdict()`（Q1/Q8） |
| F2 | **`checkFlow` 在没有 `opts.flows` 时返回 `ok:true, degraded:true`**（只有在有死端时才红） | `verify_runtime.mjs:716-731` | `degraded` 必须等于「未验证」，不是「通过」 |
| F3 | **`connect.resolveEntity` 没有 `pending` 分支**（只认 uid / hub / cell） | `connect.mjs:279-305` | `insert_machine → connect` 在计划态**串不起来**；必须分两轮（apply 后重读 obs 拿真 uid）。`insert_machine → trash_unused` 可以串（`remove.mjs:1613-1660` 有 pending 分支） |
| F4 | **`tx` 允许的 op 只有 `place / delete / place_path / bulk_delete`**，上限 2000 条；`paste_blueprint` **不在** tx 内 | `shapez-ai-bridge.js:2905-2913`、`:3255` | 带子必须用 `place{building:"belt", x,y,r,rotationVariant}` 逐格落盘，不能用蓝图；rv 会被邻居重算，必须读回 |
| F5 | **`tx` 的 `results[i].uid` 按 op 下标给出** | `shapez-ai-bridge.js:3427-3433` | pending token → 真 uid 的桥接靠 **op 下标**，不靠几何猜测（Q5） |
| F6 | **夹具必须分清 L4 / L5**：`test/fixtures/saves/L4-obs.json` 是 L4 冷启动态（`RuRu----`，`(4,-13)(5,-13)(4,-14)` 全是带子）；`L5-obs.json` + `L5-items.json` 是另一张存档（`Cu----Cu`，`(4,-13)` 已是 cutter） | 本次实测 | 用错夹具会**静默换关**。`FakeGame.fromFiles(..., {goal})` 会断言；L4 **没有**配套 items dump（Q7 的已知缺口） |

补充两条容易踩的：
- `L2-slots` 在「计划里没有机器」时返回 `skipped:true`（`verify_runtime.mjs:568`）；`L4-behavior` 只在给 `opts.behavior` 时运行，否则恒 `skipped`（`:714`）。
- `contract.mjs` 自带断言 `MACRO_NAMES.length === 6`。**loop 不得新增宏**，`build_line` 不进入 v1 白名单。

---

## 1. 裁决表：`llm-layer-DESIGN.md` 逐项

| 旧设计条目 | 裁决 | 理由（可验证） |
|---|---|---|
| §1.2 输出 `line {target, strategy, site, parallel}` DSL | **废弃** | 前提是「LLM 出 DSL → 确定性编译器编译」。阶段 2 的产物是**宏调用序列**；编译器已降为 `build_line` 的内部库（DIRECTION-FINAL §1.1）。DSL 的 `target/strategy/parallel` 在宏 ABI 里没有任何落点 |
| §1.2 `site: coords INT INT` | **废弃** | 与「LLM 不算坐标」直接冲突；且 lint 无法检查文本 DSL |
| §1.3 `strategy` 五枚举 → L2 参数 | **废弃** | 这五个枚举在 `src/agent/macros/*` 里 `grep` 命中 0 次 |
| §1.1 三条禁令（无坐标 / 无旋转 / 无 building id） | **保留并加严** | 加严为：**无字面坐标、无 `region` 算术、无 rv/角度、无 `machine` 之外的建筑身份**；`machine` 必须来自宏卡片枚举（Q3） |
| §2.1 骨架顺序 static → 半静态 → 动态（缓存友好） | **保留** | 与 Anthropic prompt cache 前缀稳定一致 |
| §2.2 state block ≤700 tok、绝不倾倒 obs | **保留 + 改造** | 改造点：state 块**不含任何 x/y**，改为句柄表 + 拓扑描述（Q2/Q3）。上限改为 ≤900 tok |
| §2.3 token 预算表 | **修改** | 新预算见 §Q3.4：输入 ≤2.8k、输出 ≤700 tok；不写死美元价目 |
| §2.4 few-shot 只放首轮、只放 2 条 | **修改** | 保留「只放首轮」；例子必须替换为**宏调用 JSON**，且来自 `test/fixtures/llm/` 里被 replay 验证过的真实调用 |
| §3.1 `critique` schema | **修改** | 骨架保留，**字段名与错误码全部换掉**：`stage` 换成 `layer`（L0–L4 + tx），`suggested_strategies` 换成 `candidates: MacroName[]`（Q4） |
| §3.2 三大失败类（corner_rv / channel_conflict / degenerate_segment） | **废弃** | 这是**编译器**的失败类。宏层的失败类是 `ERROR_CODES` + `verifyRuntime` 的 check 名 |
| §3.3 错误码表（12 个） | **废弃** | 换成 Q4 的闭集码，且**每个码必须绑定 1–3 个候选宏** |
| §3.4「L2 能自愈就绝不打给 LLM」 | **保留** | `rv_settle`、`retry_refused_with_rebind`、`increase_obs_limit` 三个确定性修复先跑（Q1 的 repair 分流） |
| §4 `shouldCallLLM()` R1–R5 | **废弃** | R1–R4 的前提是「确定性层先穷举候选」。阶段 2 是冷启动改造，**第一轮就必须问 LLM**。保留其精神为：**每轮最多 1 次 LLM 调用** |
| §5.1 `LLMClient.propose(dslContext)` | **保留类结构，改签名** | 改为 `propose(ctx: PromptBundle) → {text, usage, raw}`；解析在校验层 |
| §5.1「Anthropic 无 assistant prefill」 | **保留** | 写进 `llm.mjs` 头注释 |
| §5.1 `play.mjs --llm` 接入 | **修改** | 改为 `node src/agent/loop.mjs --goal <shape> --llm [--mock <scenario>]`；`play.mjs` 不动 |
| §5.2 mock 目录 `attempt-N.dsl` | **修改** | 改为 `test/fixtures/llm/<scenario>/round-NN.json` + `meta.json` + `expect.json` |
| §5.2 三种模式 | **保留并合并** | 合并为两种：`index`（按轮读文件）与 `replay`（录制回放） |
| §6.2 修复轮 ≤3、LLM ≤4 | **修改** | 改为 6 轮 / 8 次调用（Q6）。理由：阶段 2 的失败面是**多步改造**（L4 是 5 op），不是「换一个策略再试一次」 |
| §6.3「确定性优先、LLM 兜底」 | **保留** | 但边界改写为：确定性负责**规划内**（plan/dry-run/tx/verify/settle），LLM 只负责**选哪几个宏** |
| §7 未决项 | **保留为已知风险** | 新增一条：**M0 之前不得声称阶段 2 达成**（Q8-10） |
| 全文的「L2 编译器」作为执行体 | **废弃** | 执行体是 `planToTxOps + tx`；验证体是 `verifyRuntime`；编译器只在 `build_line` 内部出现 |

**一句话裁决**：旧设计可复用的只有**三层骨架（prompt 组织 / LLMClient 抽象 / 录制回放）与「确定性优先」原则**；它的 DSL、策略枚举、错误码、`shouldCallLLM` 四条规则全部作废。

---

## Q1. loop 的状态机

### 1.1 决定

单次运行 = `Run`；`Run` 含 `≤6` 个 `Round`；每 `Round` 严格六阶段，**顺序不可跳**：

```
observe → diagnose → propose → plan(dry-run 全宏) → apply(1 次 tx) → verify → repair(判定：继续/终止)
```

关键裁决：**`plan` 是 propose 与 apply 之间的独立阶段**，不是 propose 的一部分。理由：`apply` 必须"全绿才写"，而"全绿"要跑完 6 个宏的 dry-run + 契约校验 + 坐标溯源断言 + tx 编排校验才能知道。把这一步塞进 propose 会让「LLM 输出错了」和「世界不允许」混成一个失败。

### 1.2 阶段类型

```js
// 全部在 src/agent/loop/types.mjs 里以 JSDoc typedef 定义（零运行时代码）

/** @typedef {{run_id, attempt_id, goal, mode:"live"|"mock"|"replay", started_at, fixture:{obs_hash, items_hash, goal_shape}}} RunMeta */
/** @typedef {{tick, hash, goal, entities, items, production, resources}} ObsSnapshot */   // hash = worldUidSetHash
/** @typedef {{code, layer:"L0"|"L1"|"L2"|"L3"|"L4"|"tx"|"llm"|"budget", severity:"blocker"|"degraded"|"info",
 *             subject:{handle?,uid?,macro?,token?}, slot?:{role?,index?,cell_ref?},
 *             expected, observed, evidence:{uids?:number[], handles?:string[], cells?:string[]},
 *             candidates: string[], repairHints: string[]}} Diagnosis */
/** @typedef {{say, calls: Array<{macro, args, why}>}} LlmPlan */                        // 原始 LLM 输出（未解析 $ref）
/** @typedef {{macro, args, provenance: Record<string,"obs:uid=.."|"macro:token=.."|"computed:bbox_of[..]">}} ResolvedCall */
/** @typedef {{ok, ops, destroys, pendingByOp, placements, removes, warnings, error}} TxPlan */
/** @typedef {{ok, checks, strict, worldBefore, worldAfter, uidMap, evidence, hardFails, improvements}} VerifyReport */
```

| 阶段 | 输入 | 输出 | 失败条件（任一即进入 repair，且必须带 Diagnosis） |
|---|---|---|---|
| `observe` | reader（真桥或 FakeGame） | `ObsSnapshot`（obs + debug_items + production） | `obs.truncated===true` → `OBS_TRUNCATED`；`production` 不可用 → `PRODUCTION_UNAVAILABLE`；`items.pathCount > items.paths.length` → `PATHS_TRUNCATED` |
| `diagnose` | `ObsSnapshot`, 上一轮 `VerifyReport\|null`, goal | `Diagnosis[]`（≥1 条，否则 `NO_DIAGNOSIS`） | 无法把失败映射到闭集码 → `DIAGNOSIS_UNMAPPED`（**不许**写成 "unknown" 通过） |
| `propose` | `PromptBundle` | `LlmPlan` | 网络/解析错误 → `LLM_TRANSPORT` / `LLM_PARSE`；空 calls → `LLM_EMPTY_PLAN` |
| `plan` | `LlmPlan`, `ObsSnapshot` | `ResolvedCall[]` + `TxPlan` | 任一条：`assertNoHumanCoords` 红、`validateMacroCall` 红、宏 dry-run `ok:false`、`planToTxOps` 红 → `PLAN_REJECTED`（**零写入**） |
| `apply` | `TxPlan` | `tx` 返回 + `uidMap` | `tx.rolled_back===true` 或 `verify.uid_set_equal===false` 或 `ok===false` → `TX_ROLLED_BACK`；`opResult.mismatch===true` → `GAME_COERCED` |
| `verify` | 新 `ObsSnapshot`, `TxPlan`, `uidMap` | `VerifyReport`（含 `strict`） | `strict.ok===false` → 按 check 名映射诊断 |
| `repair` | `VerifyReport` + `Diagnosis[]` + transcript | `{action:"continue"\|"halt", reason, fingerprint, deterministicFix?}` | 超过预算 / 指纹重复 / 净无改善 / 净恶化 → `halt` |

### 1.3 终止条件（三条，全部要落盘）

```
SUCCESS   : strictVerdict(report) === pass            // 定义见 1.5
            && (mode!=="live" || goalDeliveredDelta > 0)   // live 必须有真实交付增量
HALT      : 任一 budget 用尽（Q6），或 repair 判 halt
ERROR     : 未捕获异常（也要写 run_end，不许静默退出码 0）
```

**「失败」不等于「halt」**：失败是 `Diagnosis`，进下一轮；`halt` 只在预算/无进展/恶化时发生。

### 1.4 transcript schema（每轮必须落盘，`runs/<run_id>/transcript.jsonl`）

一行一个 JSON 对象，追加写、`fs.appendFileSync`、`\n` 结尾。**零依赖**。

```jsonc
{"seq":1,"ts":"2026-10-28T12:00:00.000Z","run_id":"r-...","attempt":1,"round":0,
 "kind":"run_start","hash":"sha256:...",
 "data":{"goal":"RuRu----","mode":"live","obs_hash":"sha256:...","items_hash":"sha256:...",
         "entity_count":181,"budget":{...},"git_head":"07928ad"}}

{"seq":2,...,"kind":"observe","round":1,"data":{"tick":96919.2,"truncated":false,
 "entity_count":181,"paths":20,"paths_truncated":false,"world_hash":"sha256:..."}}

{"seq":3,...,"kind":"diagnose","round":1,"data":{"codes":["SLOT_STARVED","FLOW_UNREACHABLE"],
 "fingerprint":"sha256:...","diagnoses":[...]}}          // 全文，不截断

{"seq":4,...,"kind":"propose","round":1,"data":{"llm_call_id":"c-3","usage":{"in":2410,"out":520},
 "plan":{"say":"...","calls":[{"macro":"replace_run","args":{...},"why":"..."}]},
 "raw_text_sha":"sha256:..."}}                            // 原文存 runs/<id>/llm/round-01.txt

{"seq":5,...,"kind":"plan","round":1,"data":{"resolved":[...],"provenance":{...},
 "dry_run":[{"macro":"replace_run","ok":true,"cells_planned":6}],"tx_plan":{"ops":9,"destroys":[10143]},
 "warnings":["kept-belts"],"rejected":null}}

{"seq":6,...,"kind":"apply","round":1,"data":{"tx_ok":true,"applied":9,"requested":9,
 "rolled_back":false,"uid_set_equal":true,"uid_map":{"replace_run:trash@4,-14":10901},
 "mismatch_ops":[],"tick_advance":0.0,"duration_ms":38}}

{"seq":7,...,"kind":"verify","round":1,"data":{"checks":[{"name":"L1-landing","ok":true},
 {"name":"L2-slots","ok":true},{"name":"L3-flow","ok":false,"degraded":true},
 {"name":"L4-behavior","skipped":true}],"strict":{"ok":false,"why":["L3 degraded","L4 skipped"]},
 "hardFails":["L3-flow"],"improvements":["L2-slots:false→true"],"world_hash":"sha256:..."}}

{"seq":8,...,"kind":"repair_decide","round":1,"data":{"fingerprint":"sha256:...","seen":1,
 "improved":true,"action":"continue","deterministic_fix":null,"next_round":2}}

{"seq":9,...,"kind":"run_end","data":{"outcome":"halt","reason":"BUDGET_ROUNDS",
 "final_world_hash":"sha256:...","preserved":{"dir":"runs/r-...","resume":"node src/agent/loop.mjs --resume runs/r-..."}}}
```

**硬规矩**（都要有测试）：
- `run_end` 无论成败**必须**写；进程 `exitCode` = 0 仅当 `outcome==="success"`。
- 每个 `apply` 必须有一条对应 `plan`（`plan.rejected!==null` 时禁止出现 `apply`）。
- `verify` 的 `data.checks` 必须是 `verifyRuntime` 原样 checks 的**逐项复制**（不许二次总结）。
- `propose` 必须记录 `usage`；`mode:"mock"` 时 `usage=null` 且 `run_end.outcome` 不得被外部当作阶段 2 达成（Q8-10）。

### 1.5 `strictVerdict`（这是 loop 自己的判据，不是 `verifyRuntime.ok`）

```js
// src/agent/loop/verify.mjs
export function strictVerdict(report, { mode, goalShape, flowsProvided }) -> {ok, why:string[]}
```
规则（全部机器可检）：
1. `L0-observation` 必须存在且 `ok===true`（`undecidable` 一律红）。
2. `L1-landing` 必须 `ok===true`。
3. `L2-slots`：计划含机器时**不得** `skipped`；`undecidable` 红。
4. `L3-flow`：**必须**提供显式 `flows`；`degraded===true` 一律红。
5. `L4-behavior`：`mode==="live"` 时**不得** `skipped`，且 `evidence.produced_delta > 0` 或交付增量 >0；`mode!=="live"` 时允许 `skipped`，但 `run_end` 必须标 `mode` 且验收脚本拒收。
6. 任何 check 带 `undecidable===true` → 红。
7. `report.uidDiff.undeclared_vanished.length > 0` → 红（Q8-15）。

### 1.6 repair：失败指纹与「同一错误不重试第三次」

```js
// src/agent/loop/repair.mjs
export function diagnoseFingerprint(diagnoses, worldHash) -> string   // sha256 hex
```
指纹口径（**只含稳定量，不含时间/tick/随机序**）：

```
fp = sha256( diagnoses
      .map(d => [d.code, d.layer, d.subject.handle||d.subject.uid||d.subject.token||"-",
                 (d.evidence.uids||[]).slice().sort().join(","),
                 (d.evidence.handles||[]).slice().sort().join(",")].join("|"))
      .sort().join("\n") )
```

规则：
- `fpSeen[fp]` 计数。**同一 fp 第 2 次出现**：允许，但必须换一种动作（`actionSetHash` 必须不同；否则直接 `NO_PROGRESS`）。
- **同一 fp 第 3 次出现**（无论动作是否相同）→ `halt: NO_PROGRESS_3X`，`preserved` 落盘。
- 每轮必检「世界没动」：`worldUidSetHash(after) === worldUidSetHash(before)` 且 `apply` 成功 → `NO_WORLD_CHANGE`（这类"成功但世界没变"是本项目最常见的假绿入口）。

**为什么用 (code, subject, evidence) 而不是 message**：message 里含坐标与数字格式，会随世界变化而抖动，导致同一错误被当成新错误，退化成无限重试。

### 1.7 repair 的分流（确定性优先）

repair 在叫 LLM 之前先跑三张**确定性修复表**（命中即直接进下一轮 observe，不消耗 LLM 预算）：

| 触发 | 确定性修复 | 上限 |
|---|---|---|
| `L1.wrong_rv` / `wrong_code`（且 cells 数 ≤ 8） | `rv_settle`：对漂移格 delete+place（带 rv），1 次 tx | 1 次/run |
| `MACRO_REFUSED` 且 code ∈ `{port_already_bound, target_already_fed}` 且 macro=`connect` | 同一调用加 `opts.rebind=true` 重规划（**仅当** diagnosis 的 `repairHints` 含 `rebind_ok`） | 1 次/run |
| `OBS_TRUNCATED` | 提高 `max_entities` 到 50000 / 缩小 region 到计划 bbox 外扩 32 | 1 次/run |

未命中 → 走 LLM（每轮最多 1 次）。

### 1.8 判据（可测试）

- T1-01：给定固定 `Diagnosis[]` 与 `worldHash`，`diagnoseFingerprint` 两次结果相同；把 message 改掉不影响；把 evidence 里多一个 uid 一定变。
- T1-02：脚本化 3 轮相同失败 + `MockLLMClient` 每轮回同一 plan → 第 3 轮前 `halt`，`reason==="NO_PROGRESS_3X"`，且 `transcript` 有 3 条 `diagnose`、2 条 `apply`。
- T1-03：`apply` 成功但世界 hash 不变 → `NO_WORLD_CHANGE`，不得出现 `run_end.outcome==="success"`。
- T1-04：`verifyRuntime` 返回 `{ok:true, checks:[{name:"L3-flow",ok:true,degraded:true}]}` → `strictVerdict` 必须 `ok:false`（这条直接锁住 F1/F2）。

---

## Q2. 谁算坐标？——`assertNoHumanCoords(plan)`

### 2.1 决定

**三层口径，逐层可脚本检查。**

| 层 | 对象 | 判据 |
|---|---|---|
| L-A 原始 | LLM 输出的 JSON（`LlmPlan`） | **不允许出现任何字面坐标容器**。坐标只能以 `$ref` / `$uids` / `$bbox_of` 三种算子出现 |
| L-B 解析 | `ResolvedCall[]` | 每个被解析出的 `uid`/`cell`/`region` 必须带 `provenance` 标签，且标签只能来自三个来源 |
| L-C 落盘 | `TxPlan.ops` | 每条 `place/delete` 的 `x,y,uid` 必须能在 `provenance` 里找到出处；**且** `delete.uid` ∈ obs 快照，`place.x/y` ∉ obs 占用格（除非在 `destroys` 里） |

### 2.2 三种合法坐标来源（唯一闭集）

```js
export const COORD_SOURCES = Object.freeze({
  OBS_REF:     "$ref",       // 一个已存在实体的句柄 → {uid} 或 {cell: origin}
  OBS_REFS:    "$uids",      // 一组已存在实体的句柄 → [uid...]（remove_run）
  DERIVED_BBOX:"$bbox_of",   // 一组已存在实体的句柄 → 闭区间 bbox（replace_run.region）
  MACRO_RET:   "<macro>:<token>", // 宏返回值的 pending.token / terminal / placed[].origin / cells[]
});
```

`$ref` 的解析规则（**必须在 dsl.mjs 里实现，不许各调各的**）：
- `{"$ref":"B7"}` → `{uid: handle.uid}`。用于 `connect.from/to`、`trash_unused.outlet`、`remove_run.uids`。
- `{"$ref":"B7","asCell":true}` → `{cell: [handle.x, handle.y]}`（即 obs 的 `x/y` = origin）。**只用于** `insert_machine.at`。
  - 理由：契约里 `at` 的 `[x,y]` 形态语义 = origin，**宏不做算术**；`{cell}` 形态会触发反解，2×1 机器恒 `ambiguous_site`（E2E-ACCEPTANCE §3.6 V11 实测）。选 `[x,y]` + 断言 `handle.x/y === obs[x].x/y` 是最短且可审计的路径。
- `{"$uids":["B7","B8"]}` → `[uid7, uid8]`。用于 `remove_run.uids`（契约推荐通道）。
- `{"$bbox_of":["B7","B8"]}` → `[min x, min y, max x, max y]`，**按 handle 所指实体的 origin 与其 footprint 并集**计算（`op-templates` 的 `footprint`）。用于 `replace_run.region`。

### 2.3 禁止清单（机器可执行）

```js
// src/agent/loop/assertNoHumanCoords.mjs
export function assertNoHumanCoords(llmPlan) -> {ok, violations:[{path, reason, value}]}
```
在一个 JSON 树上，以下任一命中即红：

| # | 形态 | 例子 | 理由 |
|---|---|---|---|
| V1 | 任何 `[int,int]` 数组，且**不在** `$bbox_of.args` / `$uids.args` 之内 | `"at":[4,-13]` | 字面坐标 |
| V2 | 任何 `[int,int,int,int]` 数组 | `"region":[4,-14,5,-13]` | region 算术 |
| V3 | 键名 ∈ `{x,y,r,rv,rot,rotation,rotationVariant,region,cell,cells,at}` 且值为数字 | `"y":-13` | 与 `FORBIDDEN_ARG_KEYS` 同源，但作用在 LLM 输出而非宏 args |
| V4 | `say` / `why` / 任何字符串里出现坐标形态正则 `\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?` | `"把 (4,-13) 那条带删掉"` | 防止 LLM 用自然语言夹带坐标，再由下一轮自己"抄"进去 |
| V5 | `$ref` / `$uids` / `$bbox_of` 的句柄不在当轮 `handleTable` 里 | `{"$ref":"B99"}` | 幻觉句柄 |
| V6 | 出现 `$ref` 之外的未知 `$` 算子 | `{"$offset":[4,-13]}` | 防止 LLM 发明"偏移"来变相算数 |
| V7 | 任何 `Call.args` 在解析后仍未通过 `lintNoBareCoords(macro,args)` | — | 复用既有 lint，不新造规则 |

**注意**：V3 不会误伤 `len:4`（`extend_line` 的格数）与 `max_cells:2000` —— V3 只对**键名在清单内**的数字生效，`len` 不在清单内。

### 2.4 解析后的溯源校验（L-B/L-C）

```js
export function assertProvenance(resolved, txPlan, obs) -> {ok, violations}
```
- 每个 `resolved[i].provenance[key]` 必须匹配 `^(obs:uid=\d+|macro:[\w-]+@[^|]+|computed:bbox_of\[.+?\])$`。
- `obs:uid=N` → `obs.entities` 里必须存在 uid=N，且 `resolved` 用到的 `uid`/`cell` 与它逐字段相等（`cell` 必须等于 `[e.x,e.y]`）。
- `macro:...` → 必须能在当轮某条宏返回值里找到同 `token` 的 `pending`，且该 pending 的 `origin`/`ports` 与使用处一致。
- 变异测试：把解析结果里任一个 cell 的 x 加 1，`assertProvenance` 必须红（否则溯源是空的）。

### 2.5 判据

- T2-01：`assertNoHumanCoords({calls:[{macro:"insert_machine",args:{at:[4,-13],facing:"top",machine:"cutter"}}]})` → 红，`violations[0].reason` 命中 V1。
- T2-02：把 L4 的正确 LLM plan（`test/fixtures/llm/l4-coldstart/round-01.json`）跑一遍 → 绿，且 `resolved` 里每个坐标的 provenance 全部非空。
- T2-03：`$bbox_of:["B1"]`（单格带）→ region 边长 1；`$bbox_of` 里含 2×1 机器 → bbox 含第二格（用 `op-templates.footprint`）。
- T2-04：`say` 写成 `"删掉 (4,-13)"` → 红（V4），且**不得**进入 `plan` 阶段（transcript 里没有 `apply`）。
- T2-05：句柄表过期（apply 后未刷新即复用旧 handle）→ `OBS_STALE` 诊断，`$ref` 解析失败，`PLAN_REJECTED`。

---

## Q3. LLM 的输入与输出

### 3.1 决定一：输出是**受限 JSON 宏调用序列**，不是 DSL

裁决理由（三条，都可验证）：
1. 宏 ABI 已经是**结构化参数**（`MACRO_SPECS.params`），JSON 是零翻译层；DSL 需要一层手写 parser，且 parser 的语法与 `contract.mjs` 的校验器会成为两份真值（这个项目已经因「两份真值」出过至少 3 次事故）。
2. 拒绝规则可以**直接复用** `validateMacroCall` + `lintNoBareCoords`，不需要新写一套语义。
3. 坐标禁令可以在 JSON 树上做（Q2），在文本 DSL 上只能做正则，容易绕过。

文法（EBNF，全部由 `dsl.mjs` 实现并在解析期强制）：

```
Plan        := "{" [ "say" ":" STRING ] "," "calls" ":" "[" Call ("," Call)* "]" "}"
Call        := "{" "macro" ":" MACRO "," "args" ":" Object "," [ "why" ":" STRING ] "}"
MACRO       := "connect" | "insert_machine" | "remove_run" | "extend_line" | "replace_run" | "trash_unused"
Ref         := "{" "$ref" ":" HANDLE [ "," "asCell" ":" true ] "}"
Uids        := "{" "$uids" ":" "[" HANDLE ("," HANDLE)* "]" "}"
BBox        := "{" "$bbox_of" ":" "[" HANDLE ("," HANDLE)* "]" "}"
HANDLE      := /^[A-Z]{1,2}[0-9]{1,3}$/        # C1 机器 / B7 带子 / H1 hub / X3 其它
```

**拒绝规则**（每条都要有负例测试）：

| code | 规则 |
|---|---|
| `LLM_NOT_JSON` | 不是合法 JSON（含 markdown 围栏 → 先剥围栏再解析；仍失败才拒） |
| `LLM_SCHEMA` | 顶层出现 `calls` 之外的未知键；`calls` 不是数组 |
| `LLM_EMPTY_PLAN` | `calls.length === 0` |
| `LLM_TOO_MANY_CALLS` | `calls.length > 6` |
| `LLM_UNKNOWN_MACRO` | `macro` 不在 6 个白名单内（**特别注意**：`build_line` 不在白名单，必须拒） |
| `LLM_DUP_MACRO_ON_SUBJECT` | 同一 `subject` 上同一宏出现 2 次 |
| `LLM_COORD` | Q2 的 V1–V6 任一 |
| `LLM_ARGS` | `validateMacroCall` 返回 `ok:false`（`error.code` 原样透传进 diagnosis） |
| `LLM_LINT` | `lintNoBareCoords` 红 |
| `LLM_TOO_LONG` | 输出字符数 > 4000（≈700 tok）；**不截断**，直接拒 |
| `LLM_NARRATION` | `say` 字符数 > 280 或含坐标（V4） |

### 3.2 决定二：输入**不含坐标**，用句柄表 + 拓扑描述

```js
export function buildHandles(obs, items, diagnosis) -> {byHandle, byUid, version, goalHandle, hubHandle}
```

- 编号规则（确定性，按 `(y,x)` 排序）：`hub`→`H1`；`cutter/painter/mixer/stacker/rotater`→`C*`；`miner`→`M*`；`belt/underground_belt`→`B*`；`trash`→`T*`；`balancer`→`L*`；其它→`X*`。
- **每轮重新编号**，且 `version = obs.tick` + `obs_hash`。诊断里引用的 handle 与当轮表不一致 → `OBS_STALE`。
- **prompt 里绝不出现 `x`/`y`/`r`/`code`/`uid`**。给 LLM 的每条实体只有：`handle, type, 状态短语`。
  - 带子：`B7 belt 上游=无 下游=C1.left 货=0/12 段=path#3`
  - 机器：`C1 cutter 输入=bottom(←B12) 输出=top:left(→无)/top:right(→B9)`
- 允许出现的数字：**计数**（货量、格数、槽数、比例、tick 秒数）。这些不是坐标。

> 这条是阶段 2 的命门：**LLM 从来看不到坐标系，它只看到一张带标签的图。** 「没人算坐标」由此从口号变成结构性事实。

### 3.3 决定三：诊断 → 候选动作的检索层（零依赖）

```js
// src/agent/loop/retrieve.mjs
export function retrieve(diagnoses, ctx) -> Array<{macro, argsTemplate, score, why, blocked?}>  // 排序后 top-3
export const RETRIEVAL_TABLE = Object.freeze({ /* code → [{macro, weight, pre}] */ });
```

算法（纯函数，无 IO，无随机）：

```
score(macro) = Σ_d over diagnoses:
                 base[code][macro].weight                    // 静态表，见 Q4
               + 3 * (pre[major].test(ctx) ? 1 : 0)          // 前置条件可判定的加分
               + 2 * (subject 类型匹配该宏的典型 subject)
               - 5 * (macro 的 whenNotToUse 谓词命中)
             + 1 * (该宏在历史里对同 code 成功过 ? 1 : 0)     // 来自 transcript 统计，可选
排序：score desc → MACRO_NAMES 下标 asc（确定性 tie-break）
截断：top 3（SkillsBench 的 ≤3 模块上限）
```

`pre` 谓词只允许读 `ctx` 里已有的东西（obs 摘要 + diagnosis），**不许读世界**。

### 3.4 prompt 结构与 token 预算

| 段 | 内容 | 预算（tok，按 3.5 字符/tok 折算） | 稳定性 |
|---|---|---|---|
| S1 role+rules | 角色、输出 JSON、禁坐标、禁 build_line、≤6 调用、"只输出 JSON" | 600 | 字节稳定（缓存前缀） |
| S2 macro cards | top-3 卡片：name / summary(1 行) / params(名字+类型) / whenNotToUse(1 条) / 1 个**句柄版**调用例 | 450 | 半静态（按检索变） |
| S3 goal+state | goal 形状/等级/required/delivered；hub 句柄；机器表；**只列与诊断相关的 ≤12 条带子**；production 摘要；预算余量 | 900 | 动态 |
| S4 diagnosis | 每条 ≤90 tok：`code: subject; expected vs observed; evidence(handles); candidates` | 500 | 动态 |
| S5 last round | 上一轮做了什么 / verify 说了什么（只有 code，不带坐标） | 200 | 动态 |
| S6 instruction | "输出本轮 calls。" | 80 | 字节稳定 |
| **合计** | | **≤2.8k in / ≤0.7k out** | |

硬规矩：
- 超预算时**只允许截断 S3 的带子列表**，`goal` / `hub` / `diagnosis` / `S1` **永不截断**。
- 实现里用 `chars/3.5` 估算，超过 12000 字符即抛 `PROMPT_OVER_BUDGET`。
- S2 的例子里每个参数都是句柄或枚举，测试断言 S2 文本里**不匹配**坐标正则。

### 3.5 mock 客户端（无 key 离线跑通全链路）

```
test/fixtures/llm/
  README.md
  l4-coldstart/
    meta.json        {"scenario":"l4-coldstart","goal":"RuRu----","obs":"test/fixtures/saves/L4-obs.json",
                      "items":null,"expect":{"max_rounds":6,"must_apply":true,"must_verify":true}}
    round-01.json    {"say":"cut the run into a cutter","calls":[{"macro":"replace_run",...}]}
    round-02.json    ...
    expect.json      {"outcome":"success","tx_count_min":1,"forbid_codes":["LLM_COORD","LLM_EMPTY_PLAN"]}
  l4-repair-one/     （第一轮故意 refused，第二轮修好）
  neg-empty-calls/   {"calls":[]}                        → 必须 halt/PLAN_REJECTED，不得 success
  neg-literal-coord/ {"calls":[{"macro":"insert_machine","args":{"at":[4,-13],...}}]} → LLM_COORD
  neg-unknown-macro/ `build_line`                        → LLM_UNKNOWN_MACRO
  neg-stale-handle/  `{"$ref":"B999"}`                   → OBS_STALE
  neg-text-narration/ `"say":"delete (4,-13)"`           → LLM_NARRATION/LLM_COORD
```

```js
export class LLMClient { async propose(bundle) { throw new Error("abstract"); } }
export class AnthropicClient extends LLMClient {
  constructor({apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-sonnet-5", maxTokens = 1200, timeoutMs = 60000} = {})
}
export class MockLLMClient extends LLMClient {
  constructor({dir, scenario, strict = true})           // strict: 缺文件即抛 MockExhausted
  get callCount()
}
export class ReplayLLMClient extends LLMClient { /* 读 runs/<id>/llm/round-NN.txt + usage.json */ }
export function makeClient({mode, ...}) -> LLMClient   // "live" | "mock" | "replay"
```

- `AnthropicClient`：手写 `fetch` POST `https://api.anthropic.com/v1/messages`，头 `x-api-key`、`anthropic-version: 2023-06-01`、`content-type`；**不用 prefill**；`AbortSignal.timeout`。
- `MockLLMClient` 的 `propose` 第 N 次调用读 `round-NN.json`（两位补零）；文件缺失 → 抛 `MockExhausted`（loop 必须转成 `HALT: MOCK_EXHAUSTED`，**不得**当成功）。
- mock **不得**返回任何"已完成"信号：它只能返回 calls。成功必须由 `verify` 判。
- `--record runs/<id>/llm/`：`AnthropicClient` 把 prompt 与原始 response 落盘，供 `ReplayLLMClient` 回放。

### 3.6 判据

- T3-01：`l4-coldstart` 场景，mock 模式，FakeGame + 真宏 + 真 `planToTxOps` + 真 `verify` → 至少一轮 `plan/apply/verify` 全走通；`transcript` 有 4 种 kind。
- T3-02：`neg-empty-calls` → `LLM_EMPTY_PLAN`，`apply` 出现 0 次，`outcome!=="success"`。
- T3-03：`neg-literal-coord` → `LLM_COORD`，0 次 tx。
- T3-04：`MockLLMClient` 文件耗尽 → `HALT: MOCK_EXHAUSTED`，`exitCode!==0`。
- T3-05：篡改 `round-01.json` 成 `build_line` → `LLM_UNKNOWN_MACRO`。
- T3-06：`PromptBundle` 渲染后跑坐标正则 → 0 命中；`goal` 段字符数 >0。

---

## Q4. `diagnose` 的输出 schema 与错误码闭集

### 4.1 决定

`Diagnosis` 是**唯一**跨阶段传递的失败表示。它必须能表达「切割机右槽的带子被删了，货流断了」——由三件事构成：**subject（谁）+ slot/edge（哪个口/哪条链）+ expected/observed（差在哪）**。

```jsonc
{
  "code": "SLOT_STARVED",
  "layer": "L2",
  "severity": "blocker",              // blocker | degraded | info
  "subject": { "handle": "C1", "uid": 10036, "type": "cutter" },
  "slot":    { "role": "left", "index": 0, "cell_ref": "B9" },   // cell_ref 是 handle，不是坐标
  "expected": { "fed": true },
  "observed": { "fed": false, "approach": "empty", "bound_acceptor": null },
  "evidence": { "uids": [10143, 10144], "handles": ["C1","B9","B10"], "path_ids": [17] },
  "candidates": ["connect", "trash_unused"],
  "repairHints": ["upstream_belt_missing", "slot_is_waste_side"]
}
```

`cell_ref` / `handles` / `path_ids` 是**给 LLM 看的**（无坐标）；`uids` 是给机器用的。

### 4.2 错误码闭集

```js
export const DIAG_CODES = Object.freeze({
  // observation
  OBS_TRUNCATED, OBS_STALE, PATHS_TRUNCATED, PRODUCTION_UNAVAILABLE, ITEMS_UNAVAILABLE,
  // llm
  LLM_TRANSPORT, LLM_PARSE, LLM_EMPTY_PLAN, LLM_COORD, LLM_UNKNOWN_MACRO, LLM_ARGS, LLM_LINT,
  // plan / macro
  MACRO_REFUSED, MACRO_HALF_DONE, PLAN_REJECTED, COORD_PROVENANCE,
  // apply
  TX_ROLLED_BACK, TX_UNAVAILABLE, GAME_COERCED,
  // runtime L0–L4
  LANDING_MISSING, LANDING_MISMATCH, DELETE_NOT_REPLAYED, UNDECLARED_DESTRUCTION,
  SLOT_STARVED, OUTPUT_UNROUTED, FLOW_UNREACHABLE, FLOW_UNVERIFIED, DEAD_END,
  NO_PRODUCTION, WRONG_SHAPE_PRODUCED, PRODUCED_NOT_DELIVERED, PRODUCTION_UNTRUSTED,
  // meta
  NO_DIAGNOSIS, NO_PROGRESS, NET_REGRESSION, BUDGET_EXHAUSTED, RV_UNSTABLE, INTERNAL,
});
```

### 4.3 码 → 触发（check 名/宏 error.code）→ 候选宏

| code | 触发（机器判据） | candidates（检索表 base weight） |
|---|---|---|
| `OBS_TRUNCATED` | `obs.truncated===true` 或 `L0.undecidable` | `[]`（确定性修复：提高 max_entities） |
| `OBS_STALE` | `$ref` 句柄不存在 / `removes.expect` 与 obs 不符 / handle.version ≠ obs.tick | `[]`（先重 observe） |
| `PATHS_TRUNCATED` | `items.pathCount > items.paths.length` 或 `truncatedPaths` | `[]`（缩 region 重读） |
| `PRODUCTION_UNAVAILABLE` | `production` 抛错或缺 `slice_seconds` | `[]` |
| `ITEMS_UNAVAILABLE` | `debug_items.beltError` 或 `paths===undefined` | `[]` |
| `LLM_*` | Q3.1 的拒绝表 | 重试同一轮（不消耗 round，消耗 call 预算）；`[]` |
| `MACRO_REFUSED` | 宏 `ok:false` | `error.code` → 宏：`occupied→connect(allow_replace)/remove_run`；`no_path→remove_run/insert_machine`；`port_already_bound→connect(rebind)`；`target_already_fed→trash_unused`；`ambiguous_site→insert_machine(origin 形态)/replace_run`；`not_a_run→[]` |
| `MACRO_HALF_DONE` | `ok:true` 但 `cells_placed!==cells_planned` | `[]` + `INTERNAL` 上报 |
| `PLAN_REJECTED` | `planToTxOps` 红 | 按 `error.code` 见表 5.3 |
| `COORD_PROVENANCE` | `assertProvenance` 红 | `[]`（视为 bug，必须人工） |
| `TX_ROLLED_BACK` | `tx.rolled_back===true` 或 `verify.uid_set_equal===false` | `[]`（先重 observe；若 `failures[].code===2002` → 按 MACRO_REFUSED 映射） |
| `TX_UNAVAILABLE` | `error.code==="tx_unavailable"` 或 mod 无 `tx` feature | `[]`（硬停） |
| `GAME_COERCED` | `tx.results[i].mismatch===true` 或 `op.actual.rotationVariant !== requested` | `replace_run`（重铺该段）/`rv_settle` |
| `LANDING_MISSING` | `L1.evidence.missing[]` | `insert_machine`/`connect`（按缺失实体类型） |
| `LANDING_MISMATCH` | `L1.wrong_{type,rot,rv,code,dir,uid}[]` | `replace_run`（belt→belt 修 rv）/`insert_machine`（重放机器） |
| `DELETE_NOT_REPLAYED` | `L1.evidence.removed_still_there[]` | `remove_run` |
| `UNDECLARED_DESTRUCTION` | `before.byUid − after.byUid − destroys − removedDeclared ≠ ∅` | `[]`（**硬停**，Q8-15） |
| `SLOT_STARVED` | `L2.unfed_inputs[]` | `connect`(8) / `trash_unused`(3) / `insert_machine`(5) |
| `OUTPUT_UNROUTED` | `L2.unrouted_outputs[]` 且 `strictOutputs` 或该槽在 `opts.slots.require` | `trash_unused`(8) / `connect`(6) / `extend_line`(4) |
| `FLOW_UNREACHABLE` | `L3.unreached[]`（有显式 flows） | `connect`(9) / `remove_run`(4) / `insert_machine`(3) |
| `FLOW_UNVERIFIED` | `L3.degraded===true` | `[]`（**不猜**：先补 flows；这是 loop 自己的缺陷） |
| `DEAD_END` | `L3.dead_ends[]` | `trash_unused`(7) / `extend_line`(4) / `connect`(3) |
| `NO_PRODUCTION` | `L4.evidence.produced_after===0 && before===0` | `connect`(6)/`insert_machine`(4)/`trash_unused`(2) + `FLOW_*` 同时给出 |
| `WRONG_SHAPE_PRODUCED` | `production.produced_total` 有产出但 key ≠ goal | `[]`（**先查 goal 键**：形状串抄错是最高频原因） |
| `PRODUCED_NOT_DELIVERED` | `produced>0.05 && delivered===0` | `connect`(8)/`trash_unused`(5)（该形状被系统性丢弃） |
| `PRODUCTION_UNTRUSTED` | `delivered_slices` 可用片数 <2 或最后一片被计入 | `[]`（重采样 ≥30 游戏秒） |
| `RV_UNSTABLE` | `rv_settle` 后仍 `wrong_rv` | `replace_run`(belt 模式) |
| `NO_PROGRESS` / `NET_REGRESSION` / `BUDGET_EXHAUSTED` | Q1.6 / Q6 | `[]`（halt） |

**关键**：`candidates` 为空 = **不许把这条诊断喂给 LLM 让它自由发挥**。loop 直接按「确定性修复或 halt」处理。

### 4.4 判据

- T4-01：L4 的「右槽带子被删」注入夹具（删掉 `10150`），`L2` 产出 `OUTPUT_UNROUTED`（或 `FLOW_UNREACHABLE`），`subject.uid===cutter`，`slot.role==="right"`，`candidates` 含 `connect`/`trash_unused`。
- T4-02：`L2` 的 `skipped`（纯带子计划）**不得**产出任何 diagnosis。
- T4-03：`DIAG_CODES` 里每个码都有 ≥1 条构造用例；`diagnose()` 返回的 `code` 全部 ∈ `DIAG_CODES`（闭集断言）。
- T4-04：`candidates` 里的宏名全部 ∈ `MACRO_NAMES`。

---

## Q5. apply 的原子性

### 5.1 决定

**顺序：全宏 dry-run → 合并成一个 `TxPlan` → 一次 `tx` → 读回 → 必要时一次 `rv_settle` tx。** 不做跨 RPC 事务（mod 明确不支持）。

关键裁决：**`planToTxOps` 是纯函数，不碰网络**。它只把宏返回值翻译成 `ops[]`，并做 12 条自检。`apply.mjs` 才发 RPC。

```js
export function planToTxOps(calls, ctx) -> {ok, ops, destroys, pendingByOp, placements, removes, warnings, error}
```

### 5.2 12 条实现规格（每条一个测试）

| # | 规则 | 失败码 |
|---|---|---|
| R1 | `calls` 非空；每条 `result.ok===true` | `plan_rejected` |
| R2 | 每条 `result` 过 `validateMacroResult` | `macro_half_done` |
| R3 | 收集 `destroys`：`result.changed.removed_uids` + `result.removed_uids` + `result.removes[].uid` + `result.replaced_belt_uid` + `result.replaced_uids[]`。**去重** | — |
| R4 | 收集 `places`（按宏类型分派，见 5.2 细则） | — |
| R5 | **去重冲突**：同一 `(x,y)` 被两个 place 目标命中 → 红 | `plan_conflict` |
| R6 | **占用检查**：每个 place 目标格必须满足「obs 里为空」或「在 destroys 里」。命中 obs 的机器/hub → 红 | `plan_conflict` |
| R7 | **删除检查**：每个 delete 的 uid 必须 ∈ obs | `plan_stale` |
| R8 | **op 上限**：`ops.length ≤ 2000`；`place` 目标数 ≤ 1200 | `plan_too_large` |
| R9 | **排序**：`deletes`（按 uid 升序）→ `machines`（按 `(y,x)`）→ `belts`（按路径倒序） | — |
| R10 | **op 形状**：`{op:"delete", uid}` 或 `{op:"place", building, x, y, r, variant?, rotationVariant?}`。**必须**给 belt 的 `rotationVariant` | `op_shape` |
| R11 | **pending 桥接表**：`pendingByOp[i] = token`，仅对由 `pending` 产生的 place op 建立 | `plan_rejected` |
| R12 | **placement 计划（给 verify 用）**：`placements[]` + `removes[]`（来自 obs）。这份对象**直接**喂给 `verifyRuntime` | — |

`places` 的来源分派（R4 细则）：
- `insert_machine` → `{building: result.machine.kind, variant, x: origin[0], y: origin[1], r: rotation}`
- `replace_run`（machine 模式 / belt 模式）→ `result.placed[]` 逐个
- `connect` / `extend_line` → `result.cells[]`（`{x,y,building:"belt",r:rotation,rotationVariant}`）
- `trash_unused` → `{building:"trash", x: trashCell[0], y: trashCell[1]}`

### 5.3 失败时怎么回滚

**不自己回滚。** 只发一次 `tx`，由 mod 的 `opTx` 做快照/回滚。loop 只做三件检查：

1. `tx.rolled_back===true` → 视为失败（`TX_ROLLED_BACK`），**禁止**用 `tx.net` 里的"本来会发生什么"当成功。
2. `tx.verify.uid_set_equal===false` → 硬停。
3. `tx.dry_run===true`（loop 从不主动设）→ `INTERNAL`。

**唯一的「多次 tx」例外**：`rv_settle`（Q1.7），每 run 最多 1 次。

### 5.4 `pending (uid:null)` → 真 uid 的桥接（F3/F5）

三段式，缺一不可：

```
①  计划态：下游宏直接吃 result.pending
     —— insert_machine → trash_unused 可以（同一轮）
     —— insert_machine → connect 不行（resolveEntity 无 pending 分支）→ 必须拆两轮

②  落盘态：tx.results[i].uid → pendingByOp[i] → token
     uidMap[token] = tx.results[i].uid
     —— 不发第二次 RPC，不再猜几何

③  校验态：新 obs 必须满足
     obs.entities.find(e => e.uid === uidMap[token]).x/y === pending.origin[0/1]
     .type === pending.kind
     否则 TX_ROLLED_BACK 或 GAME_COERCED
```

**拆两轮的判据（写进 dsl.mjs 的静态检查）**：如果同一轮里 `insert_machine` 的 `pending` 被 `connect.from/to` 引用 → `LLM_ARGS` + hint「connect 不接受计划态端点；先落盘这一台，下一轮用它的 uid 连」。这条 hint 是最重要的一条 LLM 教育信息。

### 5.5 判据

- T5-01：L4 的 `replace_run(region=[4,-14,5,-13], building=["cutter",{trash,port:"left"}])` → `ops` 顺序为 delete 升序 → cutter place → trash place；`ops.length===5`。
- T5-02：同一 plan 里两个宏都想占 `(5,-13)` → `plan_conflict`，`ops` 为空。
- T5-03：把 `obs` 里 `10143` 删掉后再跑 → `plan_stale`。
- T5-04：`insert_machine` + `trash_unused(pending)` 同一轮 → `ops` 2 条，`pendingByOp` 指向 trash 的那条 place。
- T5-05：`insert_machine` + `connect(to:pending)` → 解析期红，`PLAN_REJECTED`，hint 含「下一轮」。
- T5-06：给 belt 的 place op **不带** `rotationVariant` → `op_shape` 红。
- T5-07：`tx.results[i].uid` 与 `pending.origin` 不符（FakeGame 里手工改 uid）→ `GAME_COERCED`。

---

## Q6. 预算与终止

### 6.1 常量（唯一位置：`src/agent/loop/constants.mjs`，全部 `Object.freeze`）

```js
export const BUDGET = Object.freeze({
  ROUNDS_MAX: 6,
  LLM_CALLS_MAX: 8,
  LLM_CALLS_PER_ROUND: 1,
  TX_MAX: 8,
  TX_OPS_MAX: 2000,           // = mod 的硬限（shapez-ai-bridge.js:3255）
  TICKS_MAX: 24000,           // = 200 游戏秒 @120Hz
  WALL_MS_MAX: 15 * 60_000,
  SAME_FINGERPRINT_MAX: 2,    // 第 3 次出现即 halt
  LLM_IN_CHARS_MAX: 12000,
  LLM_OUT_CHARS_MAX: 4000,
  PROMPT_STATE_BELTS_MAX: 12,
});
export const MODES = Object.freeze(["live","mock","replay"]);
export const RUN_DIR = "research/ai-plan/runs";
```

### 6.2 超限行为：**保留现场**，不许静默

```js
// run_end.data.preserved
{
  "dir": "research/ai-plan/runs/r-20261028T1200-l4",
  "files": ["transcript.jsonl","obs-last.json","items-last.json","production-last.json",
            "plan-last.json","tx-last.json","verify-last.json","HALT.json"],
  "resume": "node src/agent/loop.mjs --resume <dir>",
  "world_state": "applied",            // "untouched" | "applied" | "rolled_back" | "unknown"
  "last_successful_round": 2
}
```

- **不回滚**最后一次成功的 tx。
- `HALT.json`：`{reason, at_round, fingerprint, remaining_budget, diagnoses, next_actions:[...]}`。
- CLI 退出码：`0` 成功 / `2` halt / `1` 未捕获错误 / `3` 计划被拒但预算未尽。

### 6.3 判据

- T6-01：把 `LLM_CALLS_MAX` 注入为 2，跑 `l4-repair-one` → 恰好 2 次 `propose`，第 3 轮前 halt，`HALT.json.reason==="BUDGET_LLM_CALLS"`。
- T6-02：`ROUNDS_MAX=1` + 首轮失败 → halt，`preserved.world_state==="applied"` 且 `files` 齐全。
- T6-03：常量表被冻结（`Object.isFrozen`），且 `TX_OPS_MAX === 2000`。
- T6-04：`--resume` 能读 `HALT.json` 并追加 transcript。

---

## Q7. 文件清单与依赖图

### 7.1 新建文件（全部在 `src/agent/loop/`，除夹具）

| # | 文件 | 导出（公共 API） | 行数估计 | 依赖 |
|---|---|---|---|---|
| N-01 | `types.mjs` | JSDoc typedef + `RUN_KINDS` | 90 | 无 |
| N-02 | `constants.mjs` | `BUDGET`, `MODES`, `RUN_DIR`, `DIAG_CODES` | 120 | 无 |
| N-03 | `transcript.mjs` | `openTranscript`, `append`, `worldUidSetHash`, `hashJson`, `readTranscript` | 150 | node:fs/path/crypto, N-01/02 |
| N-04 | `handles.mjs` | `buildHandles`, `handleOf(uid)`, `resolveHandle(h)`, `describeEntity(e)` | 220 | N-02 |
| N-05 | `diagnose.mjs` | `diagnose({obs, items, production, report, goal, handles}) → Diagnosis[]` | 380 | N-02/N-04 |
| N-06 | `retrieve.mjs` | `retrieve`, `RETRIEVAL_TABLE`, `macroCard` | 200 | N-02, `contract.mjs` |
| N-07 | `dsl.mjs` | `parseLlmPlan(text)`, `resolve()`, `validateCalls`, `DSL_ERRORS` | 320 | `contract.mjs`, N-04 |
| N-08 | `assertNoHumanCoords.mjs` | `assertNoHumanCoords`, `assertProvenance`, `COORD_RULES` | 180 | N-07 |
| N-09 | `prompt.mjs` | `buildPrompt(...) → PromptBundle` | 240 | N-04/N-06, N-02 |
| N-10 | `llm.mjs` | `LLMClient`, `AnthropicClient`, `MockLLMClient`, `ReplayLLMClient`, `makeClient` | 220 | node:fs/path, N-02 |
| N-11 | `rpc.mjs` | `rpc(method,params,timeout)`, `makeReader(baseUrl)` | 110 | 无（`fetch`） |
| N-12 | `planToTxOps.mjs` | `planToTxOps`, `TxPlanError` | 300 | N-07, `contract.mjs` |
| N-13 | `apply.mjs` | `applyTxPlan(txPlan, reader) → ApplyReport` | 150 | N-11/N-12, N-03 |
| N-14 | `verify.mjs` | `verifyRound(...)`, `strictVerdict` | 200 | `verify_runtime.mjs`, N-03/N-04 |
| N-15 | `repair.mjs` | `decide`, `diagnoseFingerprint`, `deterministicFix` | 180 | N-05/N-03/N-02 |
| N-16 | `loop.mjs` | `runLoop(opts)`, CLI | 300 | 全部 |
| N-17 | `harness.mjs` | `makeEnv({kind:"fake"\|"live"})` | 120 | `fake_game.mjs`, N-11 |
| 测试 | 每个模块一个 `.test.mjs` | — | 各 150–400 | — |
| 夹具 | `test/fixtures/llm/`（6 个场景） | — | — | — |
| 夹具 | `test/fixtures/saves/L4-items.json`（**缺失**） | — | — | — |

**夹具缺口说明**：L4 **没有**配套的 `debug_items` dump（`L5-items.json` 属于另一张存档）。
`L4-items.json` 必须从改造前的真实存档用 `debug_items {region:[-12,-36,12,-6]}` 只读读一次。
否则 L2/L3 在 L4 冷启动上无法判定 —— 这是本契约里**唯一**必须碰实机的交付（只读）。

### 7.2 依赖图（边 = "必须先存在"）

```
types → constants → {transcript, handles, retrieve, rpc}
handles → {diagnose, prompt}
retrieve → prompt
prompt → llm
{rpc, contract} → planToTxOps
{planToTxOps, rpc} → apply
{apply, verify_runtime} → verify
{verify, diagnose} → repair
{all} → loop
{loop, fake_game} → harness
```

**可并行的切割面**（三处接口一旦冻结，互不阻塞）：
- `Diagnosis`（N-01 定义）← N-05/N-06 只依赖它
- `LlmPlan` / `ResolvedCall`（N-01）← N-07/N-08/N-09 只依赖它
- `TxPlan`（N-01）← N-12/N-13/N-14 只依赖它

---

## Q8. 反例清单（22 条「这个 loop 会假装成功」）

| # | 假成功形态 | 防线（机器可检） | 实现层 |
|---|---|---|---|
| 01 | LLM 返回 `calls:[]`，loop 判"没有要做的，成功" | `LLM_EMPTY_PLAN` 硬拒；`success` 要求 `tx_success_count>=1` | N-07 / N-16 |
| 02 | **所有 check 都 `skipped`**（`verifyRuntime.ok===true`，F1） | `strictVerdict`：L0/L1 必须存在且 ok；L2 在有机器时不得 skipped；L3 不得 degraded；L4 在 live 下不得 skipped | N-14 |
| 03 | `obs.truncated===true` 时 L0 报 `undecidable`，顶层 `ok` 仍可能 true | `strictVerdict` 把 `undecidable` 一律判红 | N-05/N-14 |
| 04 | `debug_items.paths` 只给前 40 条，L2/L3 看不见真凶 | `PATHS_TRUNCATED` 诊断 + `undecidable` 红 | N-05 |
| 05 | 宏 `ok:true` 但 `cells_placed !== cells_planned` | loop 对每条 result 再跑 `validateMacroResult`；不等即 `MACRO_HALF_DONE` + `INTERNAL` | N-12 |
| 06 | `place` 报 `ok:true` 但游戏把 rv 改了（`mismatch:true`） | `apply` 检查 `tx.results[i].mismatch`；`verify` 的 L1 兜底；1 次 `rv_settle` 后仍红 → `RV_UNSTABLE` | N-13/N-14 |
| 07 | **L3 无 flows 时 `degraded:true` 被当绿**（F2） | `strictVerdict` 要求 L3 必须带显式 flows；`degraded===true` 一律红 | N-14 |
| 08 | 修复轮把世界改得更糟，但目标 check 变绿了 | `UNDECLARED_DESTRUCTION` 硬停；`NET_REGRESSION`：`hardFails` 增加或出现新 code → halt | N-14/N-15 |
| 09 | **跑错关**：用 L5 夹具却报告"L4 通过"（F6） | 启动断言 `obs.goal.requirement.shape === opts.goal`；`fixture_hash` 写进 transcript | N-17/N-16 |
| 10 | **mock 跑通被当成阶段 2 达成** | `run_start.mode` 与 `run_end.mode` 必须为 `live` 才计；验收脚本 `grep '"mode":"live"'` | N-03/N-16 |
| 11 | LLM 夹带坐标 | `assertNoHumanCoords` V1–V7；`plan` 前一票否决 | N-08 |
| 12 | 句柄过期：apply 后复用旧 handle 表 | handle 表版本 = `obs.tick+obs_hash`；`$ref` 解析时比对 → `OBS_STALE` | N-04/N-07 |
| 13 | `tx` 返回 `ok:false` 但 `applied>0`（半成），loop 只看 `applied` | 只看 `tx.ok===true && rolled_back===false && verify.uid_set_equal===true` 三者同时成立 | N-13 |
| 14 | `tx.dry_run===true`（配置错）被当成功 | `apply` 断言 `tx.dry_run===false` | N-13 |
| 15 | **未声明销毁**：`replace_run` 吃掉上游带子，只发 warning | `UID_DIFF` 守卫：`before∪after` 的 uid 差集 ⊆ `destroys ∪ removedDeclared`，否则硬停 | N-14 |
| 16 | `connect` 规划出 0 格被当"连上了" | `planToTxOps` R4：`cells.length===0` → `plan_conflict`；`strictVerdict` 要求该 flow 在 L3 可达 | N-12/N-14 |
| 17 | **行为检查用 `produced` 而不是 `delivered`**：废料侧在产出，目标侧 0 交付 | 只用 `delivered_slices`（排除最后一片累积片）；`PRODUCED_NOT_DELIVERED` 单独成码 | N-05/N-14 |
| 18 | `production` 采样偏差导致"差一点达标"被判过 | `PRODUCTION_UNTRUSTED`：`slice_seconds>0` 且可用片数 ≥2 且非全空 | N-05 |
| 19 | **一次成功被复制成 3 次**，凑"5 次≥3" | `attempt_id` 唯一；`transcript_sha` 唯一；`fixture_hash` 必须相同但 `plan.calls_sha` 不得全同 | N-03/N-16 + 验收脚本 |
| 20 | 异常被 `catch` 吞掉，进程 `exitCode=0`，无 `run_end` | 顶层 `try/finally`：`finally` 必写 `run_end`；`exitCode` 只由 `outcome` 决定 | N-16 |
| 21 | `FakeGame.apply` 对不存在的 uid 删除**静默成功**，掩盖真机 2002 | `apply.mjs` 对 FakeGame 也走 `planToTxOps` 的 R7（删除必须 ∈ obs） | N-13 |
| 22 | `FakeGame.observe` 的 `entity_count` 与 mod 语义不一致 | harness 启动自检：`entity_count === entities.length` 或 `truncated===true`；不一致即 `INTERNAL` | N-17 |

**对既有代码的两处必要（但不破坏测试的）增强**（都只是新增可选参数，默认行为不变）：
- `fake_game.mjs`：`constructor(obs, items, {strict=false})` / `apply(ops, {strict})`：`strict` 下删不存在的 uid 返回 `failures`。**（Q8-22 的 entity_count 已由主线程修正，契约此条过时）**
- 无需改 `verify_runtime.mjs`。`strictVerdict` 完全在 N-14 里实现。

---

## 5. 并行分工建议（5 个 agent）

### 冻结的接口（L0 产出，所有 agent 只读）

`types.mjs` + `constants.mjs` + 本文件 §Q1.2/§Q4.1/§Q5.1 的 typedef。**任何 agent 不得改这三个文件的签名**。

| Agent | 任务 | 输入 | 输出 | 验收 | 依赖 |
|---|---|---|---|---|---|
| **L0（串行）** | 地基：`types.mjs` `constants.mjs` `transcript.mjs` `harness.mjs` + test；补 `L4-items.json`（只读 RPC，需实机） | §Q1.2/§Q1.4/§Q6/§Q7 | 4 文件 + 3 test | `worldUidSetHash` 对同一 obs 稳定、对 +1 格变化敏感；`run_end` 必写 | 无 |
| **L1** | `handles.mjs` `diagnose.mjs` `retrieve.mjs` + tests | L0；`verify_runtime.mjs` 的 checks 结构 | 3 文件 + 3 test | T4-01～04；对 L5 夹具不得产出 `SLOT_*`（说明没跑错关）；`RETRIEVAL_TABLE` 宏名 ⊆ `MACRO_NAMES` | L0 |
| **L2** | `dsl.mjs` `assertNoHumanCoords.mjs` `prompt.mjs` `llm.mjs` + tests + `test/fixtures/llm/` 6 场景 | L0；`contract.mjs` | 4 文件 + 4 test + 夹具 | T2-01～05、T3-01～06；prompt 渲染后坐标正则 0 命中 | L0 |
| **L3** | `rpc.mjs` `planToTxOps.mjs` `apply.mjs` + tests | L0；`contract.mjs`；`fake_game.mjs` | 3 文件 + 2 test | T5-01～07；R1–R12 每条 ≥1 用例 | L0 |
| **L4** | `verify.mjs` `repair.mjs` + tests | L0；`verify_runtime.mjs` | 2 文件 + 2 test | T1-01～04、T6-01～04；`strictVerdict` 对三种构造必须红 | L0 |
| **L5（集成）** | `loop.mjs` + 2 场景 + `scripts/phase2-accept.mjs` | L0–L4 | `loop.mjs` + 场景 + 脚本 | 与 FakeGame 端到端 ≥3 次独立 attempt；`mode!=="live"` 被脚本标为"离线通过、不计阶段 2" | L0–L4 |

**冲突规避**：L1–L4 各自只写自己的文件与 test；`types.mjs`/`constants.mjs`/`transcript.mjs`/`harness.mjs` 由 L0 独占。L5 只写 `loop.mjs` 与 `scripts/`。

**每周一次的「假绿审计」**：把 `verify.mjs` 的 `strictVerdict` 改成 `return {ok:true,why:[]}`，L4 的 test 必须红；否则 Q8-02 的防线是空的。

---

## 6. 阶段 2 达成判据（写进验收脚本，不可讨价还价）

1. **冷启动**：`--goal RuRu---- --llm`，输入只有 `L4-obs.json` + 目标；人工输入 = 0 个坐标。
2. **无人工坐标**：`assertNoHumanCoords` 在整条 run 的每个 `propose` 上为绿；`assertProvenance` 在每个 `plan` 上为绿；验收脚本额外断言 `transcript` 中 `apply` 的每个 `place.x/y` 都有 `provenance`。
3. **连续 5 次独立尝试 ≥3 次成功**：5 个独立 `run_id`、5 个不同 `transcript_sha`、同一 `fixture_hash`；`mode==="live"` 才计数。
4. **失败必须结构化**：每个非成功 run 的 `run_end` 必须带 `reason ∈ DIAG_CODES` 且 `HALT.json.diagnoses.length>0`。
5. **不破坏既有**：`gates.test.mjs` / `mod_selftest` / `verify_runtime.test.mjs` / 6 个宏 test 全部与基线一致，新增文件不 import 任何新依赖。

---

## 7. 最关键的一个裁决 + 最可能出错的一处

**最关键裁决**：LLM 的输出不是 DSL，而是**句柄级宏调用 JSON**；坐标由 loop 侧 `$ref / $uids / $bbox_of` 解析成 contract 的 uid/cell/region，并为每个坐标打 `provenance` 标签，`assertNoHumanCoords` 与 `assertProvenance` 双层把关。这把「没人算坐标」从口令变成结构事实：LLM 的上下文里根本没有坐标系，只有带标签的图。

**最可能出错处**：`verifyRuntime` 的顶层 `ok` 把 `skipped` 当绿（`verify_runtime.mjs:850`），而 L3 在未给 flows 时返回 `ok:true, degraded:true`。loop 若图省事读 `r.ok`，就会在「L2 跳过、L3 降级、L4 跳过」的全空验证上报成功 —— 这正是本项目已犯过四次的假绿形态。所以 `strictVerdict` 必须是 loop 的唯一判据，并且要有一条变异测试：把它改成恒真，测试必须红。
