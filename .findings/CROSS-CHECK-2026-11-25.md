# 交叉质疑 —— 六份报告互相核对，谁的数字对

2026-11-25。交叉质疑 Agent。**全程离线**：只读 `src/`、`research/ai-plan/runs/`、`.findings/`。
没连游戏，没改 `src/`，没 `git stash/commit/push/checkout/reset`，没读 `ANTHROPIC_BASE_URL`。
临时脚本在 `.tmp-cross/`（收工删除）。

**方法**：独立重跑，不引用任何报告的数字。
- 干净副本 1：`git archive 3967aa5` 解到 `.tmp-cross/src/`（红队 / PLAN F7 的基线 = `3967aa5`）。
- 干净副本 2：`.tmp-cross/srcp/`（同一份 + 把 `LIMITS` 抬到 999/999，用来做「剔 WF 后重新 cap」）。
- 干净副本 3：`.tmp-cross/head/src/`（HEAD 删除 WF 之后的代码）。
- **会话期间 HEAD 又前进了 3 个 commit**（`dca5ae0` / `50e27b9` / `3bfe6b4`），
  所以最后一份复算用工作区当前 `src/`（`.tmp-cross/cur/`）。**三份代码分别测**，不混。

> ⚠️ 一个必须先说的装置事实：**同一个 `diagnose()` + `buildPrompt()`，换预算就换结论。**
> 本报告里所有数字都标了 `(recipe, budget, items/prod/onBelts)` 三元组。
> 报告里没写装置的数字，我无法精确复现 —— 只能反推出「它大概用了哪一档」。

---

## 一、我独立复算的数字（不引用任何报告）

跑的是 `research/ai-plan/runs/` 的 572 个有 `obs+items+production` 的 run（573 个目录里 572 个三件套齐全）。

| 量 | 我的值 | 谁报过 | 差异原因 |
|---|---|---|---|
| 零产出快照（`produced_total` 全零/空） | **522** | 红队 516、EXISTENCE 380、REGRESSION 520、红队复测 519 | 分母不同：红队要 `dt>=10` 判据才叫「触发 WF」；EXISTENCE 用「`dt` 从 transcript 重建 + rank=8 形态」；我用「`produced_total` 空」本身 |
| WF 触发（`dt` 取自 transcript 最后两次 observe） | **381**（L9:9 / L12:372） | EXISTENCE 380（L9:9/L12:371）、红队 516 | 我多 1 个 `r-20261124090316-0c8d`（EXISTENCE 归档时它还没落盘）；红队用 567 快照 + 不同 `dt` |
| WF 触发（`dt=40` 常数，FIX-TRUNCATED 口径） | **521** | FIX-TRUNCATED 516、红队 516 | 分母 567/572/573 的差别 + 我用全部零产出快照 |
| WF 的「最堵」在截断时低估（`shown=40`，隐藏 path 货量 > 可见最大） | **7/11**（`dt` 取自 transcript）/ **10/17**（`dt=40`） | 红队 10/17、FIX-TRUNCATED 10/17 | **同一件事，两套分母**：40 隐 7，`dt=40` 隐 10。两个数都对，量的是不同的 11 vs 17 个 run |
| 截断快照（`truncatedPaths===true`） | **44**（`pathCount>paths.length` 也恰好 44，**零差异**） | FIX-TRUNCATED 44；红队 523 非截断 | 一致 |
| 截断 + 零产出 | **17** | FIX-TRUNCATED 17；红队 17 | 一致 |
| `PATHS_TRUNCATED` 进 `diagnose()` 输出（transcript `diagnose.codes` 或 `diagnose.diagnoses[].code`） | **17/17**（`diagnose.data.diagnoses` 对象里也有）/ **5/17**（`plan-last.verify.codes`）/ **17/17**（渲染进 prompt） | 红队「0/17」；FIX-TRUNCATED「进了 codes」 | **红队读错了载体**：它读的不是 `transcript diagnose.codes`；见矛盾 2 |
| WF 挤掉 HUB stored：剔 WF 前/后（真 cap 前剔） | **lost 7 / gained 4**（521 群体，faithful 参数） | PLAN **305/519**；红队 6→3；EXISTENCE 8/380 | 见矛盾 1 —— **装置（items/prod/onBelts）+ 群体 + cap 时机**三者不同 |
| WF 挤掉 `## CAPACITY`：剔 WF 前/后 | **lost 1 / gained 25**（381，recipe=真）；**lost 0 / gained 0**（521，4600 预算）；**lost 6 / gained 6**（381，4600）；**lost 0/0**（7000）| PLAN **0/519**；红队 **66/516** 后改 **8/20**；EXISTENCE **34/380** | 全部是「净换向」被误读成「单向挤出」；见矛盾 1 |
| CAPACITY 在 HEAD（删 WF 后）缺失 | **93/381**（全是 L12，全部是 `room<120` 外层闸 | — | **这才是真问题**，见矛盾 3 |
| `renderCapacity` 的短版保底在零产出路径上是否可达 | **0/381 次走了 short**（`form` 调用计数 = `{full:288}`） | — | **死代码**，见矛盾 3 |
| 三种「满载」判据给出的「最堵」 | items 最大 / fill≥0.85 / 旧公式 fill 各不相同（见语义漂移表） | — | 语义漂移，见下 |
| WF 与 `NO_PRODUCTION` 同现 | **381/381 = 100%** | EXISTENCE 380/380 = 100% | 一致 |
| 相邻重算事故三格 diff（`8b63`→`264d`） | **恰好 3 格**：`14953 rv2→0`、`15019 rv0→2`、`15021 belt→trash` | CRITIQUE / ROOTCAUSE 逐格同 | 一致（我独立 diff obs 复现） |

---

## 二、矛盾裁决

### 矛盾 1：`## CAPACITY` 到底会不会被挤掉？（四个数字：0 / 34 / 66 / 8）

**我的数字**：在 `3967aa5` 的干净副本上，用**真 `diagnose()` + 真 `buildPrompt()`**，
在 381 个「真 `dt` ≤ 10 秒也会触发 WF」的快照上，剔 WF 前 / 后各算一遍：

| 装置 | CAPACITY 丢（A有→B无） | CAPACITY 得（A无→B有） | net |
|---|---|---|---|
| recipe=真, 5300 tokens, 24000 chars, items+prod+onBelts | **1** | **25** | B 比 A 多 24 |
| recipe=null, 同上 | 1 | 25 | B 多 24 |
| 521 群体（`dt=40`），4600 tokens | **6** | **6** | 0 |
| 381，7000 tokens | **0** | **0** | 0（全都出现）|
| 521 群体，4600 | **0** | 0 | 0（全都 dropped，不是「挤」，是根本塞不下）|

**用 EXISTENCE 归档的 `pinned-380.json` 复核**（它自己跑出来的逐 run `pA.cap` / `pB.cap`）：
- 保留 WF：260 有 CAPACITY；删掉 WF：282 有。
- **`pA.cap && !pB.cap`（真被挤掉）= 12**；`!pA.cap && pB.cap`（删掉才出现）= **34**。
- **它的 §1.3 表把「34 个 gain」写成了「差 −34」** —— 这是**符号错**：260→282 是**多了 22**，不是少了 34。

**谁对**：
- **红队 66/516** 与 **复测 8/20** —— 它用的可能是「剔 WF 后**第 9 条诊断补进来**」的装置，而补进来的诊断会占字符、间接把 CAPACITY 挤掉。我的 faithful 装置里这个数量是 **1**（也就是说在 `3967aa5`、5300 预算下，CAPACITY 被挤是**极少数**）。
  **红队的 66 我没能复现 —— 但我复现了它的方向**：剔 WF 后 CAPACITY 偶尔丢失。差异量级来自「补进来的码是否 lengthened the diag list」。
- **PLAN F7 的 0/519** —— 方向对（几乎不被挤），但「0」太绝对：我测到 **1**（faithful）/ **6**（4600）。PLAN 用 `5300/24000 + itemsOnBelts`，接近我的 faithful，只是它报 0 我报 1，**1 个样本的差**，可忽略。
- **EXISTENCE 34/380** —— **错**。它把 gain 当 lost。真实的「被挤」是 **12/380**（`pA&&!pB`），而且**更正的方向是「删 WF 反而多出 34 个 CAPACITY」**（省下的 330 字符被 CAPACITY 抢到了）。这条错误后来被 `6e98253` 的提交信息（「WF 的存在让这段在 34/380 个快照里被挤掉」）与 `c63df17` 的代码注释**原样继承**成了「CAPACITY 被 WF 挤掉 34/380」—— 这是**一个数字错误被写进了提交信息和代码注释**。

**裁决**：

```
矛盾 1：CAPACITY 被 WF 挤掉了多少？
我的数字：faithful 5300 预算下 丢 1 / 得 25；用 EXISTENCE 自己的归档数据复核 = 丢 12 / 得 34（380 快照）
谁对：PLAN 的方向对（极少），但「0」低估；红队「66」是另一种装置；EXISTENCE「34/380」错了符号
正确口径：区分「丢」与「得」两个方向，报告两者，不要报净差；且在 faithful 装置上 CAPACITY 丢是 <3% 的边缘现象，不是主要受害者
```

**附带发现（比数字本身更重要）**：真正的受害者不是 CAPACITY，而是 **HUB stored**（我测 faithful 参数下 lost 7、红队测 6、PLAN 测 305）。但 **HUB stored 的丢失量对装置极端敏感**：同一批 521 快照，`faithful` lost 7，`no-items` lost 9，`no-prod` lost 12，`lean(no items/no prod)` lost 17。**PLAN 的 305/519 是 lean 装置再放大**（它可能连 `production` 都没传或用了不同的 segment 长度）。所以「305」不是假数，但它是「**最 lean 的装置**」的上界，faithful 真机参数下应是 7 量级。

---

### 矛盾 2：`PATHS_TRUNCATED` 到底进没进结果？

**我的数字**（读 17 个截断+零产出 run 的 transcript，逐 run）：
- `transcript.jsonl` 的 `diagnose` 事件里，`codes` 数组含 `PATHS_TRUNCATED`：**17/17**
- 同事件的 `diagnoses[]` 对象数组里也有 `code:"PATHS_TRUNCATED"`：**17/17**
- `observe.problems` 含 `PATHS_TRUNCATED`：**17/17**
- **`plan-last.json` 的 `verify.codes` 含 `PATHS_TRUNCATED`：5/17**
- 我用 `diagnose()`（`3967aa5`）+ 复刻 loop 的 `for (p of ob.problems) diagnoses.push(p)` + `buildPrompt()`，**渲染后的 prompt 里含 PATHS_TRUNCATED：17/17**

**谁对**：
- 红队「`PATHS_TRUNCATED in codes: 0`」—— **错**。红队读的不是 `transcript diagnose.codes`，它的脚本报 0 而实际 transcript 里 17/17 都在。最可能的解释：红队读的是 `plan-last.verify.codes`（那里只有 5/17），或者它把 `codes` 理解成了 `plan` 阶段的 verify codes。红队甚至在正文写「被 `dropInlets` / 合并阶段吞了」—— 这个机制解释**也是错的**：`dropInlets` 只过滤 hub 入口 uid 的 subject / handles，不碰 `PATHS_TRUNCATED`（它的 subject 是 `-`）。
- FIX-TRUNCATED「进了 codes（17/17）」—— **对**（在 `diagnose` 输出层、在渲染 prompt 层都对）。

**裁决**：

```
矛盾 2：PATHS_TRUNCATED 进没进 diagnose 结果？
我的数字：transcript diagnose.codes 17/17；plan-last.verify.codes 5/17；渲染 prompt 17/17
谁对：FIX-TRUNCATED 对；红队错（读了错误的载体，并给出了错误的机制解释）
正确口径：分三个载体报：(a) diagnose() 返回值 / transcript diagnose 事件 (b) plan 阶段的 verify.codes (c) 渲染后的 prompt。三者不同步，不能用一个代表全部
```

**这条的重要性**：红队把「PATHS_TRUNCATED 没进 codes」当成一个独立缺陷写进了建议修法（§建议 6 + 一句话结论）。**这个缺陷不存在**。若有人照着修，会去改一个本来就正常的链路 —— 这正是本项目「算出来 ≠ 送到」教训的反面：**有些东西送到了，但报告说没送到**。

---

### 矛盾 3：`WORLD_FROZEN` 的 RANK 应该是多少？删掉之后「98/380 失去全图判定词」还成立吗？CAPACITY 极短保底补上了吗？

先回答 RANK：

**我的数字**（`3967aa5`，rank=8）：381 个 WF 触发快照里，**剔 WF 之后重新 cap（cap 前剔）**，
有别的码补进前 8 的 = **321/381 = 84.3%**（EXISTENCE 报 84.2% 的 320/380 —— 一致）。
补位码分布（我的）：`ORE_UNMINED 92 / MINER_UNWIRED 88 / MIXER_COLOR_AIMED 88 / CHAIN_UNFED 33 / OUTPUT_STRANDED 11 / SHAPE_UNKNOWN 5 / TRASH_OVERGROWN 3 / DEAD_END 1`。
EXISTENCE 报：`ORE_UNMINED 92 / MIXER_COLOR_AIMED 88 / MINER_UNWIRED 87 / CHAIN_UNFED 33 / ...`。**逐码对得上，只差 1 个 MINER_UNWIRED**（就是那 1 个多出来的 run）。**84.2% 我确认。**

**rank=15 会怎样**：`LIMITS.TOTAL=8` 取前 8，rank 15 必然被砍 —— LIVEVERIFY-ALARM 的复核对，我也复现：rank 15 下它在 prompt 里 0 次。**排 15 = 删除**。

**但是**：RANK 值的「应该」不是数字问题，是**呈现位问题**。CONFLICT-RANK-SLOT 提了三个候选、未裁决 —— 裁决已经发生（删了），但**删的理由与它自己的数据有矛盾**：EXISTENCE 说「NO_PRODUCTION + CAPACITY 覆盖了它的信息」；CONFLICT-RANK-SLOT 说「前提：确认 NO_PRODUCTION + MACHINE_STARVED 真的覆盖了它的信息」。这两条**都没被独立验证**，而 EXISTENCE §5 自己承认有 **98/380（25.8%）** 的快照，删 WF 后「全图零产出」这句话**完全不存在**（因为 CAPACITY 被 `dropped-for-budget` 挤掉）。

**「98/380 失去全图判定词」的反证成不成立？—— 我的裁决：一半成立，一半推翻。**

1. **反证的事实部分成立**：删 WF 后，确实有约 **93/381（24.4%）** 的快照 CAPACITY 整段缺失（我测 HEAD 删 WF 后 = 93/381，全是 `room<120` 外层闸）。这些快照里「全图零产出」这句**不在 prompt 里**。EXISTENCE 报 98/380（25.8%），我报 93/381（24.4%）—— **量级一致，方向一致，反证事实成立**。
2. **但「补上」的方式没成**：`6e98253` / `c63df17` 加的「CAPACITY 极短保底」**在零产出路径上是死代码**。我实测 HEAD：`renderCapacity` 在 381 个快照上被调用 **288 次，form 全是 `full`，一次都没走 `short`**；`capacity_downgraded` = **0/381**。也就是说**那 115 字符的短版，一次都没渲染过**。这 93 个快照上，CAPACITY 整段仍然消失，「全图零产出」这句话仍然没有。`3bfe6b4` 刚刚修了这个死代码（我在它之后复算：presence 仍然是 288/93 —— **因为缺的 93 个全是 `room<120` 外层闸，连短版都放不下的情形**；`3bfe6b4` 只让 `room` 在 120–199 之间时降级成短版，而实测这些快照 room 都 <120）。

所以：

```
矛盾 3：删 WORLD_FROZEN 之后「98/380 失去全图判定词」的反证还成立吗？CAPACITY 保底补上了吗？
我的数字：93/381 快照删 WF 后 CAPACITY 整段消失（成立，量级对）；但那批快照里 CAPACITY 短版保底一次没渲染过（死代码，100% 未执行）；room 全在 <120 外层闸之外
谁对：EXISTENCE 的「有 25% 快照失去全图判定词」成立；「加极短保底就补上了」不成立（在它最初写的形态下一次都没跑）
正确口径：「全图零产出」这个信息源在删 WF 后确有约 24% 快照失守；要真补上，得改外层 room>=120 的硬闸（让零产出短版能在 room<120 时也进），不能只在 renderCapacity 内部加分支
```

⚠️ **这是本报告最接近 blocker 的一条**：一个「以为补上了、其实一行没执行」的保底，
加上一个被提交信息与代码注释继承的错误数字（34/380 符号反了），会让人以为
「删 WF 的信息损失已经被兜底」。而实测兜底是死的。**当前 `3bfe6b4` 修了死代码的形态，但没有修「room<120 时整段消失」这个根**——那 93 个快照仍未兜住。

---

### 矛盾 4：世界为什么不产出（三份报告是矛盾还是不同层次？）

**我的核对**：
- **因果时序**：`produced_total` 最后一次非空 = `r-20261115121125-264d`（tick 556385），
  第一次为空 = `r-20261115121951-39ea`（tick 556784）。间隔 **399 tick ≈ 3.3 游戏秒**（120Hz）。
  ROOTCAUSE 精确到「12:14:35 那一刀」「12:19:51 归零」，dt=5 分钟（`dt = 5 分钟` 见 DEADLOCK）——
  我算的 tick 差是 399 tick（约 3.3s），**不是 2 秒也不是 5 分钟**。CRITIQUE 说「dt = 2 游戏秒」，
  DEADLOCK 说「dt = 5 分钟」，**两个数字都不对**（都对不上 399 tick）。
  这可能是 verify 的 2400-tick 步进把观测时刻推远了；但**以 obs.tick 为准，3.3 秒**。
- **断点三格**：`8b63`（12:11）→`264d`（12:14）只差 3 格（我独立 diff 复现）：`14953 rv2→rv0`、`15019 rv0→rv2`、`15021 belt→trash`。**ROOTCAUSE / CRITIQUE 对。**
- **那个断点是不是「insert_machine 邻居重算」造成的**：三格里的两格（14953/15019）是**邻居重算**，不是 op 声明的。`tx_plan` 只声明 `destroys:[15021]` + 1 placement。**CRITIQUE / FIX-NEIGHBOR-RECOMPUTE 对。**
- **「259 件」是不是因**：CRITIQUE 说「259 是死亡后 28.9 游戏小时才攒出来的，方向反了」。CRITIQUE 自己的 §十 又写回「259 件是根因」，随后 §结论修正了。**CRITIQUE 内部矛盾已被它自己承认，且事实对（259 在死亡后出现）。**

**层次图**（三种说法不是矛盾，是三层，但我标注每层的证据强度）：

```
┌ L0 触发事件（一次性、已核实）
│  2026-11-15 12:14:35  insert_machine(trash) @(-3,-8)
│  ops=[delete 15021, place trash]，但游戏对邻居重算改写了 14953/15019 两格的 rv
│  证据强度：★★★（obs 逐格 diff 3 格，tx_plan 只声明 1 destroys，铁证）
│  归属：CRITIQUE + ROOTCAUSE + FIX-NEIGHBOR-RECOMPUTE 全对
│
├ L1 机制（为什么 op 之外的东西被改了）
│  mod 的 tx 用 runGuarded 包 async 循环；performImmutableOperation 是同步的，
│  第一个 await 就复位标志 ⇒ 只有第一条 op 在 immutable 内 ⇒ 后续 op 触发
│  BeltSystem.updateSurroundingBeltPlacement 重算邻居
│  证据强度：★★☆（离线读源码 + vm 复现 runGuarded 标志泄漏；未真机插桩）
│  归属：FIX-NEIGHBOR-RECOMPUTE / PLAN T3 对；这是「世界为什么不产出」的最深可修层
│
├ L2 直接后果（3.3 游戏秒后）
│  painter 的 color 供料链被掰断 ⇒ painter 停 ⇒ stacker 单路 ⇒ 整图零产出
│  证据强度：★★★（production 从 10 键→{}，tick 差 399）
│  归属：ROOTCAUSE 对
│
├ L3 累积症状（死亡后数小时到 28.9 小时）
│  path8 攒到 259 件、13 步连锁拆除把 (-4,15) 从 25 格拆到 0 格
│  证据强度：★★★（时序清楚，是果不是因）
│  归属：CRITIQUE 对（推翻 WORLD-IS-DEAD 把它当根因）
│
└ L4 结构上限（不是「死」的原因，但是「救不活」的原因）
   白色 = 两次 mix（cyan|red）；单台 stacker 0.25/s，1000 件要 3.3 小时；
   verify 每轮推进 7200 tick 但 loop 只记 2400 —— 预算算术
   证据强度：★★★（代数 + 实测 rate）
   归属：SEARCH-WHITE-PATH 对（做得到，缺接线不是缺资源）；WHY-NO-PRODUCTION 对（delivered>=1000 不可达是算术）
```

**裁决**：

```
矛盾 4：世界为什么不产出？
我的数字：断点 399 tick（≈3.3s）前 `264d` r3 insert_machine(trash)，游戏重算 2 格邻居 rv，painter color 供料链断
谁对：都对，是四个不同层次（L0 触发 / L1 机制 / L2 后果 / L3 症状 / L4 结构上限）
正确口径：不要问「谁是真因」；要说清「哪一层能修」。L0/L1 可修（FIX-NEIGHBOR-RECOMPUTE 的根因 T3）；L2 是 L1 的后果；L3 是噪音；L4 是「救不活」的算术，与「为什么死」正交
```

---

## 三、我没被点名、但核出来的新矛盾

### 新矛盾 A：EXISTENCE §1.3 把「gain」写成「被挤掉」，且这个错被提交信息 + 代码注释继承

- EXISTENCE §1.3 表：`保留 WF 260 / 删掉 WF 282 / 差 −34`。但 260→282 是**多 22**，不是少 34。**34 是「删掉 WF 后新出现的 CAPACITY 数」，方向被写成「被挤掉」**。
- `6e98253` 提交信息正文：「WF 的存在让这段在 **34/380** 个快照里被挤掉」—— 直接继承，且这句与它自己同一提交的下一句「98/380 被挤掉」**并列出现**（一个说 34 被挤、一个说 98 被挤，两句话指的是**相反的事实**）。
- `CHANGELOG.md:127`（`6e98253` 加）：「而 WF 的存在让这段在 **34/380** 个快照里被挤掉」—— 继承。
- `src/agent/loop/prompt.mjs:2573` 与 `:2594` 代码注释（`c63df17` 加）：「**98/380（25.8%）** 的零产出快照上它整段被 `dropped-for-budget` 挤掉」。
  - 这 98 是「删 WF 后仍无零产出句」的数，**它是对的**（我测 93/381，量级一致）。
- **谁对**：34 错（gain 写成 lost，符号反）；98 对（但那是「删 WF 之后仍缺」不是「WF 挤 CAPACITY」）。**两个数在同一个提交信息里并存，含义相反**，读者必然误解。
- **危险**：这两个数字都进了**代码注释**和**提交信息**，是「不可回收的错误」。

### 新矛盾 B：`CRITIQUE-DEAD-WORLD` 内部前后不一致（它自己承认过一次，但还有一处没承认）

- CRITIQUE 自己在 §质疑 2 承认「原结论（259 件是根因）错误，因果反了」，并在结论里修正。
- 但 CRITIQUE 的 **§建议** 第 2 条仍写「`health.mjs:384`：`items_on_belts` 不能单向算 GOOD_UP … 影响 221 个已归档 run 的评分」—— 这个 221 与 REGRESSION-AUDIT 的 **403** 是**同一个量的两个值**（「零产出 run 里含 items_on_belts 的 delta 行数」）。
  - REGRESSION-AUDIT §2.3：`零产出 run 里含 items_on_belts 的行=742，其中只有 items_on_belts（+redundancy）⇒ 改后整行变「无变化」= 403`。
  - CRITIQUE：`影响 221 个已归档 run 的评分`。
  - **这是两个不同的量**：403 是「行数」，221 是「run 数」。CRITIQUE 用「run 数」表述「评分受影响」，REGRESSION 用「行数」。两者不矛盾，但读者会把它们当成同一个「被影响的数量」。**语义漂移**，见下。

### 新矛盾 C：`dt = 2 游戏秒` vs `dt = 5 分钟` vs 实测 `399 tick ≈ 3.3 秒`

- CRITIQUE §质疑 1 摘要与建议 3：「dt = 2 游戏秒后，painter 的颜料线清零」「在 2 游戏秒内把唯一还活着的颜料线掰断」。
- DEADLOCK-CHAIN：「produced_total 从 10 个键变成 {}（dt = 5 分钟）」。
- **我的数字**：`264d` 的 `obs.tick` 556385.45，`39ea` 的 `obs.tick` 556784.46 ⇒ **399.0 tick**。按 120Hz = **3.33 游戏秒**。
- **谁对**：两个都不精确。**3.3 秒**才对。2 秒是 CRITIQUE 忘了 verify 会推进 2400 tick（20 秒）再观测？5 分钟是 DEADLOCK 把「两次 run 的墙钟差」当成游戏秒。
- **危险**：中低。这个数字不改变因果结论，但会误导「多快死」的直觉（3 秒 vs 5 分钟差 100 倍）。

### 新矛盾 D：「满载」三口径互相矛盾，且各报告各用一个

见下语义漂移表。这不是某份报告的错，是**三份报告用「满载」指三件事，合起来读会以为一致**。

---

## 四、语义漂移清单

| 词 | 报告 A 的定义 | 报告 B 的定义 | 危险 |
|---|---|---|---|
| **「满载」** | 红队：`fill >= 0.85`，`fill = n / max(1,floor(cells/0.63))`（旧公式）；且 132/516 报 >100%，最高 103% | ROOTCAUSE / DEADLOCK：`间距全是 0.63`（path8 165 格 259 件，"间距全部 0.63，258 个间隙无一例外"）| FIX-TRUNCATED：`worst.n`（货量绝对值最大），不看 fill | **高**：同一句「最堵」会指向三条不同的带子。我实测 `4e86`：按 items 最大是 path30（31 件），按 fill≥0.85（旧公式）是 path9/19/20（各 2 件、各 1 格，fill 2.0），按「间距全 0.63」又是另一条。**而且旧公式在 `3967aa5` 上已被修（0.78 弯带修正），红队的 132/516 在 HEAD 上是 0**（我实测 max fill = 1.000）。所以「132/516 报 >100%」在 HEAD 上**已不成立**，红队报告的是旧公式下的历史数 |
| **「死亡」** | WORLD-IS-DEAD / 红队：`produced_total === {}`（全图零产出） | EXISTENCE：「目标形状窗口产出 0」（`delivered 0/1000`） | PLAN：「`produced_total` 全零的零产出快照」 | **高**：「世界死了」「目标没产出」「货没到 hub」是三个不同状态。红队实测：50 个 `produced_total > 0` 的快照（活着），`WORLD_FROZEN` 一次不报（对）；但同 world_hash 的 `de26`（prod 66）与 `99fb`（prod 0）是**同一个世界不同窗口**，说明「死」是**窗口现象不是世界属性**（我也独立复现了这个同 hash 反例）|
| **「截断」** | 红队：`truncatedPaths === true` | FIX-TRUNCATED：`truncatedPaths === true \|\| pathCount > paths.length` | 我实测：**两者在这批数据上完全等价（44 = 44，零差异）** | **低（当前）/ 高（未来）**：现在等价，但 FIX-TRUNCATED 的代码取了「或」是有道理的（定义了不自相矛盾时的防御）。今天无差异，不等于以后无差异 |
| **「被挤掉（dropped）」** | PLAN：`capacity_unavailable === "dropped-for-budget"`（有→无） | EXISTENCE：`pA.cap && !pB.cap` 是 lost，但它数的是 `pB.cap && !pA.cap`（gain）并叫它「被挤掉」 | 红队：`CAPACITY lost by WF` 但把 gain 也算进 net | **极高**：这是矛盾 1 的根源。「挤掉」应严格 = 有→无。把「无→有」算进去就变成净差，符号会反 |
| **「送货 / 送达」** | FIX-TRUNCATED：「`PATHS_TRUNCATED` 进了结果」= 在 `diagnose()` 返回值里 | 红队：「没进 codes」= 在 `plan-last.verify.codes` 里 | **高**：同一句「进了结果」，一个看诊断输出、一个看 plan 验证码。我测：诊断输出层 17/17，plan verify 层 5/17，两个都对，但指的不是同一件事 |
| **「CAPACITY 保底」** | EXISTENCE：`## CAPACITY` 的零产出分支 | `c63df17`：加一档 ≤120 字符极短保底 | **高**：保底从没执行（死代码），但提交信息与注释都声称它补上了。读者会以为「零产出这句总有」，实际 room<120 时整段消失 |

---

## 五、一句话：这些矛盾合起来说明什么

**六个矛盾里，有四个是口径不同（矛盾 1 是方向/装置、矛盾 3 的 rank 是呈现位 vs 排序、矛盾 4 是层次、语义漂移是词义），但有两个是真错，而且都已经被写进了代码/提交信息：**

1. **EXISTENCE 的 34/380 符号错**（gain 写成 lost）→ 被 `6e98253` 提交信息与 `c63df17` 代码注释继承。**这条已经进了代码**，是 blocker 级的信息污染：下一个人读 `prompt.mjs:2572` 的注释，会以为「WF 挤掉 CAPACITY 34/380」，而真相是「删 WF 反而多出 34 个 CAPACITY」。
2. **CAPACITY 极短保底是死代码**（零产出路径上 100% 未执行，`form` 永远 `full`）→ 被 `6e98253` 声称「已补上」。删 WF 后仍有 **93/381（24.4%）** 快照整段缺失、`room<120` 外层闸没放过。`3bfe6b4` 修了形态（让 full 也看 room），但**没修根**（room<120 时连短版都进不去）。

**没有一条矛盾会让「世界真的死了」这个结论动摇。** 所有报告的判据（`produced_total` 空、integrity 完整、odzi 输出）在交叉复核下都成立。动摇的是**关于「删 WORLD_FROZEN 的配套兜底已经完成」这个信念** —— 那个兜底是假的：一行没执行，而继承的错误数字让人以为它补上了 25.8% 的洞。

---

## 六、给主线程的三条可执行建议（按优先级）

1. **先修 `6e98253` 提交信息 / `CHANGELOG.md:127` 里的 `34/380`**（零风险，纯文档）：
   34 是「删掉 WF 后 CAPACITY 新出现的数量」（gain，方向是**删掉更好**），与同一段里的
   98/93（「删 WF 后仍无零产出句」= 真损失）含义**相反**。两个数并列出现会让读者以为「WF 挤掉 CAPACITY 34/380」。
2. **`## CAPACITY` 零产出保底要能穿过外层 `room>=120` 闸**：现在短版 ~115 字符，但外层在 `room<120` 时根本不调用 `renderCapacity`。要么把这个闸对零产出分支降到 60，要么让零产出这一句进「不可截断」段（与 `## GOAL` 同档）。否则那 93 个快照永远失守。
3. **把 `PATHS_TRUNCATED` 的「送达」判据写清楚**：它是三载体（diagnose 输出 / plan verify / 渲染 prompt）。红队「一条都没出现」的结论是**基于错误载体**得出的，不要再按它去「修一个不存在的缺陷」。

---

## 七、方法学备注（我自己的边界）

- **我没能精确复现 PLAN F7 的 305/519**。我在 lean 装置（不传 items/prod/onBelts）下测到 `HUB lost 17`（521 群体），faithful 下 `lost 7`。305 需要比我 lean 更极端的装置（可能是 4600 预算 + 不传任何第三参数 + 不同 cap 时机）。**方向我确认（HUB stored 才是真受害者），量级我无法复现**，所以我不下「305 对/错」的裁决，只标「装置依赖，非物理常数」。
- **我没能复现红队 66/516 的 CAPACITY 丢**。faithful 下是 1。**我复现了「剔 WF 后 CAPACITY 会丢」这个方向，但没有 66 这个量级**。红队没写装置，我无法归因。
- **会话期间 HEAD 前进了 3 个 commit**，其中 `3bfe6b4` 正好修了我在测的死代码。**我的「死代码」结论是在 `6e98253`/`c63df17` 形态上成立的**（当时是死的），`3bfe6b4` 之后形态改了但仍未兜住 room<120。两个时点我都跑了，数字分开标。
- 备份副本：`.tmp-cross/src/`（3967aa5）、`.tmp-cross/srcp/`（3967aa5+无限 cap）、`.tmp-cross/head/src/`（删 WF 后、3bfe6b4 前）、`.tmp-cross/cur/`（3bfe6b4 后）。原始 JSON 都在 `.tmp-cross/*.json`。收工后全部删除。
