# 红队：阶段 2 契约

> 攻击对象：`research/ai-plan/PHASE2-CONTRACT.md`（794 行，md5 `22461e5`，2026-10-28 20:39）。
> 基线：`HEAD = ab86ce3`。核查期间工作区有并发提交（`f619cca` 改 verify、`62ad11b` 改宏），
> 凡受影响的结论都注明「在哪个 commit 上成立」。
> 方法：每条批评都能用仓库里的命令或 `.tmpverify/rt-phase2-*.mjs`（共 50+ 个可复跑脚本）复现。
> **没有碰游戏实例**，全部离线（FakeGame / 真实 dump / 纯函数）。

---

## 结论（一句话）

**不能直接开工。** 不是因为设计方向错（方向是对的），而是因为契约里**五处关键判据引用了不存在的字段**
（`produced_delta` / `tx.verify.uid_set_equal` / `tx.results[i].mismatch` / `report.uidDiff` / `fixture_hash`），
按字面实现后 **live 模式 100% 永远判红**；同时它作为立论基础的第 0 节事实 **F7 是测量错误**
（真实存档上 `connect` 不是「一次都连不成」，至少 23 种组合能连成），而 §0 里两条「必须知道的事实」
行号已在本次并发提交后失效。**修这 5 个字段 + 重做 F7 的枚举，再加 4 条遗漏（flows 谁产出、多次 live 之间怎么复位存档、
arg 拼错怎么办、宏间同轮依赖排序），契约就可以开工。**

---

## 致命问题（按严重度排序）

### 1. `strictVerdict` 第 5 条引用 `evidence.produced_delta`，这个字段已被删除 —— live 模式永远无法通过

- **问题**：契约 §1.5 规则 5（第 200 行）写 `evidence.produced_delta > 0 或交付增量 >0`。
- **证据**：`f619cca`（20:30）**故意删掉了** `produced_delta`，理由是跨窗口相减物理上无意义；
  `src/agent/verify_runtime.test.mjs:634` 有一条断言 `!("produced_delta" in l4.evidence)`。
  当前 `checkBehavior` 的 evidence 只有 `produced_window_before/after`、`delivered_in_window_after`、`goal_delivered_delta`（`verify_runtime.mjs:790-798`）。
- **复现**：`node .tmpverify/rt-phase2-55.mjs` → `produced_delta` 不存在；契约里三个码也引用旧字段。
- **后果**：`mode==="live"` 时规则 5 恒为假（`undefined > 0`），loop 永远不判 SUCCESS。
  更糟：实现者会「顺手」把它改回 `produced_window_after > 0`，于是**废料侧在产、目标侧零交付也判绿** —— 正是 Q8-17 要防的形态。
- **修法**：规则 5 改为 `evidence.goal_delivered_delta > 0 || evidence.delivered_in_window_after > 0`，
  并**照抄** `checkBehavior` 现在的三个字段名（不要自创）。

### 2. apply gate 读 `tx.verify.uid_set_equal`，而 **tx 成功时 `verify` 恒为 `null`** —— 每次成功的 tx 都会抛 TypeError

- **问题**：契约第 128 行（apply 阶段失败条件）、516 行（`TX_ROLLED_BACK` 触发）、586 行（Q5.3 第 2 条）、742 行（Q8-13）都写 `verify.uid_set_equal`。
- **证据**：`src/mod/shapez-ai-bridge.js:3361-3362`
  ```js
  let verify = null;
  if (doVerify && mustRollback) {   // ← 只有回滚时才填
  ```
  这意味着 `verify` 字段只在失败时非空。成功路径 `verify === null`。
- **复现**：`node .tmpverify/rt-phase2-55.mjs` → `THROWS: TypeError Cannot read properties of null (reading 'uid_set_equal')`。
- **后果**：任何一次成功的 tx 都会在 apply 阶段抛未捕获异常 → 走 `ERROR` 分支、`exitCode=1`。
  **阶段 2 的成功路径第一步就崩**。这也解释了为什么 `grep uid_set_equal src/agent` 只命中 `.tmpverify/rt/ms_dbg*.mjs`（那是 mod 自测，且断言的是**回滚**场景）。
- **修法**：成功的判据只能是 `tx.ok===true && tx.rolled_back===false && tx.dry_run===false && tx.applied===tx.requested`；
  `uid_set_equal` 只在 `rolled_back===true` 时才有意义，且此时应直接判失败。

### 3. `tx.results[i].mismatch` 不存在 —— `GAME_COERCED` 与 Q8-06 的防线是空的

- **问题**：第 518 行 `GAME_COERCED` 触发条件、第 735 行 Q8-06 防线，都依赖 `tx.results[i].mismatch===true`。
- **证据**：`shapez-ai-bridge.js:3402-3406`，tx 的结果对象是
  ```js
  results: appliedResults.map(r => ({ index, op, ok, uid, applied }))
  ```
  **没有 `mismatch`，也没有 `actual`**。`mismatch` 只存在于 `opPlace` 的内层返回（`:2628`），
  `opTx` 把它丢了。
- **复现**：`node .tmpverify/rt-phase2-55.mjs` 打印的 tx result 只有 5 个字段。
- **后果**：「游戏把 rv 改了」这件事在 tx 层**看不见**。唯一兜底是下一轮 L1（`wrong_rv`/`wrong_code`），
  但 L1 只在 obs 里比对，而 `place` 成功但 rv 被邻居重算时 **L1 会红、`GAME_COERCED` 永远不会**，
  于是 `RV_UNSTABLE` 这条确定性修复链（Q1.7）永远不触发。
- **修法**：`planToTxOps/apply` 改成读 `tx.diff.modified`（tx 返回里有）或让 mod 把 `mismatch` 透传到 results；
  在契约里明确「tx 层拿不到 mismatch，只能在 verify 层判」，并删掉 `GAME_COERCED` 的 tx 分支。

### 4. `report.uidDiff.undeclared_vanished` 不存在 —— strictVerdict 规则 7 与 Q8-15「硬停」无法实现

- **问题**：第 202 行规则 7、第 522 行 `UNDECLARED_DESTRUCTION`、第 713/743 行 Q8-15。
- **证据**：`grep -rn "uidDiff" src/` → **0 命中**。`verifyRuntime` 返回的对象里只有 `{ok, plan, checks, obs}`（`verify_runtime.mjs:917-925`）。
  `VerifyReport` 的 typedef（第 118 行）列了 `worldBefore/worldAfter/uidMap/uidDiff`，但 `strictVerdict` 拿到的是
  **`verifyRuntime` 的原样返回**，里面没有任何一项。
- **后果**：这条「硬停」不可能生效。而且它需要 `before.byUid`，而 live obs 是 region 过滤 + `max_entities` 截断的
  （`shapez-ai-bridge.js:1334-1342`），`before` 与 `after` 的截断集合可能不同 —— 差集里会出现**假消失**。
- **修法**：loop 自己在 `apply` 那一刻用 `tx.diff.added/removed`（tx 返回里有，且是权威的）算差集，
  与 `destroys` 比较；不要绕道 obs。契约要把这条从「verify 规则」挪到「apply 后置检查」。

### 5. 契约 §0 的 **F7「真实存档上 connect 一次都连不成」是错的** —— 它把 5 台机器当成了全部 21 台

- **问题**：第 29-58 行，F7 声称穷举「所有机器→机器」共 160 次、成功 0 次，并据此**下调 connect 权重、
  强制「拆建分两轮」、把 `ROUNDS_MAX` 抬到 6**。
- **证据**：
  1. `src/agent/macro_execution_ops.test.mjs:207` 的机器集合是
     `ents.filter(e => ["cutter","trash","hub"].includes(e.type))` —— **5 台**。
  2. 同一张 L5 存档里的非带子实体实际有 **21 个**（含 hub）：8 miner、7 balancer、2 cutter、2 trash、1 hub、1 constant_signal
     （`node -e` 统计见下文命令）。F7 的 160 = 5×4×2×4，正好对应它漏掉 16 个实体后的规模。
  3. 把 miner / balancer 与 `"secondary"` / `"primary"` / `"out"` 等角色加进去后，我实测 **23 种组合 connect 成功**，
     其中 **10 条直达 hub**（`balancer#10084/10085/10186/10187/10188 → hub#10000`，每台两个入口）。
     能连通的源只有 **balancer** 一种 —— 但这就足以推翻「一次都连不成」。
- **复现**：
  ```bash
  node -e "const o=require('./test/fixtures/saves/L5-obs.json').result;const m=o.entities.filter(e=>!['belt','underground_belt','hub'].includes(e.type));console.log(m.length, m.map(e=>e.type+'#'+e.uid).join(' '))"
  node .tmpverify/rt-phase2-66.mjs      # → total unique successes 23 | to hub 10
  ```
- **后果**：这是**最贵的一个错误**。整个 Q4 的检索权重（`connect` 从 8/9 下调）、Q1 的「拆建必须两轮」、
  Q6 的 6 轮预算，全部建立在一个**枚举漏了 15 台机器**的测量上。按 F7 设计的 loop 会主动回避唯一能用的宏。
  准确的说法应该是：「**只有 balancer 的 spare 口能连**；cutter/miner/trash 的输出已全部被占」——
  这仍然很糟，但它是**可修的约束**（先释放一个 port），不是「connect 在真存档上不可用」。
- **修法**：重做 F7 的枚举（含 miner/balancer、含 `secondary`/`out`/`entry:N` 全部角色、含 `opts.rebind`），
  把「0 成功」改成实测分布；然后重新推导 Q4 权重与 Q6 预算。**在重做之前不要按 F7 改设计。**

### 6. `planToTxOps` 的 R6 会把 `connect(allow_replace)` 的正确计划判成冲突 —— 与 F7 的「先拆后建」直接打架

- **问题**：R3（第 564 行）收集 `destroys` 的来源全是「宏自报」；R6（第 567 行）要求每个 place 目标格
  「obs 里为空」或「在 destroys 里」。
- **证据**：`connect` 实测在 `allow_replace:true` 时**只发一条 warning，不报 uid**：
  ```js
  // connect.mjs:861-866
  if (pick.occ.replaceable > 0) warnings.push({ code:"replacing-belts", detail:"...有 N 格是既有带子..." });
  // 且 changed.removed_uids 恒为 []（connect.mjs:880）
  ```
- **复现**：`node .tmpverify/rt-phase2-46.mjs` →
  `place targets: ...3,0 4,0 5,0` / `destroyed set: []` / `R6 would flag: 3,0 4,0 5,0`。
- **后果**：`connect(allow_replace)` 永远不会被 `planToTxOps` 接受 —— 而 F7 又要求用它来「覆盖路径」。
  两条裁决在同一份契约里互相否决。更隐蔽的是：R3 的 `replaced_belt_uid`/`replaced_uids[]` 只有
  `replace_run`/`trash_unused` 有，`connect` 两个都没有。
- **修法**：二选一 —— 要么给 `connect` 加 `replaced_belts:[{uid,cell}]` 返回字段（改既有宏，需另开裁决），
  要么在 `planToTxOps` 里从 `connect.cells[]` 与 obs 求交集自己算 destroys（可做，但必须写进契约，并加测试）。

### 7. `strictVerdict` 规则 4 要「显式 flows」，但契约**没有定义谁产出 flows**，而 `flows` 可以用 `from==to` 自证

- **问题**：第 199 行「L3-flow 必须提供显式 flows」。全文 `grep flows` 只有 6 处，全是「必须给」/「先补 flows」，
  **没有任何 flows 的构造规则、schema、来源、测试**。
- **证据**：
  1. `checkFlow` 的 `reach()` 以 `new Set([start.uid])` 起手（`verify_runtime.mjs:652`），
     所以 `flows:[{from:X,to:X}]` **恒绿**。
  2. 复现：`node .tmpverify/rt-phase2-62.mjs` → 孤立单格带上 `from==to` → `{flows:1,reached:1,unreached:[]}`。
     在修好后的 L4 上 `hub→hub` 也是绿（`node .tmpverify/rt-phase2-45.mjs`）。
- **后果**：规则 4 有两条相反的失败模式，而且**同时成立**：
  - 如果 loop 老实按「cutter → hub」给 flows，L4 修好后仍然**红**（实测 `cutter→hub` RED，因为 items 里那条链确实不通）；
  - 如果 loop 图省事给 `from==to`，规则 4 **恒绿**，而 L3 什么也没验。
  即：这条规则要么让正确解过不了，要么完全无效。它是本契约里**最像防线、实际是空炮**的一条。
- **修法**：把 flows 定义成**宏返回值推导**的确定性产物（例如 `connect/replace_run` 返回 `fromPort/toPort`，
  flow = `{from: fromPort.entity, to: toPort.entity}`），并禁止 `from===to`（`assertFlows` 里一条断言）。
  在 flows 有确定来源之前，规则 4 应降级为「L3 必须非 degraded 且 evidence.flows>0 且 reached>0」。

### 8. `DIAG_CODES` 块不是合法 JS，且 §6 验收要求的 `reason ∈ DIAG_CODES` 里有一半不在集合内

- **问题**：第 483-501 行。
- **证据**：
  ```js
  export const DIAG_CODES = Object.freeze({
    OBS_TRUNCATED, OBS_STALE, ...   // ← 未定义的标识符
  ```
  `node .tmpverify/rt-phase2-57.mjs` → `ReferenceError: OBS_TRUNCATED is not defined`。
  它**声明了 38 个**（不是「24 个」），但正文另外用了 12 个**未声明**的码：
  `DIAGNOSIS_UNMAPPED`、`NO_WORLD_CHANGE`、`NO_PROGRESS_3X`、`BUDGET_ROUNDS`、`BUDGET_LLM_CALLS`、
  `MOCK_EXHAUSTED`、`PROMPT_OVER_BUDGET`、`LLM_NOT_JSON`、`LLM_SCHEMA`、`LLM_TOO_MANY_CALLS`、
  `LLM_DUP_MACRO_ON_SUBJECT`、`LLM_TOO_LONG`、`LLM_NARRATION`。
- **后果**：§6 判据 4「每个非成功 run 的 `run_end.reason ∈ DIAG_CODES`」按字面**永远不会通过** ——
  它自己点名的 `BUDGET_ROUNDS` / `BUDGET_LLM_CALLS` / `NO_PROGRESS_3X` / `MOCK_EXHAUSTED` 全在闭集外。
  验收脚本与契约自相矛盾。
- **修法**：`DIAG_CODES` 写成 `Object.freeze(["A","B",...])` 或 `{A:1,...}`；把 12 个漏网码补进闭集；
  验收判据改成 `reason ∈ DIAG_CODES ∪ HALT_REASONS`（两者都声明）。

### 9. `$bbox_of` 只能表达矩形 —— `replace_run` 对 L 形/斜选一类的真实改造**无法表达**，且会误删

- **问题**：Q2 宣称「三种算子覆盖世界」。`replace_run.region` 只接受 `BBox`（闭区间），`$bbox_of` 是唯一来源。
- **证据**：
  1. L 形三格 `(-8,-12)(-8,-13)(-7,-13)` 的 bbox 是 `[-8,-13,-7,-12]`，第四格是 **underground_belt**
     → `replace_run` 直接 `out_of_scope`（`node .tmpverify/rt-phase2-32.mjs`）。
  2. 斜选 `(4,-13)` + `(4,-14)` 的 bbox 会**把 `(5,-13)` 与 `(5,-14)` 也吃进去**（实测 removed 3 格，多删了 10149）。
  3. 用户说「那条带子往上游扩一格」时，`$bbox_of(这三条带子)` 与 `$bbox_of(这三条 + 上一格)` 是**同一个 bbox**，
     没有任何算子能表达「扩一格」；`$offset`/`$expand` 被 V6 明令禁止。
- **后果**：`replace_run` 只对**矩形**改造安全。L4 恰好是 2×2 矩形（运气），换成任何拐弯的产线就要靠 LLM
  自己挑「哪几条带子」—— 而它选到的集合一旦非矩形，bbox 就**多删**。这是「LLM 不算坐标」在算术上做不到的部分。
- **修法**：要么加 `$bbox_of` 的 `pad:1` 参数（仍然算数，但算在 loop 侧、可审计），
  要么给 `replace_run` 加 `uids:[...]` 通道（与 `remove_run` 同源，`$uids` 已存在），
  并在契约里承认「非矩形改造必须走 `remove_run + insert_machine` 两宏」。

### 10. `$ref.asCell` 会给 2×1 机器一个**错的 origin**，而契约把它定为唯一可用形态

- **问题**：第 273-275 行：`asCell:true` → `{cell:[handle.x, handle.y]}`，「**只用于** `insert_machine.at`」；
  理由写「`{cell}` 形态会触发反解，2×1 机器恒 `ambiguous_site`（E2E §3.6 V11）」。
- **证据**：
  1. 该理由**已过时**：`place.mjs:492-509` 现在会按「输入槽落点」消歧，`{cell:[4,-13]}` → `ok, origin [4,-13], chosen_by:"input-slot"`
     （`node .tmpverify/rt-phase2-34.mjs`）。E2E-ACCEPTANCE:131 的 V11 结论与当前代码不符。
  2. `asCell` 在真实 L4 上是**错的**：LLM 若选 `(5,-13)` 那条带子，得到 `[5,-13]`，
     `insert_machine` 直接接受为 origin，把 cutter 放在 `(5,-13)(6,-13)`，并**静默删掉 10149**、留下 `output_not_connected` 警告
     （`node .tmpverify/rt-phase2-42.mjs`）。正确的 origin 是 `[4,-13]`。
- **后果**：契约为了「宏不做算术」牺牲了唯一能表达「插在这条带上」的语义，把 2×1 机器的落点变成
  **LLM 猜 origin**（它看不到坐标，只有句柄，猜不出 -1/+1）。这正是它想消灭的那类错误。
- **修法**：`asCell` 改为 `{cell}`（`insert_machine` 已能按输入槽消歧），并把 E2E V11 的引用更新；
  若坚持 `[x,y]` 形态，必须在 loop 侧对 2×1 机器做一次 `origin = cell - [1,0]` 的**显式、可审计**推导。

### 11. R3/R6/R7 与宏层检查重复，但**规则不同** —— 「多一道防线」实际是「多一处必须同步改的真值」

- **重复清单**（逐条对照）：
  | R | 重复了谁 | 判定 |
  |---|---|---|
  | R1 `result.ok===true` | 宏自身 | 无害 |
  | R2 `validateMacroResult` | **宏内部已跑**：connect `:901`、insert_machine `:806`、extend_line `:1193`、remove 的 `okResult` `remove.mjs:279-300`（`okResult` 自己调 `validateMacroResult`） | 纯重复，且 R2 用了 `macro_half_done` 这个码，而契约自己说半成是 `MACRO_HALF_DONE`（大小写不一致，两个码表） |
  | R6 占用检查 | `insert_machine` 自己的占位检查（`place.mjs:518-540`）| **规则不同**：R6 允许「在 destroys 里」，宏不允许 —— 见致命问题 6 |
  | R7 删除 uid ∈ obs | `remove_run` 自己（`remove.mjs:482-483` 报 `endpoint_not_found`）、`trash_unused`（`:1756`） | 重复；且宏给的是 `endpoint_not_found`，loop 给的是 `plan_stale`，**同一个错误两个码** |
  | R10 op 形状 | mod 的 `actionSpecs`（`bridge:2424-2426`） | 重复；`place_path` 也是 tx 合法 op，R10 只列了 place/delete |
  | R9 排序 | **没有测试**（表格里失败码是「—」） | 派生断言，没判据 |
- **后果**：六处「防线」里，两处规则不一致（R6/R7 的码与宏不同），一处无测试（R9），一处大小写撞名（R2）。
  真值从 2 份变 4 份 —— 这个项目已经因为「两份真值」出过至少 3 次事故（契约 §1 自己写的）。
- **修法**：R1/R2 删掉（宏已自证）；R6/R7 只保留「obs 存在性」这一条，并把宏的错误码**原样透传**，
  不要新造 `plan_stale`/`macro_half_done`。

### 12. `FakeGame` 与真 mod 在 `debug_items` 上语义相反 —— mock 绿、live 红，且契约的 `PATHS_TRUNCATED` 修复表因此失效

- **问题**：契约把 FakeGame 当作「离线全链路」环境（T3-01、L5 集成 agent、验收脚本之外的所有自动化）。
- **证据**：
  1. **mod**：`debugItems` 完全**不按 region 过滤 `paths`**，`out.pathCount = paths.length`（全局），
     `paths.slice(0,40)`（`shapez-ai-bridge.js:993-1002`）。
  2. **FakeGame**：`debugItems` 会按 region **过滤 paths**，并令 `pathCount = 过滤后长度`（`fake_game.mjs:148-161`）。
  3. 复现：同一份 L5 数据，全图 region → `pathCount 20`；`region:[2,-16,8,-10]` → **`pathCount 6`**（`node .tmpverify/rt-phase2-41.mjs`）。
- **后果**：
  - 契约 §1.2 与 Q4 的 `PATHS_TRUNCATED` 修复是「**缩 region 重读**」。在 mock 里有效，在真机上**完全无效**
    （缩 region 不会让 `pathCount` 变小）。
  - 反过来，只要真存档的 beltPath 总数 > 40，`checkFlow` 就永久 `undecidable`（`verify_runtime.mjs:627-631`），
    而 `strictVerdict` 规则 6 把 `undecidable` 判红 → **live 永久红**。今天 L5 是 20 条，暂不触发；
    这是**关卡越大越必爆**的定时炸弹，而 mock 永远看不见它。
  - `node .tmpverify/rt-phase2-61.mjs` 用「>40 paths 的真机语义」跑一遍：L2/L3 双 `UNDECIDABLE`，整体 `ok=false`。
- **修法**：FakeGame 的 `debugItems` 必须**完全复刻 mod 语义**（paths 不过滤、pathCount 全局、40 条截断），
  加一条对拍测试；`PATHS_TRUNCATED` 的修复改成「无法修复，只能降级为 info 并靠 L4 行为判」。

---

## 硬事实核实表（逐条给行号与实际代码）

| # | 契约的说法 | 实际 | 判定 |
|---|---|---|---|
| 1 | `verify_runtime.mjs:824` 的 `ok = checks.every(c => c.ok \|\| c.skipped)` 把 skipped 当绿 | 该表达式**确实存在**：HEAD `verify_runtime.mjs:919`；在契约写作时的基线 `ae12a9f` 是 `:850`。**`:824` 处是 `const g0 = { name: "L0-observation" … }`（基线）/ `readGoalDelivered` 里的 `reader.obs(...)`（HEAD），都不是这行**。语义结论成立，**行号错**（且 `f619cca` 之后已漂到 919） | ⚠️ 结论对、行号错 |
| 2 | `connect.resolveEntity` 没有 `pending` 分支（`connect.mjs:279-305`），`insert_machine → connect` 串不起来 | `resolveEntity` 起于 `:279`，末端 `:304` 是 `return { ok:false, code:"bad_type", message:"${field} 形态不认识" }`。**行号准确**。实测 `connect({from: pending})` → `bad_type: from 形态不认识`；而契约层 `validateConnectArgs(pending)` 返回 **ok:true**（`contract.mjs:491-497`）—— 契约说合法、实现说拒绝。`trash_unused` 的 pending 分支在 `remove.mjs:1621`（不是 1613） | ✅ 成立 |
| 3 | `txAllowedOps` 只有 4 个 op，不含 `paste_blueprint` | `shapez-ai-bridge.js:2905` 定义，`:2912` `return new Set(["place","delete","place_path","bulk_delete"])`。**行号准确**。2000 条上限在 `:3258`（契约写 `:3255`，那里是 `ops.length===0` 的检查，差 3 行） | ✅ 成立（副引行号差 3） |
| 4 | `tx.results[i].uid` 按 op 下标给出 | `:3402-3406` `results: appliedResults.map(r => ({index, op, ok, uid, applied}))`，`uid` 取 `r.result.uid ?? r.result.entity_uid`；`opPlace` 返回的是 **`entity_uid`**（`:2621`），`opDelete` 返回的是 `uid`（`:2819`）。所以两者都能取到，**但字段名不统一**，且 `mismatch`/`actual` **不在 results 里**。契约引 `:3427-3433` —— 那里是 `boundaries`，**错 25 行** | ⚠️ 语义对、引用错、且漏了 mismatch |
| 5 | `contract.mjs:1985` 有 `MACRO_NAMES.length === 6` | `contract.mjs:1985` 字面就是 `t("宏名齐全", MACRO_NAMES.length === 6);` | ✅ 完全准确 |
| 6 | `research/ai-plan/live-L4-obs.json` 是 L4 冷启动态（goal=RuRu----，181 实体） | 实测 `goal.requirement.shape = "RuRu----"`、`level:4`、`entity_count:181`、`entities:181`、`truncated:false`；`(4,-13)=belt#10209`、`(5,-13)=belt#10149`、`(4,-14)=belt#10143`。与 `test/fixtures/saves/L4-obs.json` 的实体哈希**完全相同**（`e4ec66e7413e`） | ✅ 准确 |
| 7 | （设计依赖 `FakeGame`） | 它能证明：决策链（handles→$ref→宏→planToTxOps→verify 的调用序列）走通、严格裁决能抓住构造的假绿。<br>**不能**证明：① tx 的原子性/回滚/`results[].uid`/`mismatch`（`FakeGame` 没有 tx，`apply()` 只是内存 splice，`fake_game.mjs:176-221`）；② 产线是否真的跑（`step()` 只加 tick，`production` 恒不变，实测 `before===after`）；③ 宏能否在真存档落盘（rv 被邻居重算这件事 mock 不模拟）；④ `debug_items` 语义（与 mod 相反，见致命问题 12）。<br>**契约把这两者搞混了**：T3-01 说「FakeGame + 真宏 + 真 planToTxOps + 真 verify → 全链路走通」，可它**跳过了 tx**，于是 Q5.4 的 ②③（`tx.results[i].uid` 桥接、obs 读回校验）从未被执行；T5-07 更是明写「FakeGame 里手工改 uid」，但 FakeGame 根本没有 tx 结果可改 | ❌ 混用 |

**附：契约 §0 里两条「补充」的行号也已失效**（`f619cca` 之后）
- 「`L2-slots` … `verify_runtime.mjs:568`」→ 实际 `:582`。
- 「`L4-behavior` … `:714`」→ 实际 `:760`。

**附：契约自己的事实性小错**
- `TICKS_MAX: 24000 // = 200 游戏秒 @120Hz`（第 635 行）：游戏默认 `refreshRate = "60"`（`recon/bundle.pretty.js` 的 `SettingsStorage`），
  且 `DynamicTickrate` 用 `getDesiredFps()` 设 tick 率 → 24000 tick = **400 秒**，不是 200 秒。
  另外 mod 的 `MAX_STEP_TICKS = 20000`（`bridge:78`），**24000 一次性发不进去**（会 2001）。
  `checkBehavior` 的 `2400 // 20 游戏秒 @120Hz` 同样是 40 秒。
- 「每 Round 严格**六**阶段」（第 97 行）后面列了 **7** 个名字（observe→diagnose→propose→plan→apply→verify→repair）。
- `strictVerdict(report) === pass`（第 135 行）：函数返回 `{ok, why}`，没有 `"pass"`。
- 章节号撞车：`## Q5`/`## 5.`（759 行）、`## Q6`/`## 6.`（780）、`## Q7`/`## 7.`（790）各出现两次，
  6 个并行 agent 引用「§5」会指到两个地方。
- 契约有 **Q1–Q8**，没有 Q9（任务书说 9 个）。

---

## 诊断码可判定性抽查（6 个）

| code | 契约触发条件 | 现有数据能否算出来 | 实测 |
|---|---|---|---|
| `PRODUCED_NOT_DELIVERED` | `produced>0.05 && delivered===0`（第 530 行） | **不能**：`checkBehavior` 的 evidence 里没有 `produced`/`delivered` 这两个键，只有 `produced_window_after` / `delivered_in_window_after`。而且 `f619cca` 之后「有产出无交付」已被折叠进 `L4-behavior` 的 `reason` 字符串里，**没有独立 evidence**，只能靠解析文案（契约自己禁止「按 message 分支」） | ❌ 不可判定 |
| `NO_PRODUCTION` | `produced_after===0 && before===0`（第 528 行） | **不能**：字段是 `produced_window_after/before`（`verify_runtime.mjs:791`）。`undefined===0` 恒假 → 该码永不触发 | ❌ 不可判定 |
| `PRODUCTION_UNTRUSTED` | `delivered_slices` 可用片数 <2 或**最后一片被计入**（第 531 行） | **不能**：`checkBehavior` 对 `delivered_slices` 直接 `reduce` 求和（`:779-781`），**没有排除最后一片**，evidence 里也没有「片是否完整」的标记；`production` 返回里只有 `slices_returned`/`slice_seconds`，没有「当前片已过几秒」。这条判据需要的东西 mod 没给 | ❌ 不可判定 |
| `SLOT_STARVED` | `L2.unfed_inputs[]`（第 523 行） | **能**，但只在「一个输入槽都没被喂」时。实测：cutter 被饿死 → `unfed_inputs:["cutter@4,-13"]`（`rt-phase2-17.mjs`）；而 **trash 永不 starved**（4 个 primary 输入全都不是 required）。且它与 `NO_PRODUCTION` 的区分度是真实的（starved 有精确 subject/slot），不是同义码 | ✅ 可判定（范围受限） |
| `FLOW_UNVERIFIED` | `L3.degraded===true`（第 526 行） | **能**，但**纯删除轮永远不会触发它**：`verifyRuntime` 只在 `placements.length>0` 时才调 `debug_items`（`:903-912`），所以纯删除计划里 `items===null` → `checkFlow` 走 `undecidable`（`:624-627`），`degraded` 是 `undefined`。于是「拆→建分两轮」的**第一轮永远是 `L3 undecidable` 红**，永远走不到这条码 | ⚠️ 可判定但选错分支 |
| `RV_UNSTABLE` | `rv_settle` 后仍 `wrong_rv`（第 532 行） | **不能**：`grep -rn "rv_settle" src/` → 0 命中；`repairHints`/`rebind_ok` 同样 0 命中。这条码的**前置修复动作本身不存在**，契约只描述了它的名字 | ❌ 不可判定 |
| （附）`GAME_COERCED` | `tx.results[i].mismatch===true`（第 518 行） | **不能**：results 里没有 `mismatch`（见致命问题 3） | ❌ 不可判定 |
| （附）`UNDECLARED_DESTRUCTION` | `before.byUid − after.byUid − …`（第 522 行） | **不能**：`uidDiff` 不存在（致命问题 4） | ❌ 不可判定 |

**结论：抽查 8 个（含 2 个附加），5 个按字面不可判定。** 「24 个码」里真正能机器判定的是少数
（`OBS_TRUNCATED`/`OBS_STALE`/`PATHS_TRUNCATED`/`SLOT_STARVED`/`LANDING_*`/`TX_UNAVAILABLE`），
其余大量是**把一段 reason 字符串换了个名字**。

---

## 过度设计（该砍的）

1. **`$bbox_of` 的「按 footprint 并集」**：`node .tmpverify/rt-phase2-65.mjs` 证明它对 belt 无用
   （belt footprint 恒 1×1），只在 handle 是机器时才有意义，而 `replace_run.region` 里出现机器就是 `not_a_run`。
   这个算术在它唯一的使用场景里**不产生任何效果**。砍成「handles 的 min/max origin」，省掉 `op-templates` 依赖。
2. **`SAME_FINGERPRINT_MAX: 2` + 「第 2 次必须换动作」+「第 3 次 halt」**：三层规则描述同一件事，
   而 `actionSetHash` 没有任何定义（`TxPlan` typedef 里没有它）。要么写成一条「同 fp 连续 2 次 → halt」，
   要么删除。配合 F7 错误导致的「第一轮必红」，这套指纹会在第 2 轮就误 halt 合法进展。
3. **`ROUNDS_MAX=6`（论证不成立）**：
   - L4 只需 **1 次** `replace_run`（5 个 op，实测 `rt-l4-probe.mjs` 一次全绿）。
   - 用到第 5、6 轮的唯一场景是 **F7 强制的「拆建分两轮」**（第 2 条设计修正）：
     第 1 轮纯删 → 必然 `L3 undecidable` 红（上面已证）→ 第 2 轮建 → 第 3 轮才可能绿。
     也就是说 **2 个轮次是被契约自己的规则烧掉的**，不是任务需要。
   - 按 F7 修正前的设计（一轮 `replace_run`），`ROUNDS_MAX=2` 就够。**6 是把错误前提的成本转嫁成预算**。
4. **`LLM_CALLS_MAX=8` 与 `LLM_CALLS_PER_ROUND=1` 互相否证**：第 511 行说 `LLM_*` 错误可以「重试同一轮（不消耗 round，消耗 call 预算）」，
   而 `LLM_CALLS_PER_ROUND=1` 表示一轮只能问 1 次 —— 那 2 次多余的调用**永远用不出去**。
5. **`LLM_NARRATION`（`say` > 280 字符即拒）**：`say` 是纯展示字段，拒整轮对正确性没有任何帮助，
   反而让「解释得清楚」变成失败原因。改成截断显示。
6. **Q4 `RETRIEVAL_TABLE` 的 `+1 * (该宏在历史里对同 code 成功过)`（第 355 行）**：跨 run 的统计依赖 transcript 目录，
   引入隐式状态、破坏「同输入同输出」，而且它标记为「可选」。v1 删掉。

---

## 遗漏（契约没提但一定撞上的）

1. **`flows` 谁产出、按什么坐标**。见致命问题 7。这是 Stage 2 的**命门空洞**：契约把「L3 必须给 flows」
   当作硬判据，却没定义 flows 的来源，等于把最关键的验证责任悬空。
2. **多次 live 尝试之间怎么复位存档**。§6 判据 3 要求「5 个独立 run、同一 `fixture_hash`」，
   但**每次 live 尝试都会改世界**。契约全程没有 `load_save`、没有备份、没有「restore 到冷启动」的步骤，
   而 `fixture_hash` 在 schema 里**根本没定义**（`grep fixture_hash` 只出现在 Q8-09/Q8-19/§6 判据里）。
   按字面无法执行验收。MEMORY 里「用户存档不是试验场」这条在这里被契约整个漏掉了。
3. **LLM 把参数名写错**（`from` → `source`）。实测 `validateMacroCall` 返回 `unknown_field`（`rt-phase2-33.mjs`），
   而契约把 `validateMacroCall` 的失败归到 `LLM_ARGS`，`LLM_ARGS` 的 candidates 是 `[]` →
   **`candidates` 为空 = 不许喂 LLM = 直接 halt**。最高频的 LLM 错误因此变成「一次就死」。
   需要给 `unknown_field`/`missing_field` 一条「同轮重试 + 把 allowed params 塞回 prompt」的分支。
4. **同一轮里多个宏的依赖排序**。`insert_machine → trash_unused(pending)` 可以在同一轮（契约说了），
   `remove_run → insert_machine` 用的是**同一个未变的 ctx**（实测：`remove_run` 成功后，用同一 ctx 的
   `insert_machine` 仍然看到旧带子，靠它自己「替换 footprint 内带子」才没冲突）。
   但 `connect` 需要拆完的地形，于是「先拆后连」必须跨轮。契约没给规则，只说「must split」。
   实现者会按 R9 的 `deletes → machines → belts` 排序，而这恰好**不支持**「先拆再连」的语义依赖。
5. **Ctrl-C / 进程被杀**。Q1.3 只讲「未捕获异常写 run_end」，没有任何信号处理；
   6.2 有 `world_state:"unknown"` 这个枚举值，但**没有产生它的流程**（也没有 `--resume` 如何判断世界处于中间态）。
   tx 在 mod 侧是原子的，但 loop 可能死在「tx 已发、响应未收」的窗口，此时只有 God 知道状态。
6. **`verifyRuntime` 的 reader 契约**。N-11 `rpc.mjs` 只说 `makeReader(baseUrl)`，没列出需要实现的
   4 个方法（`obs/debugItems/production/step`）及各自的 RPC op 名、参数、失败码。
   这是 L0 与 L3 两个 agent 的第一条接口，必须冻结。
7. **`production` 的 `slices` 语义与 `step` 的配合**：`checkBehavior` 用 `slices:2` 做 before、`slices:6` 做 after，
   然后 `step(2400)`。但 `step` 期间 `productionAnalytics.update()` 是否轮转决定了「after 窗口里有多少是本次跑出来的」——
   `bridge:3639-3655` 的注释说这里踩过坑（40~60 秒产量全压进一片）。契约应明确「L4 必须用 `goal_delivered_delta`，
   或 `step` 前后各取一次 `slices` 并逐片比对」，而不是再吃一遍这个坑。
8. **`editor`/`layers`**：`obs(layer:"all")` 与 `place` 都默认 `regular`，但 L4 存档里有 `underground_belt`（rv=1）。
   `planToTxOps` 的 R10 不给 `layer`，`delete` 默认删 regular —— 删不到隧道层。契约有一处 `$uids` 指向一切实体，
   但 `remove_run` 对隧道是 `not_a_run`（只处理带子）。这条边界没写。

---

## 我认为契约最值得保留的三条（防止全盘否定）

1. **「`verifyRuntime.ok` 不能当成功判据，必须另立 `strictVerdict`」**（F1/F2 + §7）。
   这条我攻击不动 —— 实测确实如此：只加一格带子的计划，`verifyRuntime.ok === true`（L2 skipped + L3 degraded + L4 不请求）。
   而且 `checkFlow` 源码里的那段注释（`:706-717`）就是为这条写的。这是整份契约最有价值的一条。
2. **「LLM 的输入里没有坐标系，只有句柄表」**（Q3.2）。
   `buildHandles` + 「带子：`B7 belt 上游=无 下游=C1.left`」这个描述粒度是对的，而且有可执行的验收
   （prompt 渲染后跑坐标正则必须 0 命中）。即使 `$bbox_of` 不够用，**「prompt 里不出现 x/y/uid」这个不变量本身是对的**，
   应该保留并加强（现在的 S2 卡片里 `machine` 名字是允许的，这是对的）。
3. **「每个坐标都要有 provenance，且 provenance 只有三种来源」**（Q2.1 L-B/L-C + 变异测试
   「把任一个 cell 的 x 加 1，`assertProvenance` 必须红」）。这条判据**能被证伪**，是真防线。
   虽然它依赖的 `$ref`/`$bbox_of` 表达力不足（致命 9/10），但「每条落盘坐标都能追溯到一个 obs 句柄或一个宏返回」
   这个结构性约束应该保留 —— 修法是把算子补齐，不是把溯源砍掉。

---

## 复现命令汇总

```bash
cd "D:/Projects/rea/Project work/shapez"
node .tmpverify/rt-l4-probe.mjs        # L4 上 replace_run 一次全绿（5 op）
node .tmpverify/rt-phase2-66.mjs       # 真实 L5 上 connect 23 种组合成功 / 10 条直达 hub（推翻 F7）
node .tmpverify/rt-phase2-46.mjs       # connect(allow_replace) 不报 destroys → R6 会误拒
node .tmpverify/rt-phase2-55.mjs       # tx.verify===null / produced_delta 不存在 / results 无 mismatch
node .tmpverify/rt-phase2-41.mjs       # FakeGame 的 pathCount 按 region 变，mod 不变
node .tmpverify/rt-phase2-61.mjs       # >40 paths 时 live 永久 undecidable
node .tmpverify/rt-phase2-62.mjs       # flows 的 from==to 恒绿
node .tmpverify/rt-phase2-32.mjs       # L 形 region 撞上 underground_belt → out_of_scope
node .tmpverify/rt-phase2-42.mjs       # $ref.asCell 给 2×1 机器错 origin，静默删带
node .tmpverify/rt-phase2-63.mjs       # 纯删除轮 L3 undecidable（F7 的第一轮永远红）
node .tmpverify/rt-phase2-57.mjs       # DIAG_CODES 块不是合法 JS
```
