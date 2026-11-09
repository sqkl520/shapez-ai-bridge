# 红队：部分执行（partial apply）能不能做

> 2026-11-02。攻击对象：`PARTIAL-APPLY-SEMANTICS.md`。
> **每条结论都有可重跑的脚本**，全在 `.tmpverify/redteam-partial/`（14 个，见文末索引）。
> 样本：`.tmpverify/ab-real/results{,-v2..-v5}.json` 五轮去重 147 条真实存档样本，
> 判据口径与 `multicall.mjs` 完全一致。

---

## 结论一句话

**可以做，但这份设计的三处落点全是错的：判据放错了层、提交语义选错了子集、
而且它声称「不算成功」的那条硬约束会变成一句谣言 —— 照它写会得到一次记录为
`world_state: "untouched"` 的真实写入，加上一轮让模型重发旧计划的 `tx_failed`。**

必须先有「撤销不可逆改动」的能力，或者把提交语义从「全部成功子集」改成
「只有第一条 / 只有前缀」，否则不做。

---

## 先说三个把设计推翻的实测数字

| # | 事实 | 证据 |
|---|---|---|
| 1 | **52.4%（77/147）的真实样本里，成功的那一半是 `trash_unused`，它正好封住一条 `DEAD_END` 带子的出口** | `seal2.mjs` |
| 2 | **trash 一旦落盘不可撤销**：`remove_run` 判 `not_a_run`（只处理带子），`replace_run` 的 region 含机器则整单拒；6 个宏里没有能删机器的（`connect` 系只增不减，`insert_machine` 也只增） | `irreversible.mjs` |
| 3 | **部分执行之后世界诊断指纹 93.9%（107/114）会变** ⇒ `countFingerprint` 的计数键每轮都是新的 ⇒ 溯源保护（`mustChange` / `NO_PROGRESS_3X`）**永久失效** | `reset.mjs` + `stall_sim.mjs` |

第 1 条命中的是**同两条带子**：`uid=10193`（67 次）、`uid=10008`（71 次）。
模型在这批样本上反复要求「把死端接进 hub」，反复失败，于是反复用 trash 把它封死。

---

## Q1：这会不会让 `achieved: true` 变成假绿？

### 判据的真实结构（逐条查过）

`verifyRuntime`（`src/agent/verify_runtime.mjs:1079-1144`）只跑三条落地检查，
入参是 `normalizePlan(plan)` 之后的 `plan.placements` / `plan.removes` / `plan.flows`
（`:1117-1133`）。

**这是关键：`verifyRuntime` 结构上不可能知道「原计划有几个调用」。**
部分执行之后 `plan` 只含成功的那几项 —— L1 验的就是那几项，自然全绿。

实测（`greenpath4.mjs`，103 个「部分执行且子集可翻译成 op」的样本）：

```
L1 绿:       103/103 (100%)
L2 绿:       103/103 (100%)
V-obs-flow 绿: 38/103  (37%)
L1 ∧ L2 ∧ V-obs-flow 全绿: 38/103 (37%)
```

那 38 个样本在 live 下**只差 L4**：`verify_runtime.mjs:963-965` 的
`deliveredHappened = delAfter > 0 || goalDelta > 0 || storedDelta > 0` ——
测的是 hub 有没有在收货，与「计划完不完整」**毫无关系**。

⇒ **唯一能拦住 `achieved` 的，就是新加的那一条 check。没有第二条路。**

### 那条 check 的三种形状，两种是漏的

`strictVerdict` 只按 `name` 取（`verify.mjs:270-271`），`phaseTwoVerdict` 只看
`classifyChecks().trustworthy` 里的 `ok === false`（`offline_boundary.mjs:107-110`），
而 `classifyChecks` 第一句就是 `if (c.skipped) continue;`（`:63`）。

实测（`holes.mjs`，live + goalDelta=5）：

| check 形状 | `strict.ok` | `achieved` |
|---|---|---|
| 全绿（对照） | true | **true** |
| `{name:"P-partial", ok:false}` | true | false ✔ |
| `{name:"P-partial", ok:true}` | true | **true** ✗ |
| `{name:"P-partial", ok:false, skipped:true}` | true | **true** ✗ |
| `{name:"P-partial", ok:false, undecidable:true}` | false | false ✔ |

**`skipped:true` 会让它静默消失。** 这不是假想：本项目所有「有意跳过」的 check 都带
`skipped:true`（`verify_runtime.mjs:656/792/876`），实现者照抄邻居就会踩中。

### 设计把判据放进 `applyVerdict` 会撞上什么

设计文档 `PARTIAL-APPLY-SEMANTICS.md:92-103, 170` 要求「`partial:true` ⇒ `av.ok === false`」。
`applyVerdict` 确实能拦住 `achieved`（A-tx 进 checks，`phaseTwoVerdict` 因
`anyTrustedFail` 判 `none`，实测见 `atx.mjs`），但**代价是 loop 会读错世界**：

```
loop.mjs:2029   const av = applyVerdict(ap.tx, { requestedOps: planned.txPlan.ops.length });
loop.mjs:2054   if (!av.ok) { … settleFailure([TX_ROLLED_BACK], …, "apply");
loop.mjs:2058       st.lastPlanSummary = { …, decision: "tx_failed" };
loop.mjs:2064       st.obs = null; continue; }
loop.mjs:2067   st.worldTouched = true;      ← 走不到
```

后果两个，都能写成断言：

1. **记录说谎**：`loop.mjs:2188 / 2244` 的 `world_state` = `st.worldTouched ? "applied" : "untouched"`
   ⇒ 一次真实写入被记成 `"untouched"`。而 `run_end.world_state` 是验收时判断
   「这一轮到底动没动世界」的唯一字段。
2. **告诉模型「白做了」**：`renderLastRound`（`prompt.mjs:1694`）会渲染 `decision: tx_failed`，
   模型的自然反应是重发同一批调用。实测（`reemit.mjs`）：

```
部分执行轮次: 103
  重发同一批调用：全部失败 93 (90%)   部分失败 4   全部成功（幂等）6
  失败码: {"port_already_bound":165, "endpoint_not_found":2, "occupied":1, "blocked_by_machine":1}
```

   90% 的重发全军覆没，主因 `port_already_bound ×165` —— 因为上一轮的 connect 已经接上了。
   这会把一轮部分执行直接变成一轮零收益 + 一次烧掉的 LLM 调用。

### 一个具体的失败序列（真实样本，`one_case.mjs` 打印）

```
v1:OLD#3
模型原文: Feed the cutter from an active miner, route its output to the hub,
          and send the dead-end waste half to trash.
  #1 connect       {"from":{"uid":10079,"port":"out"},"to":{"uid":10036,"port":"bottom"},
                    "opts":{"allow_replace":true,"prefer":"shortest"}}   → 失败 bad_type
  #2 connect       {"from":{"uid":10030},"to":{"uid":10000}}             → OK
  #3 trash_unused  {"outlet":{"uid":10193}}                              → OK

部分执行提交的 op:
  delete 10032, delete 10074              ← 拆了两条带子
  place trash @(9,-14)                    ← 落一个删不掉的垃圾桶
  place belt ×3 @(0,-3)(-1,-3)(-2,-3)     ← 铺了一条新链

L1: true   L2: true   V-obs-flow: true (1 条 flow)
DEAD_END: [B129, B83] → [B129]            ← 一条症状被 trash 抹掉
世界诊断指纹变了: true
```

模型说的第一件事（「喂 cutter，把它的产出送进 hub」= #1）**从未执行**。
而这一轮在 live 下只要 L4 读到 `goal_delivered_delta > 0` ——
`verify_runtime.mjs:963-965` 三条腿里**任一条**成立即可：窗口内交付 > 0、
`goal_delivered` 增量 > 0、或 hub 累计账本增长 ——
`phaseTwoVerdict` 就会给 `achieved: true`。**除非**那条 `P-partial` 检查真的存在、
且**没有** `skipped`。

⚠️ 这几条腿测的都是「这段时间 hub 有没有进货」，与「这一轮的计划完不完整」无关。
本夹具（`L4-obs.json`，`RuRu----` 70 件、delivered 0）是待改造态，未必已经出货；
但只要该存档上有任何一条其它产线在交货，或 step 窗口跨过关口（`stored_delta > 0`），
这一条就成立。**判据不区分「谁交的货」**。

### 所以 Q1 的回答

- **假绿可以造出来**，且不依赖我的想象：上面那条序列 + `P-partial` 写成 `skipped:true`
  （或写错名字、或根本没写）就是一次 `achieved: true`。
- **判据的落点必须是 `strictVerdict` 的新 check，数据来源必须是 `txPlan.partial`**，
  不能是 `verifyRuntime` 的任何 check（它看不见计划有几项），
  也不该放在 `applyVerdict`（会把 loop 的 apply 分支带进 `TX_ROLLED_BACK`）。
- 还有一条**现状就有**的假绿（与本设计无关，但会被部分执行放大）：
  L4 测的是「hub 有没有在交货」，一轮什么都没做也能绿。部分执行只是让「有东西落盘」
  的轮次从 5/147 涨到 108/147（`alternatives.mjs`），撞上这个洞的机会同比放大。

---

## Q2：跳过的宏留下的半成品，下一轮会不会误判？

### 你举的例子（`remove_run` 成功、`replace_run` 失败）：**会看到，但看到的是「同形的假旧问题」**

实测（`gap.mjs` / `gap3.mjs`）：删掉 161 条带子逐条重跑 `diagnose`：

```
下一轮能看到新问题: 158/161 (98.1%)   → DEAD_END ×352 / CHAIN_UNFED ×325 / BELT_HANDOFF_REJECTED ×258
下一轮完全看不到 :    3/161 ( 1.9%)
```

也就是说「我造成的断口」98% 会被诊断出来 —— 但它是**同一个 code，只换了 subject**
（`code|handle` 指纹键，`loop.mjs:269-278`，不含「谁造成的」）。

⇒ 模型无法区分「这里本来就有个断口」和「我刚才挖的坑」。**而且它不需要区分**：
对 `connect` 来说两者是同一个修法。所以这一条**不是**否决项。

### 真正的问题在反方向：**执行的那一半，把没执行的那一半变成不可修 + 不可见**

这才是 `trash_unused` 的形状（52.4% 的样本）：

| 步骤 | 实测 |
|---|---|
| ① `trash_unused` 落在一条 `DEAD_END` 带子的**出口格** | 77/147 条样本（`seal2.mjs`）；只封 `uid=10193`（67 次）和 `uid=10008`（71 次） |
| ② 垃圾桶删不掉 | `remove_run(uid)`→`not_a_run`；`remove_run(cells)`→`not_a_run`；`replace_run(区域含机器)`→`not_a_run`；`connect(from trash)`→`endpoint_not_a_port`（`irreversible.mjs`） |
| ③ 症状消失 | `DEAD_END` 2→0 或 2→1（`seal2.mjs`、`cap.mjs`） |
| ④ 解法也消失 | 同一条 `connect`（B129→H1）现在报 `occupied: 所有候选路径都被挡住；第一处冲突在 -10,-4（trash uid=…）`（`residue.mjs`） |
| ⑤ 语义层说不出 | 加 trash 前后 `diagnose` 只多一条 `SHAPE_UNKNOWN`，没有任何一条指向「目标形状正被倒进垃圾桶」（`semantic_after_trash.mjs`） |
| ⑥ 同轮还常有失败的 connect/replace_run | 71/147（48.3%） |

⇒ 这一轮之后，「这条带子本该接出去」在下一轮的 prompt 里**同时失去症状和解法**。
不是误判成「原来就有的问题」，而是**误判成「没有问题了」**。

### 第三条：诊断窗口会把原有的问题挤出去

`diagnose` 合并后的上限是每码 3、总量 8（`loop.mjs:886-903`）。
`RANK` 里 `DEAD_END: 9 / CHAIN_UNFED: 10`，而报告层 `LANDING_*: 11 / TX_ROLLED_BACK: 12`（`:829-842`）。

实测（`evict.mjs`）：删 8 条带子 ⇒ 新造出 3 条诊断，**原有的 4 条被挤出窗口**
（`BELT_HANDOFF_REJECTED|B130`、`BELT_HANDOFF_REJECTED|B134`、`DEAD_END|B129`、`CHAIN_UNFED|B131`）。

⇒ 部分执行造成的破坏会把「上一轮真实的落地失败」挤出 prompt，
而那恰好是唯一能提醒模型「你上一轮没做完」的诊断。

### Q2 的回答

会误判，但不是「把断口当成旧问题」，而是「把封死的路当成没有问题」+
「把上一轮的失败挤出窗口」。前者不可逆、后者会让循环失去唯一的负反馈。

---

## Q3：`mustChange` / 指纹计数会被绕开吗？

### 会被**完全**绕开。算给你看。

计数键的构造（`loop.mjs:1587-1593`）：

```js
const fp    = fingerprintOf(diagnoses);          // 世界诊断
const actKey= actionSetHash(st.lastMacros || []); // 上一轮计划的动作集
const key   = `${fp}#${actKey}`;
if (rec.count >= 3) haltReason = "NO_PROGRESS_3X";
else if (rec.count === 2) { mustChange = true; … }
```

`fingerprintOf` 读 `code / layer / subject.handle / evidence.handles / evidence.uids`
（`loop.mjs:269-278`），全都是从 **obs** 推出来的 —— 世界一变它必变。

实测 `fpreset.mjs`：只落一条 trash（`@(-10,-4)`），

```
世界诊断指纹 before: sha256:d812278640ec26…
世界诊断指纹 after : sha256:bfc69ed4c77a0c…
```

`reset.mjs`：114 个「至少一条成功」的样本里，apply 之后 **107 个（93.9%）指纹变了**，
只有 1 个没变（6 个被 `planToTxOps` 拒，无 op）。

`stall_sim.mjs` 按真实键构造模拟 3 轮：

```
=== 现状：世界不变（一条都没落盘）===
  r1: key=F0#∅       count=1 mustChange=false
  r2: key=F0#connect count=1 mustChange=false
  r3: key=F0#connect count=2 mustChange=true     ← 第 3 轮才要求换动作
=== 部分执行：世界每轮都变 ===
  r1: key=F0#∅       count=1 mustChange=false
  r2: key=F1#connect count=1 mustChange=false     ← 免检
  r3: key=F2#connect count=1 mustChange=false     ← 免检
```

### 平均要几轮才 stall

**永不。** 只要每一轮落下至少一条东西，`fp` 每轮都是新的，`count` 恒为 1，
`mustChange` 和 `NO_PROGRESS_3X` 都**永远不会触发**。

`countFingerprint` 自己的注释（`loop.mjs:1574-1575`）说「防刷靠 `ROUNDS_MAX`，不靠指纹」——
但那是在「一轮要么全落盘要么全不落」的前提下写的。部分执行把这个前提拆了：
**现在每一轮都能「落一点」，也就每一轮都能重置计数。**

### `ROUNDS_MAX = 3` 够不够

**拦得住无限续命，拦不住伤害。**

- 硬上限确实存在：`constants.mjs:149` `ROUNDS_MAX: 3`，`budgetStop()` 在轮首判（`loop.mjs:1677-1684`）。
- 实测「同一份计划刷满 3 轮」（`rounds.mjs`，把成功子集落地后重放同一份 calls）：
  第 1 轮改变世界 **107/147**，第 2 轮还继续 **5/147**，第 3 轮还继续 **4/147**。
  所以「同一份计划吃满预算」是少数但确实存在。
- 伤害上界：`irrev_count.mjs` 实测，**78/147（53.1%）** 的「能产出 op」轮次会落不可逆 op
  （`trash ×139`、`cutter ×2`；口径是全部能产出 op 的轮次，含现状本就全绿的 5 条）；
  其中 **63 轮的成功项全部是 `trash_unused` / `insert_machine`** —— 只加不可逆建筑，不接线。
  而 `TX_MAX = 6`（`constants.mjs:151`）⇒ 一次 run 最多 6 批。
  ⇒ **最坏情况：一次 run 往存档里塞 6 个删不掉的垃圾桶，而 `world_state` 记的是 "applied"。**

### Q3 的回答

两条叠加不是「会不会」，是「一定」：部分执行让世界变 ⇒ 指纹变 ⇒ 计数归零，
而计数归零又让「必须换动作」这条唯一的探索约束消失。`ROUNDS_MAX=3` 只是把
无限续命截成 3 轮，代价是「3 轮里每轮都能做一点破坏且不受任何 stall 检查」。

**`SAME_FINGERPRINT_MAX` 这一整套在部分执行打开后会变成死代码。**
`constants.test.mjs:146` 还在断言它等于 2 —— 那条测试会继续绿，但语义已经空了。

---

## Q4：该先做哪一个

### 先看失败发生在哪一层（`where.mjs`）

```
样本 147
  宏层失败（跳过能救）:        139 (94.6%)
  planToTxOps 层拒绝（跳过救不了）: 4 (2.7%)   {resolveRefs:1, R5:3}
  全绿（现状就成功）:           5 (3.4%)
```

⇒ 「跳过失败的调用」确实覆盖了绝大部分失败点。**但 `planToTxOps` 层那 4 条
（R5 同格冲突）跳不过去** —— 它们拒的是整份 op 集合，不是某一个调用。
这也是为什么 `partial` 不该塞进 `planToTxOps`：那个文件里 13 条规则
（R1-R13，`planToTxOps.mjs:604-855`）大多是**集合级**性质，加个 `partial` 参数会让
「哪些规则在跳过模式下还成立」变成 13 个独立问题。

### 四种提交语义的实测对比（`alternatives.mjs`，同一批 147 条）

| 方案 | 提交率 | 含目标动作 | 含不可逆 place |
|---|---|---|---|
| A 全有或全无（现状） | 5/147 (3.4%) | 5 | 4 |
| **B 提交全部成功子集（设计）** | **108/147 (73.5%)** | **46** | **78** |
| C 只提交 #1（第一条调用） | 38/147 (25.9%) | 29 | 11 |
| D 只提交前缀（#1…#k 直到第一个失败） | 35/147 (23.8%) | 26 | 15 |

B 的提交率是 C 的 2.8 倍，但**不可逆 place 是 C 的 7 倍**，而真正的目标动作只多 59%。
收益/风险比 B 明显最差。

### 我的判断

1. **「只让跳过的宏进下一轮诊断」不够 —— 但它本身是对的，只是不构成一个方案。**
   不落盘 ⇒ 执行率仍是 0。它买到的是「模型知道该删哪个调用」，
   而 `alternatives.mjs` 里 D（只提交前缀）的 35/147 恰好就是「删掉尾部失败项」的收益上界。
   **先做这一步，同时它是方案 C/D 的必经前置。**
   一条现成的缺陷：`loop.mjs:1922-1926` 把 `p.diagnosis.hint` **复制给每一个宏**
   （`failures: st.lastMacros.map(m => ({macro: m, code: p.diagnosis.code, hint: p.diagnosis.hint}))`），
   而 `MACRO_REFUSED` 的 `observed` 里已经写了 `[call N/M]`（`loop.mjs:1249-1251`）。
   信息在，但没被结构化出来。

2. **不要直接改 `planToTxOps`。** `partial` 属于 `buildTxPlan`（它才是那个循环
   `loop.mjs:1190-1287` 逐条执行宏、逐条决定要不要丢的地方），
   `planToTxOps` 继续收「一份已经筛过的 executed 列表」并保持「全有或全无」。
   这样 `planToTxOps.test.mjs` 里 20 多条拒绝路径的断言全部不受影响。

3. **提交语义选 C 或 D，不是 B。** 理由就是上表：B 把 78 次不可逆 place 押在
   「模型下一轮能接着做对」上，而实测 `replay_failed.mjs` 告诉我们
   **那半边一条都做不成**：

```
可测的部分执行轮次: 103
  被跳过的全部现在能做成:  0 (0.0%)
  部分能做成:             0 (0.0%)
  一条都做不成:         103 (100.0%)
```

   即：**部分执行从不「把路铺好让下一半做成」**。它和剩下的那半边没有任何协同 ——
   这才是「部分执行」这个名字的幻觉。它只是「各做各的」。

4. **硬前置：先有撤销能力。** 现在没有任何宏能删机器（`irreversible.mjs`）。
   在 `remove_machine`（或 `replace_run` 允许含机器区域的 `confirm_waste` 变体）落地之前，
   **partial 提交必须拒绝任何 `place` 且 `building ∉ {belt, underground_belt}` 的 op**。

---

## 如果要做，我要求加的保护（每条都能写成一条测试）

### P1 —— 判据放在 `strictVerdict`，来源是 `txPlan.partial`

- **测试**：`strictVerdict(report, { …, partial: true })` ⇒ `ok === false`，且 `why` 里点名。
- **测试（反向）**：`verifyRuntime` 对同一份 partial 的 plan 全绿（L1/L2/L3 都 ok），
  `strict.ok` 仍必须是 false —— 证明判据不依赖那三条检查。
- 理由：`verify_runtime.mjs:1117-1133` 的入参只有 `plan.placements/removes`，
  结构上看不见原计划有几项。

### P2 —— fail-closed 的形状

- **测试**：`{name:"P-partial", ok:false, skipped:true}` ⇒ `achieved === false`。
  （现在实测是 `true`，见 `holes.mjs`）
- **测试**：`{name:"P-partial", ok:true}` 出现在 partial 的 report 里 ⇒ `strictVerdict` 抛错或 `ok:false`
  （绿 = 实现 bug，不许静默）。
- 理由：`offline_boundary.mjs:63` 的 `if (c.skipped) continue;`。

### P3 —— 不许走 `applyVerdict`

- **测试**：一次 partial 的轮次跑完后，transcript 里**没有** `TX_ROLLED_BACK` diagnose，
  且 `run_end.preserved.world_state !== "untouched"`。
- 理由：`loop.mjs:2054-2068` + `2188/2244`。当前设计（`PARTIAL-APPLY-SEMANTICS.md:170`）会踩中。

### P4 —— 不可逆 op 白名单

- **测试**：`calls = [connect(ok), trash_unused(ok), connect(fail)]` ⇒ partial 提交**拒绝整轮**
  （退化成全有或全无），transcript 里记 `PARTIAL_IRREVERSIBLE`。
- 理由：`irreversible.mjs` 实测 6 个宏都删不掉 trash；`irrev_count.mjs` 实测 78/147 的
  部分执行轮次含不可逆 op。

### P5 —— `trash_unused` 的落点不得封死任何 `DEAD_END` 出口

- **测试**：拿 `test/fixtures/saves/L4-obs.json`，对 `B129` / `B83` 的出口格调
  `trash_unused`，即使宏返回 ok，partial 提交也必须拒（或把它降级成「必须整轮一起做」）。
- 理由：`seal2.mjs` 77/147（52.4%）。这是最高频、最不可逆、且症状会被抹掉的那一类。

### P6 —— 部分执行必须让计数**涨**，不许让世界变掩盖停滞

- **测试**：连续两轮 partial、动作集相同 ⇒ 第 2 轮 `mustChange === true`；
  第 3 轮 `reason === "NO_PROGRESS_3X"`。
  （现在实测：两轮都是 `count=1`，永不触发，见 `stall_sim.mjs`）
- 实现建议：`countFingerprint` 的键里加第三个维度 `partial ? "P" : "A"`，
  并且 **partial 的轮次不重置计数**（即使 `fp` 变了也对 `prevKey` 的计数 +1）。

### P7 —— 跳过的宏带**各自的** code 与 hint

- **测试**：calls = `[a, b]`，a 失败于 `occupied`、b 失败于 `precondition_failed` ⇒
  `lastPlanSummary.failures[0].code !== failures[1].code`，且两条 `hint` 不同。
- 现状：`loop.mjs:1922-1926` 把同一个诊断的 hint 复制给所有宏。

### P8 —— `improved` 必须是 `false` 而不是 `null`

- **测试**：partial 的 `repair_decide.improved === false`。
- 现状：`loop.mjs:1655` 与 `1932` 恒写 `null`，且**全仓库没有任何读取方**
  （`grep -rn "improved" src/` 只有这两处写入）。
- 理由：`PARTIAL-APPLY-SEMANTICS.md:157` 的硬约束写成 `null` 就等于没约束
  —— 「恒 null」与「不许是 true」在机器上不可区分。

### P9（附带，但与本设计强相关）—— 修 `A-tx` 的名字

- **现状**：`OFFLINE_UNVERIFIABLE` 的键是 `"tx-atomicity"`（`offline_boundary.mjs:40`），
  而真实的 check 名是 `"A-tx"`（`verify.mjs:565`）。所以 `A-tx` 在 mock 下被当成**可信**判据
  （实测 `atx.mjs`）。
- **这是目前拦住「partial ⇒ achieved」的一道防线**（`av.ok:false` ⇒ `phaseTwoVerdict` 判 `none`）。
  它是**名字打错**换来的，不是设计。**在做 P1 之前不要"顺手修"它** —— 修完这条防线就没了，
  而 P1 还没接上。

---

## 我建议的落地顺序（与设计文档的 1-6 步不同）

| 步 | 内容 | 为什么不按原文 |
|---|---|---|
| 0 | 把 `failures` 结构化（P7）+ 明确 `improved`（P8） | 零风险、不动原子性，且是后面所有方案的前置 |
| 1 | 加 `remove_machine`/`remove_trash`（或 `replace_run` 接受机器区域的确认路径） | **硬前置**：没有撤销就不能提交不可逆 op |
| 2 | `strictVerdict` 加 `partial` 判据（P1/P2），先只跑测试、不接 loop | 判据先于行为，且能被单测钉死 |
| 3 | `buildTxPlan` 加 `commitMode: "prefix"`（D 方案） | 提交率 24%、不可逆 15，收益/风险最好 |
| 4 | 计数键加 partial 维度（P6） | 否则 3 轮里没有任何 stall 约束 |
| 5 | 才考虑「全部成功子集」（B 方案），且必须在 P4/P5 之后 | 73.5% 的提交率是用 78 次不可逆写入买的 |

设计文档第 169-171 行的 `planToTxOps` 加 `partial` 参数 —— **建议删掉这一步**，
改成 `buildTxPlan` 的 `commitMode`。理由：`planToTxOps` 的 R5/R6/R7/R13 是集合级判据
（`planToTxOps.mjs:678-855`），在那里加模式会让「13 条规则在跳过模式下分别还成立吗」
变成 13 个独立问题；而 `buildTxPlan` 的执行循环（`loop.mjs:1190-1287`）本来就是
逐条决定「这条要不要」的地方。

---

## 诚实边界

1. 所有数字来自 `L4-obs.json` 这一张存档 + 147 条历史 LLM 输出。换存档（L5 / 真实用户存档）
   比例会变；但「trash 封死出口」「trash 删不掉」「指纹随世界变」这三条是**机制性的**，
   不随存档变。
2. 离线复现用的是「克隆 entities + 直接应用 op」，**没有**模拟真 tx 的原子性与游戏侧的
   rv/code 重算。`L1 100% 绿` 是在我补上模板 code 与 `rotation_variant` 之后得到的
   （见 `greenpath4.mjs`；前两版 `greenpath*.mjs` 因为漏了这两项得到的是 28% 的假红，
   一并留着说明这个坑）。**L3 与 L4 离线不可信**（`offline_boundary.mjs:37-41`），
   所以「38/103 只差 L4」这句的依据是 `V-obs-flow`（`verify.mjs:542-553` 的纯 obs 走法），
   不是 `checkFlow`。
3. `replay_failed.mjs` 的「被跳过的全部做不成」是在**同一轮**内重放得出的。
   模型下一轮会改写参数，那部分收益**没有**被这个数字覆盖 —— 我不能断言它等于 0，
   只能说「这一轮的半成品本身不为下一半铺路」。
4. 我没有跑真机。所有 `tx` 语义相关结论都来自 `src/mod/shapez-ai-bridge.js` 的字段约定
   （`verify.mjs` 文件头已逐条列出）。

---

## 脚本索引（`.tmpverify/redteam-partial/`）

| 脚本 | 回答什么 |
|---|---|
| `percall.mjs` | 逐条宏成功率（37.9%）、部分执行门槛（77.6%）、按 calls 数分组 |
| `more.mjs` | 目标相关宏成功 34.7%，纯清理成功 42.9% |
| `where.mjs` | 94.6% 的失败在宏层，2.7% 在 `planToTxOps` 层 |
| `alternatives.mjs` | A/B/C/D 四种提交语义的提交率与不可逆风险 |
| `probe_upper.mjs` | 「只差一条」的样本只有 11.6%（删掉一条就全绿的上界） |
| `greenpath4.mjs` | 部分执行后 L1 100% / L2 100% / V-obs-flow 37% 绿 |
| `one_case.mjs` | Q1 的具体失败序列（v1:OLD#3，含完整 op 列表） |
| `holes.mjs` | `P-partial` 检查的 4 种形状，2 种失效 |
| `atx.mjs` | `A-tx` 与 `"tx-atomicity"` 名字不匹配 = 现有防线是 bug |
| `seal2.mjs` | 52.4% 的样本里成功的 trash 封死一条 DEAD_END 出口 |
| `residue.mjs` / `irreversible.mjs` | trash 落盘后重试 connect 变 occupied / 6 个宏都删不掉 trash |
| `replay_failed.mjs` | 被跳过的调用在新世界上 100% 仍然失败 |
| `reemit.mjs` | 重发已落盘的调用 90% 全败（`port_already_bound ×165`） |
| `reset.mjs` / `fpreset.mjs` / `stall_sim.mjs` | 指纹 93.9% 会变 ⇒ 计数键每轮重置 ⇒ 永不 stall |
| `rounds.mjs` | 同一份计划第 2/3 轮仍能推进的样本数（5/4） |
| `irrev_count.mjs` | 53.1% 的部分执行轮次含不可逆 place |
| `gap.mjs` / `gap3.mjs` | 删带子造成的断口在下一轮可见（98.1%）/ 隐形（1.9%） |
| `evict.mjs` / `cap.mjs` / `cap2.mjs` | 诊断 8 条上限把**原有的 4 条**挤出窗口 |
| `semantic_after_trash.mjs` | 语义层说不出「目标形状正被倒进垃圾桶」 |
| `beltonly.mjs` | 只提交可逆宏：仍能部分执行 40/103（39%） |
| `churn.mjs` | 句柄重编号不是指纹抖动的主因（0/7） |
