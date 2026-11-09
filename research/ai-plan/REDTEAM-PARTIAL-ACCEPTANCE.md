# 红队验收：方案 E（成功子集 ∩ 产物可撤销）能不能上线

> 2026-11-02。验收对象：`src/agent/loop.mjs` 的 `buildTxPlan(..., {partial:true})`（③b 段，`loop.mjs:1332-1419`）
> + `src/agent/loop/verify.mjs` 的 `PARTIAL_APPLY` 判据（`verify.mjs:385-420`）。
> 所有数字都是**我自己重跑的**，脚本在 `.tmpverify/redteam-accept/`（索引见文末）。
> 我没有修改任何 `src/` 文件。

---

## 结论一句话

**现在不能开。** E 的筛选逻辑本身是对的（实测：partial 轮次 0 次不可逆写入），
但**那个唯一的判据从没接线**：`buildTxPlan` 把 `partial` 放在返回值的**顶层**，
而 `verifyRound` 从 `txPlan.partial` 读（`verify.mjs:628`），`runLoop` 又把
`planned.txPlan` 传进去（`loop.mjs:2230`）—— 实测这条链上 `partial` 恒为 `undefined`。
**只要把 `loop.mjs:2041` 改成传 `{partial:true}`，立刻就是一个 `achieved: true` 的假绿。**

`PARTIAL-APPLY-E2E.md` §「判据层刚接上，没有真机验证」这句是**不准确的**：
不是「没被真机验证过」，是**在代码里根本没接上** —— 单元测试 P9 自己手搓 report 喂
`strictVerdict`，所以 11 条测试全绿也发现不了（详见 Q2）。

---

## Q1：E 真的能消掉那些假绿吗？

### 1a. 你问的那条具体序列（`v1:OLD#3`）—— **挡住了**

用当前实现实测（`.tmpverify/redteam-accept/q1_onecase.mjs`，直接从 `results.json` 读原文，不手搓 calls）：

```
partial=false → MACRO_REFUSED   bad_type: to.port="bottom" 不是合法角色 [call 1/3；其余 #2 connect、#3 trash_unused 也一条 op 都没生成（原子性）]
partial=true  → NO_REVERSIBLE_CALL
                3 个调用里 0 条可撤销（connect:macro_failed, connect:not_translatable, trash_unused:irreversible）
```

提交 op 数 = **0**，世界不动，`DEAD_END: [B129, B83]` 原样保留。
原报告里那条假绿（`place trash @(9,-14)` + 抹掉一条 `DEAD_END`）**不成立**。

### 1b. 但 E 挡不住**同一类**假绿 —— 30 个提交里 14 个「模型的第一件事没做」

口径：178 条样本，`buildTxPlan(..., {partial:true})`，只数 `partial === true` 的轮次（`q1_uid.mjs`）：

```
提交轮次 30
  第一件事（calls[0]）失败的:   14 / 30
  第一件事成功的:               16 / 30
  30/30 都至少有一个调用被跳过（这是 partial 的定义）
```

`v1:OLD#6` 的具体形态（`q4_what.mjs`）：

```
原始 calls=[connect(B83→H1), connect(B130→L7), connect(L7→B131), trash_unused(B129)]
提交 calls=[connect(B83→H1)]
ops: 20 × place:belt @(2,-2)…(9,-14)
skipped=[connect:macro_failed, connect:macro_failed, trash_unused:irreversible]
```

**模型说的四件事只做了第一件。** 这一轮在 live 下只要 hub 在收货（哪怕是别的旧产线），
`phaseTwoVerdict` 就给 `achieved: true` —— **实测见 Q2，是真的**。

### 1c. 「trash 封死 DEAD_END」这个具体机制 —— **确实被消掉了**

`q1_deadend.mjs` / `q4_b142.mjs`：30 个提交里 **0 个**含非带子 place（`place:trash` / `place:cutter` 一次都没有）。
`DEAD_END` 计数在这 30 轮里**全部** 2→1，但逐 uid 查（`q1_uid.mjs`）原因不是抹症状：

```
before: 10008(B129), 10193(B83)
after : 10008 —— 只是 B83 真的被接进 hub 了，B129 的死端原样还在
```

⇒ 这不是「症状消失、问题没解决」，是**真的修好了一半**。这一点 E 做得对。

### Q1 的回答

- 你举的那条序列：**被拒，0 写入，DEAD_END 不变** ✔
- 但「第一条意图从未执行」这个**类别**没被消掉，只是从 88 次不可逆写入缩成「14 次只做了后半段」。
  **能拦住它的只有 `strictVerdict` 的那条判据 —— 而那条判据现在不生效（Q2）。**

---

## Q2：`partial` 会不会被下游误当成成功？

### 2a. 现状：`partial` 根本没有到达判据层（断了两处）

数据流，逐行查过：

| 步 | 位置 | 实际发生 |
|---|---|---|
| ① `buildTxPlan` 返回 | `loop.mjs:1525` | `return { …, partial: partialMode && …, skipped: skippedAll }` —— 在**顶层** |
| ② `runLoop` 收下 | `loop.mjs:2091` | `planned = p` |
| ③ 传给 verifyRound | `loop.mjs:2230` | `txPlan: planned.txPlan` —— **只传了 txPlan，`partial` 留在 `planned` 上** |
| ④ verifyRound 读 | `verify.mjs:628` | `partial: txPlan.partial === true` —— 读的是 **txPlan 上的字段** |
| ⑤ strictVerdict 用 | `verify.mjs:413` | `if (report.partial === true)` |

`planned.txPlan` 是 `planToTxOps` 的返回（`loop.mjs:1505` `{...txPlan, ops: withProv.ops}`），
键只有 `ok, ops, destroys, pendingByOp, placements, removes, flows, warnings, error` ——
**没有 `partial`**。实测（`q2_wiring2.mjs`）：

```
partial(top-level): true
txPlan.partial: undefined   有键? false
txPlan 键: ok,ops,destroys,pendingByOp,placements,removes,flows,warnings,error
```

### 2b. 而且 `runLoop` 压根没打开 `partial`（所以现在还没炸）

`loop.mjs:2041`：

```js
const p = buildTxPlan(parsed.plan, ob.obs, ob.items, st.handles);
```

没有 `opts`。全仓库 `grep buildTxPlan(` 只有测试传过 `{partial:true}`。
端到端跑真 `runLoop`（`q2_runloop.mjs`，一份会产生 partial 的计划）：

```
outcome: halt  reason: BUDGET_ROUNDS  rounds: 3  tx: 0
plan 行: 全 MACRO_REFUSED
apply 行数: 0
world_state: untouched
transcript 里出现字符串 partial: false
```

⇒ **E 目前是一段没有被启用的代码。** 这是好事：还没造成伤害。也是问题：
「实现了」和「能用了」差两处接线 + 一条判据。

### 2c. 具体序列：什么样的 partial 会判成功而实际没达到目的

`.tmpverify/redteam-accept/q2_greenfield2.mjs` —— 我把它跑出来了：

```
计划: [connect(M1→C1) 失败, connect(B83→H1) 成功]
  partial=true，skipped=[connect:macro_failed (port_already_bound)]
  提交 20 × place:belt，子集自身 L1/L2/L3/V-obs-flow 全绿
  live 读取面: hub 在交货（goal_delivered_delta=5，来自本来就存在的旧产线）

A 现状透传（partial 留在顶层，verifyRound 看不到它）
  checks: L0:true L1:true L2:true(skipped) L3:true L4:true V-destruction:true V-obs-flow:true A-tx:true
  strict.ok: true   why: []
  goalDelta: 5
  ★ level: live   achieved: true          ← 假绿

B 若把 partial 挂到 txPlan 上（只改这一个字段）
  strict.ok: false
  why: ["PARTIAL_APPLY：计划没有完整执行，1 个调用被跳过：connect(macro_failed) —— 做成了子集不等于达成了计划"]
  ★ level: none   achieved: false          ← 判据本身是有效的
```

**这条序列里模型说的第一件事（喂 cutter）从未执行，系统判「阶段 2 达成」。**

### 2d. 对照实验：翻转**只**由 `partial` 字段决定

其余一切相同，只改 `txPlan` 上挂什么（`q2_control.mjs`）：

| 变体 | `strict.ok` | `achieved` | `level` |
|---|---|---|---|
| `partial` 字段缺失（**现状透传**） | true | **true** | live |
| `partial: true` | false | false | none |
| `partial: true` 但 `skipped: []` | false | false | none |
| `partial: false` | **true** | **true** | live |

⇒ 这不是「恰好别的检查红了」。**单一个布尔字段决定 `achieved`。**
也说明第 3 行是 fail-closed 的（`partial:true` 但 `skipped` 空也判红），方向正确。

### Q2 的回答

- 会不会被误当成功：**现在不会，因为 `partial` 没接线、也没启用。**
- 但判据是**有效的**（B 分支证明），**只是没接上**。
- **必须先加 `noPartialApply` 的接线（+ 端到端测试）才能启用 `partial`。** 明确说：**这是硬前置。**
- 顺带：`partial_apply.test.mjs` 的 P9（`:176`）**测不到这个**。它自己手搓一份
  `{checks:[全绿], partial:true}` 直接喂 `strictVerdict` —— 那只证明「判据函数会红」，
  不证明「这条判据在真实链路上会被喂到」。**这正是「测试全绿但功能没接线」的典型形态。**

---

## Q3：E 的实现有没有 bug？

### 3a. 单条翻译的 `collectNamedUids([ex], …)` —— 用法对，但与合并翻译**不同源**

`loop.mjs:1381`：

```js
const solo = planToTxOps([ex], { obs: o, items, namedUids: collectNamedUids([ex], o, handles) });
```

单条用**这一条自己的**指名集合，正确。
但 `loop.mjs:1435` 合并翻译时用的是：

```js
const namedUids = collectNamedUids(res.calls, o, handles);   // ★ res.calls = 全部，含被跳过的
```

**被跳过、永远不会执行的调用，能为一笔自己没点名的删除背书。** 实测（`q3_union_final.mjs`）：

```
C0 两个都成功          [connect(B83→H1), replace_run(bbox B81,B82,B69,B70)]
   → R13 拒绝：4 个不在指名里（10143, 10149, 10150, 10209）
C1 多一条**失败的** connect(B70)（就被跳过的那条，点名 10150）
   → R13 拒绝：3 个不在指名里（10143, 10149, 10209）   ← 10150(B70) 被**豁免**了
```

`10150` 是被那条**失败的** `connect` 点名的；它自己一条 op 都不会产生，却让
`replace_run` 删它变得「合法」。这正是 R13（`planToTxOps.mjs:826-846`）存在的理由：
「宏会成功，但删掉 LLM 从未指名的东西」。

原子模式下这个洞不存在 —— 第一条失败就整轮拒绝，`res.calls` 的并集永远用不上。
**这个洞是 `partial` 引入的新路径。**

在 178 条样本上它**还没有实际发生**（`q3_r13.mjs`：`{commits: 30, onlyBecauseOfSkipped: 0}`），
所以是**潜在洞**，不是正在被利用的洞。但它必须堵 —— 修法一行：
合并翻译改用 `collectNamedUids(executed, …)`，而不是 `res.calls`。

### 3b. 「place belt + place 机器」混合 —— `every` 判不可撤销，是**fail-closed，正确**

`loop.mjs:1383-1384` 是 `ops.every(...)`，混合产物整条被跳过。方向保守，没有安全问题；
代价是「一条 replace_run 里 9 格带 + 1 台机器」会被整条丢掉（放弃了可逆的那 9 格）。
这是**收益损失**，不是 bug。

### 3c. `skipped` 的顺序：重排了，但不影响 `namedUids`

`loop.mjs:1371-1373`：`skippedAll` 先放**宏失败**的（按调用顺序），
`loop.mjs:1393` 再把**不可撤销**的 append 上去 —— 所以顺序**不是**原始调用顺序。

`namedUids` 不读 `skipped`（它读 `res.calls`），所以**没有功能影响**。
但有两个真实后果：

1. **下游分不清是哪一条。** `skipped` 条目的字段实测是 `["macro","reason","code","hint"]`（`q1_detail.mjs`），
   **没有 `index`**。同一份计划里两条 `connect` 一败一成时，`skipped[0]` 说的是哪一条，
   机器无法回答。`MACRO_REFUSED` 的 `evidence.call_index` 是有的（`loop.mjs:1312`），这里丢了。
2. **`NO_REVERSIBLE_CALL` 的 hint 挂不上。** 见 3e。

### 3d. 「两条单独不可撤销，合起来可撤销」—— **不存在**

判据是逐 op 的 `every`。任一条调用的产物里有 `place:机器`，并集里就有
`place:机器`，`every` 恒 false。没有任何宏能删机器（`remove_run` 只处理带子），
所以并集不会「抵消」掉它。实测（`q3_cases.mjs`）：

```
[remove_run(B83) ok, insert_machine(cutter) ok, connect ok]
  → skipped=[connect:macro_failed, insert_machine:irreversible]
  → 提交 ops: delete:10193        （机器那条被丢掉，不是被合并掉）
```

### 3e. ★ 一个真 bug：`NO_REVERSIBLE_CALL` 让模型看到「什么都没发生」

`loop.mjs:1409-1417` 的 `NO_REVERSIBLE_CALL` 的 `evidence` **没有 `call_index`**，
而 plan-rejected 分支（`loop.mjs:2069-2077`）用它决定「给哪个宏挂 hint」：

```js
const failIdx = typeof ev.call_index === "number" ? ev.call_index : -1;
```

没有 ⇒ `failIdx = -1` ⇒ **每一个宏**都被标成 `code: "unverified"`。实测（`q3_feedback.mjs`）：

```
诊断: NO_REVERSIBLE_CALL
evidence: {handles:[], uids:[], skipped:[{connect:macro_failed, port_already_bound}, {trash_unused:irreversible}]}
hint: 「这些调用只能放机器/垃圾桶，没有一条能靠 remove_run 撤销。换一条只涉及带子的修法…」

→ 模型下一轮看到的 LAST ROUND:
  · connect       → not reached (an earlier call failed first)
  · trash_unused  → not reached (an earlier call failed first)
```

**`connect` 其实失败了（`port_already_bound`，带 hint 的），`trash_unused` 其实成功了但不可撤销。
模型看到的是「两个都没轮到」。** 而这条路径吃掉 **128/178 = 71.9%** 的样本（`q4_eval.mjs`）。

这是把刚从 `MACRO_REFUSED` 修好的那个 bug（`9b2ef5b`，「failures 把同一个 hint 复制给了每个宏」）
**在 `NO_REVERSIBLE_CALL` 上又犯了一次**，只是换成了另一种错法：不是复制 hint，是全部抹成 `unverified`。

### 3f. 其它实测确认

- **`delete` 会不会删到非带子**：全 178 样本里提交的 `delete` 共 3 条，非带子 **0** 条（`q3_cases.mjs`）。
  `delete` 一律判可撤销，而当前所有删除都来自带子 —— 成立，但**是靠宏的能力，不是靠判据**。
- **`not_translatable` 到底为什么**：5 条，原因**全部**是 `R13:PLAN_REJECTED`
  （单条翻译时它自己点名的集合不足以覆盖它要删的东西）（`q3_nt.mjs`）。不是「翻译器坏了」。
- **reversible 列表的顺序**：`executed.length = 0; push(...reversible)` 是**原顺序的子序列**，守恒（`loop.mjs:1396-1398`）。

---

## Q4：E 在真实样本上的表现（自己重算）

### 4a. 你的数字**复现不出来**

`node .tmpverify/redteam-partial/reversible.mjs` 我跑了，输出与你贴的一致（177 条，E 提交 54 / 30.5%）。
但那是**脚本口径**，不是**实现口径**。列出差异（`q4_gap.mjs`）：

```
N = 178
  脚本 E（不传 namedUids）                 : 54
  脚本 E（补上 namedUids）                 : 27
  ★ 实现 buildTxPlan(...,{partial:true})   : 30 个 partial + 1 个全成功 = 31 (17.4%)
```

两个方向的偏差同时存在：

| 差异 | 方向 | 影响 |
|---|---|---|
| 脚本翻译时**不传** `namedUids` | 脚本更宽 | 9 条本会被 R13 拒的样本算成了「可提交」 |
| 实现**合并**时用 `res.calls`（含被跳过的） | 实现更宽 | 单条判据严格、合并判据松，两边不同源 |
| 脚本用 `resolveRefs` 后的 calls；实现先过 `validateMacroCall` | 实现更严 | `LLM_ARGS` ×5、`LLM_COORD` ×1 |

⇒ **`loop.mjs:1349` 的注释里写的「E 提交 30.5% 目标动作 54」，不是这个实现的行为。**
实现是 **17.4%（31/178）**，其中 30 个 `partial:true`。注释与代码对不上，得改。

### 4b. 你没算的那个指标：E 提交的东西跑完 verify 有多少 L1/L2 绿

`q4_eval.mjs`，对 30 个 `partial:true` 的提交，用 `txPlan.ops` 建 after 世界，跑真 `checkLanding` / `checkSlots` / `obsReach`：

```
L1 绿:                    30 / 30  (100.0%)
L2 绿:                    30 / 30  (100.0%)
L1 ∧ L2 绿:               30 / 30  (100.0%)
V-obs-flow 绿:            30 / 30  (100.0%)
L1 ∧ L2 ∧ V-obs-flow 全绿: 30 / 30  (100.0%)
```

**100% 全绿。** 这有两个读法，必须同时说：

- 好的一面：E 交出去的东西**不是垃圾**，它真的落地、槽位真的通、货流真的走。
- **坏的一面：这就是 Q2 的燃料。** 子集 100% 绿 ⇒ `strictVerdict` 除了 `PARTIAL_APPLY` 一条之外
  **没有任何东西会红** ⇒ 判据一旦没接线，`achieved: true` 是必然，不是偶然。

（离线口径边界：L3/L4 在 mock 下不可信；这里的 `V-obs-flow` 是 `verify.mjs:579-590` 的纯 obs 走法，
不是 `checkFlow`。与你原报告 §Q1 的口径一致。）

### 4c. 额外发现：E 的 30 个提交里，**只有 2 种不同的 op 序列**

`q4_dupes.mjs`：

```
E 的提交轮次: 30
不同的 op 序列：2 种
  1fda4aae… ×29
  6f4fe3a9… ×1
```

29 次是**同一条** `connect(B83 → H1)` 铺出的同一串 20 格带子（`(2,-2)…(9,-14)`）。
⇒ 「提交率 17.4%」这个数字的**动作多样性接近 1**。它衡量的是「这份存档上有一条带子能被救」，
不是「模型在这批样本上执行能力强」。把它当执行率读会高估很多。

### 4d. 附带核实：`partial` 是 A 的超集吗

子集抽查（`q4_regress2.mjs`，前 20 条）：`A ok=0, E ok=1, regress=0` —— 没有出现
「原子能成功而 partial 反而拒」。逻辑上也应当成立（partial 只是放宽宏失败），但要注意一个反例形态：
`NO_REVERSIBLE_CALL` 是在**宏全失败**时给出的，与 `MACRO_REFUSED` 同义，不算回归。

### 4e. ★「不可逆 1 次」那一条是**绕过了** E 的判据的

`PARTIAL-APPLY-E2E.md` 写 `partial:true` 下「不可逆 place 1」。我查了它是谁（`q4_irrev1.mjs`）：

```
v1:NEW#3   partial=false
  calls=[replace_run]   skipped=[]
  不可逆 op: cutter,trash
  ⇒ 这一轮走没走 E 的判据: ★ 没走（executed === calls，③b 整段不执行）
```

⇒ **它就是 L4 的唯一已知正解**（`replace_run → cutter + trash`），单条全成功 ⇒
`executed.length === res.calls.length` ⇒ `loop.mjs:1374` 的 `if` 不成立 ⇒ **可撤销判据整段跳过**。

结论不变（那一条本来就该提交），但表述必须精确：
**「E 保证 0 不可逆」只在 `partial === true` 的轮次上成立**（30/30 实测 0）。
`partial:false` 的轮次不受这个保证约束 —— 这也是为什么 P1 那条测试很重要。

### 4f. 13 条 `PLAN_REJECTED` 的规则分布（作者文档写「R5 同格冲突等」）

`q4_rules.mjs`：

```
{"R5": 4, "R13": 9}
  R5 : 同一格 (0,-3) 被两个 place 命中：belt@(0,-3) 与 belt@(0,-3)
  R13: 计划要删除 1 个实体，其中 1 个不在 LLM 指名的句柄里：10074@(-2,-3)
  R13: 计划要删除 14 个实体，其中 14 个不在 LLM 指名的句柄里：10002@(-10,3)…
```

13 条里 **9 条是 R13**（删了没点名东西），不是 R5。R13 类拒绝在原子模式下同样会发生，
所以不是回归；但它说明 `partial` 的大部分「拒绝」其实来自**计划本身不安全**，
与「能不能撤销」无关。


---

## 必须加的保护（每条都能写成一条测试）

### P0 —— ★★★ `partial` 必须真正到达 `strictVerdict`（否则一切免谈）

- **测试（端到端，不是单测）**：`runLoop` 跑一份 `[connect(必败), connect(可行)]` 的计划，
  `budget:{ROUNDS_MAX:1}`，live 读取面 `goal_delivered_delta>0` ⇒
  `run_end.verdict.achieved === false`，且 `transcript` 里有一行 `why` 含 `PARTIAL_APPLY`。
  **现在实测：这段跑不到 partial（`loop.mjs:2041` 没传 opts），一旦传上就是 `achieved:true`。**
- **测试（反向，防「测试造假」）**：把 `verifyRound` 的 `txPlan` 参数换成 `{...planned.txPlan, partial: undefined}`
  ⇒ 断言 `achieved === true`。**这条断言证明「判据是靠那个字段在起作用」，而不是靠别的什么恰好拦住。**
- 修法：`loop.mjs:2041` 传 `{partial:true}`；`loop.mjs:1505` 或 `2230` 把 `partial` / `skipped`
  挂到 `txPlan`（或给 `verifyRound` 加参数）。
- 理由：`q2_greenfield2.mjs` 的 A 分支，实测 `achieved: true`。

### P1 —— 只有「部分执行」的轮次才不许判成功；`partial:false` 必须放行

- **测试**：同上但计划全部成功（如单条 `insert_machine`）⇒ `partial === false`、`achieved` 不受 `PARTIAL_APPLY` 影响。
  **现状已满足**（`q3_cases.mjs`：单条 `insert_machine` → `partial=false`，提交 `place:cutter`），
  这条测试是**防回归**，防止有人把 `partial` 写成 `partialMode` 而不是 `partialMode && skipped.length>0`。

### P2 —— `NO_REVERSIBLE_CALL` 必须带 `call_index`（或每条 skipped 带 `index`）

- **测试**：`calls = [connect(必败), trash_unused(成功但不可撤销)]` ⇒
  `lastPlanSummary.failures[0].code === "macro_failed"` / `failures[1].code === "irreversible"`，
  且两条 `hint` 都不是 `null`。
- **现状实测（`q3_feedback.mjs`）：两条都是 `unverified`，hint 都是 null。** 71.9%（128/178）的样本走这条路径。
- 修法：`loop.mjs:1371-1373` / `1387-1392` 的 `skipped` 记录里加 `index: i`，
  `NO_REVERSIBLE_CALL` 的 `evidence` 加 `call_index`（或让 plan-rejected 分支优先读 `evidence.skipped`）。

### P3 —— 合并翻译的 `namedUids` 不得包含被跳过的调用

- **测试**：`calls = [connect(必败, 点名 B70), replace_run($bbox_of B81,B82,B69,B70 → belt)]`
  ⇒ `ok === false`，诊断 `PLAN_REJECTED`，`evidence.extra` 含 `10150`。
- **现状实测（`q3_union_final.mjs`）：C1 的未指名集合比 C0 少一个 10150 —— 被跳过的调用豁免了它。**
- 修法：`loop.mjs:1435` 改成 `collectNamedUids(executed, o, handles)`。
- 注意：改完**不要让 `partial_apply.test.mjs` 的 P3/P5 变红**（它们用的是 connect，指名齐全）。

### P4 —— `skipped` 的每条必须能定位到「第几个调用」

- **测试**：`calls = [connect(A) 成功, connect(B) 失败]`（两条同名宏）⇒ `skipped[0].index === 1`。
- **现状实测：`skipped` 字段是 `["macro","reason","code","hint"]`，没有 `index`。**
- 理由：同名宏是常态（`v1:OLD#6` 里 3 条 `connect`）。

### P5 —— partial 的轮次必须真的参与 stall 计数

- **测试**：连续两轮 partial、动作集相同 ⇒ 第 2 轮 `mustChange === true`；第 3 轮 `reason === "NO_PROGRESS_3X"`。
- **现状**：`countFingerprint`（`loop.mjs:1736-1742`）的键是 `${fp}#${actKey}`，`fp` 从 obs 推，
  而 partial 每轮都改世界 ⇒ `fp` 每轮都新（`q4_b142.mjs` 实测：`sha256:d812278640ec2 → sha256:82eae2c47fd91`，变了）
  ⇒ `count` 恒 1 ⇒ **`mustChange` / `NO_PROGRESS_3X` 永不触发。**
  这与你原报告 §Q3 的结论一致，**这次实现没有修它**。
- 修法：键里加 `partial ? "P" : "A"`，且 partial 轮次对 `prevKey` 的计数 +1（不因为 `fp` 变而重置）。

### P6 —— `run_end` 必须能读出「这一轮是部分执行」

- **测试**：一次 partial 的 run ⇒ `run_end.preserved.world_state === "applied"` **且**
  `run_end.partial === true`（或 `verdict.why` 含 `PARTIAL_APPLY`）—— 验收时能一眼看出来。
- **现状实测（`q2_runloop.mjs`）：transcript 里连字符串 `partial` 都不出现。**
- 理由：`world_state` 只有 `applied / rolled_back / untouched`（`loop.mjs:2339`），
  「部分执行」和「完全执行」在这里**不可区分**。

### P7（文档）—— `loop.mjs:1349` 的注释数字要改

- 注释写「E 提交 30.5% / 目标动作 54」，实现是 **17.4%（31/178）**。
- **测试**：不可能写成断言。改成「脚本口径（不传 namedUids）：30.5%；实现口径：17.4% —— 两者不是一回事」。
- 理由：一个和代码对不上的数字，下一个读代码的人会拿它当基线。

---

## 能不能现在就打开 `partial:true`？

**不能。** 按顺序：

| # | 前置 | 为什么是硬前置 |
|---|---|---|
| 1 | **P0**（`partial` 接线 + 端到端测试） | 不接就等于用一个 `achieved: true` 的假绿换 17.4% 的执行率。**这一条不做，其它都白做。** |
| 2 | **P1**（`partial:false` 放行） | 防止把「全成功」也误判成部分执行；`partial_apply.test.mjs` P6 已覆盖一半 |
| 3 | **P2 / P4**（`skipped` 带 index） | 71.9% 的轮次走 `NO_REVERSIBLE_CALL`，模型现在看到的是「两个都没轮到」 |
| 4 | **P3**（namedUids 用 executed） | 安全洞，虽然 178 条里还没触发 |
| 5 | **P5 / P6**（stall + 可观测） | 可以在 P0~P4 之后、打开之前补；P6 是验收期的可读性 |

**P0 + P1 做完，E 就可以在 mock 下打开跑；P2 + P3 做完才建议上 live。**

一个更省事的替代路径（如果只想先拿收益）：**先只开 `partial` 的「skip 失败宏」语义，
但保留 `place 机器/垃圾桶` 的整轮拒绝**（即 `NO_REVERSIBLE_CALL` 时不退化，而是整轮拒），
这样即使 P0 判据没接上，能落盘的也只有可撤销产物 —— 但**这不等于可以不做 P0**，
因为 `achieved: true` 仍然会说出来（只是说「一部分成功」，而不是「达成」）。

---

## 与你原报告的关系（哪些结论变了）

| 原报告结论 | 现在的状态 |
|---|---|
| 「方案 B 有 88 次不可逆写入」 | **成立**，E 把它降到 **0**（partial 30 轮实测 0 次非带子 place） |
| 「必须先有撤销能力才能提交不可逆 op」 | 被 E 绕开了：不提交不可逆 op，就不需要撤销能力。**这个设计选择是对的。** |
| 「判据必须在 `strictVerdict`，数据源是 `txPlan.partial`」 | **判据写对了，数据源没接上。** 这正是 P0 |
| 「`partial` 会绕开 `mustChange` / `NO_PROGRESS_3X`」 | **仍然成立**，未修（P5） |
| 「`applyVerdict` 那条路会写错 `world_state`」 | **没踩中**：`partial` 不在 `applyVerdict` 上。`world_state` 仍正确记 `applied`；问题是缺一个「部分」字段（P6） |
| 「`failures` 把同一个 hint 复制给每个宏」 | `MACRO_REFUSED` 已修（`9b2ef5b`）；**`NO_REVERSIBLE_CALL` 又犯了一次**（P2） |
| 「方案 C/D 的提交率 24~27%」 | 那个数字是脚本口径；实现口径下 A 只有 **0.6%（1/178）**、E 是 **17.4%（31/178）** |

---

## 诚实边界

1. 178 条样本全部来自 `test/fixtures/saves/L4-obs.json` 一张存档 + 六轮历史 LLM 输出。
   换存档（L5 / 真实存档）比例会变；「E 的 30 个提交只有 2 种 op 序列」是这张存档的特性，不是普遍规律。
2. Q4 的 L1/L2/V-obs-flow 100% 绿是**离线重建世界**（`txPlan.ops` 直接改实体表）。
   真机上 `place` 的 `code` 由游戏重算，可能与我给的 `1+rv` 不同；L3/L4 离线不可信。
3. 我没有跑真机，也没碰用户存档。
4. `q2_greenfield2.mjs` 的 live 读取面是我**伪造**的（`delivered` / `stored` 每步 +5）。
   它证明的是「只要 hub 在交货，`phaseTwoVerdict` 就会给 `achieved`」—— **这个条件在真实存档上是否成立，
   不由这个脚本回答**。原报告 §Q1 已经论证过：`verify_runtime.mjs:963-965` 三条腿任一条成立即可，
   且不区分「谁交的货」。本夹具（`L4-obs.json`，delivered 0）本身是待改造态。
5. 所有实验都是只读的；`.tmpverify/redteam-accept/` 是新建目录，没有改任何 `src/` 文件。

---

## 脚本索引（`.tmpverify/redteam-accept/`）

| 脚本 | 回答什么 |
|---|---|
| `q1_onecase.mjs` | Q1：`v1:OLD#3` 在 partial 下实测（→ `NO_REVERSIBLE_CALL`，0 op） |
| `q1_uid.mjs` | Q1：30 个提交里第一件事失败的 14 个；DEAD_END 按 **uid** 比 |
| `q1_deadend.mjs` / `q1_dead2.mjs` / `q1_detail.mjs` | Q1：DEAD_END 2→1 是真修好还是抹症状 |
| `q2_wiring.mjs` / `q2_wiring2.mjs` | Q2：`partial` 在哪一层、`txPlan` 上有没有 |
| `q2_chain.mjs` | Q2：`verifyRound` 收 `planned.txPlan` 时 `PARTIAL_APPLY` 不出现 |
| `q2_greenfield.mjs` / **`q2_greenfield2.mjs`** | Q2 ★★：`achieved: true` 的完整假绿复现 + 修好后变 false |
| **`q2_control.mjs`** | Q2 ★★：四点对照，证明 `achieved` 的翻转**只**由 `partial` 字段决定 |
| `q2_runloop.mjs` | Q2：真 `runLoop` 根本没开 partial（transcript 无 `partial`） |
| `q3_solo.mjs` / `q3_solo2.mjs` | Q3：单条翻译与合并翻译的差异 |
| `q3_cases.mjs` | Q3：全成功轮次可提交不可逆 / delete 是否只删带子 / not_translatable 分布 |
| `q3_mixed.mjs` | Q3：混合产物、`skipped` 无 index |
| `q3_union_final.mjs` | Q3 ★：被跳过的调用为删除背书（C0 vs C1） |
| `q3_feedback.mjs` | Q3 ★：`NO_REVERSIBLE_CALL` 让所有宏显示 `unverified` |
| `q3_golden.mjs` | Q3：L4 唯一已知正解在 partial 下仍能提交（非回归） |
| `q4_eval.mjs` | Q4：实现口径的提交率 + **L1/L2/V-obs-flow 100% 绿** |
| `q4_gap.mjs` | Q4：脚本口径 54 vs 实现口径 30 的差异来源 |
| `q4_dupes.mjs` | Q4：30 个提交只有 2 种 op 序列 |
| `q4_regress2.mjs` | Q4：partial 不回归（抽查 20 条） |
| `q4_irrev1.mjs` | Q4：`partial:true` 下「不可逆 1」是谁（= `partial:false`，绕过了判据） |
| `q4_rules.mjs` | Q4：13 条 `PLAN_REJECTED` 的规则分布（R5×4 / R13×9） |
| `q4_b142.mjs` | Q1/Q4：E 的那条 connect 到底改了什么（指纹变了） |
