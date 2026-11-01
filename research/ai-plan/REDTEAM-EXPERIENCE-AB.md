# 红队：「给 LLM 加经验」这个实验 —— 哪里会失败

> 2026-11-02。红队 agent。任务不是帮忙，是找出这个计划会失败的地方。
> 每条结论后面都有可复现命令或 `文件:行号`。**猜想单独放 §8，不进结论。**
> 所有实测都在 `.tmpverify/rt-*.mjs` 里，可重跑。

---

## 0. 结论（先看这个）

**方向上可以做，但按现在的设计做出来，主判据一定会给你一个假的正结果。**

三条独立的、已实测的硬问题：

1. **在这个场景里，`replace_run`+`cutter`+`trash` 只能把新 cutter 放成「串联」**。
   穷举全部 ≤12 格矩形，**恰好 9 个合法**，而且**全部 9 个**都满足
   「新 cutter 的 right（产品）出口落在 `(4,-16)` = C1 的进料带 B11」。
   ⇒ **物理上无法并行**。串联不提高吞吐（两条 0.5/s 的线串起来还是 0.5/s）。

2. **但 `capacityOf` 会把串联当并联算**：`assess.mjs:233` 是
   `productPerSec: list.length * rate * per` —— 同种机器一律 `count × rate`。
   实测（`.tmpverify/rt-nine2.mjs`）：放一台串联 cutter，
   `proc 0.5 → 1.0`、`utilization 27.8% → 55.6%`，**而真实产出一个字都没多**。
   ⇒ **L3 判据（`QUALITY-METRICS.md:75`）在这里可以被「做一件正确的事」刷满，
   而这件事零收益。** 不需要模型学坏，只要它照做。

3. **B2 的 `16/25` 几乎全是「抄了 CAPACITY 的选项行」**：23/23 条 thinking 里都能 grep 到
   `add 3 cutters (1→4)` 这串逐字字符。而把计划真的按 loop 的顺序跑一遍
   （`resolveRefs` → `validateMacroCall` → 宏 → `planToTxOps`），
   **16 → 2**，且**这 2 条都是「串联 cutter」，按 §2 的机制零收益**。

⇒ 如果现在按「四种经验形态 × L3/L4」跑，最可能的产出是一个
**「(b) 手写心得最强」** 的结论，而它的机制是「静态文本里恰好抄了 CAPACITY 会说的话 +
判据奖励了一个零收益动作」。那不是「模型变聪明了」。

**必须先改的四件事见 §6。**

---

## 1. 「经验」和「观察面」不是同一个东西 —— CAPACITY 的成功恰恰是反证

### 1.1 CAPACITY 段给的是什么

`.tmpverify/ab-capacity/prompt-B.txt:117-122`：

```
## CAPACITY
supply 1.8/s | processing 0.5/s | 28% utilized
bottleneck: cutter — 72% of supply is stuck here
options:
  · add 3 cutter (1→4) ⇒ 2/s — fills the line
```

三样**现算**的量：当前 supply、当前 processing、以及「加几台能填满」
（`assess.mjs:490-505`，`needed = Math.ceil(supply / (rate*per))`）。换世界这个数就变。

### 1.2 模型是照抄还是推理 —— 实测

对 B2 臂 23 条可解析样本（`.tmpverify/rt-check-claims.mjs` 一类的检索）：

| 检索项（thinking 字段） | 命中 |
|---|---|
| `add 3 cutters`（CAPACITY 选项行原文） | **23/23** |
| `1→4` | **23/23** |
| `⇒ 2/s` | **23/23** |
| `72%` | 20/23 |

原文（`results-v2.json` 的 `thinking`）：

> `B2#1`「Recipe needs miner×1, cutter×1 for the shape, but **capacity says add 3 cutters (1→4)**.」
>
> `B2#2`「Options: **add 3 cutters (1→4) ⇒ 2/s**.」
>
> `B2#3`「So supply 1.8/s but cutting 0.5/s. Need more cutters: **add 3 cutters (1→4) ⇒ 2/s**.」
>
> `B2#6`「supply 1.8/s, processing 0.5/s. Bottleneck cutter 72% stuck.」

**「add 3 cutters (1→4)」逐字出现率 100%。** CAPACITY 段的作用是**把答案直接写在题面上**。

### 1.3 对照：A2 臂自己就想到要加 cutter

A2（无 CAPACITY）的 thinking 里，**22/23** 条自己提出了「加 cutter」。原文：

> `A2#5`「Rate 0.5 suggests throughput bottleneck: single cutter only. **Maybe add a second cutter?**
> Recipe says machines needed: miner×1, cutter×1.」
>
> `A2#7`「**Could we connect L1.secondary to a NEW cutter?** We could insert_machine a cutter and connect.
> But recipe says only 1 cutter, and complexity.」
>
> `A2#22`「**Adding a second cutter** is allowed by recipe? "machines this shape needs: miner×1, cutter×1"
> — it says what it needs, and explicitly forbids rotater/stacker/painter.」

**两臂都想到了。** 差别在处理阶段的**授权**，不是理解。

`EXPERIENCE-SOURCE-FACTS.md:215-217` 自己已经点到这一层：

> ⇒ **「升级 vs 加机器」不是经验，是 `capacityFor` 已经算出来的事实。**

这句话是对的，而且比它写的更严重 —— 见 §2，`capacityFor` 算出来的那个「事实」**本身是错的**。

### 1.4 对实验设计的直接影响

**形态 (b)「手写玩法心得」里凡是能被 `capacityFor` 算出来的条目，A/B 测的是「抄答案的准确度」。**
你不会知道模型是学会了，还是碰巧记住了。

⇒ **建议把对照从「A2 vs B2」改成「B2 vs B2+经验」。** CAPACITY 已经在了，经验只能在它上面加分。
否则你测的是 0→1 的观察面补全，不是经验。

---

## 2. 【最致命】判据可以被「做正确的事」刷满 —— 串联 cutter 零收益，utilization 翻倍

### 2.1 公式

`src/agent/assess.mjs:274`：

```js
utilization = supply > 0 ? Math.min(1, processCapacity / supply) : null;
```

`supply = activeMiners × minerRate`（`:219`）；
`processCapacity = min over 机器种类 of productPerSec`（`:242-244`），而
`productPerSec = count × rate × per`（`:233`）。

⇒ **同种机器一律按并联相加。串联的机器会被当成额外产能。**

### 2.2 这个场景里，串联是**唯一**能放 cutter 的方式

穷举所有 ≤12 格、含 ≥1 条带子的矩形，用 `replace_run` + `cutter` + `trash(left,confirm_waste)`
（`.tmpverify/rt-nine2.mjs`）：

```
合法 cutter+trash region: 9
   [2,-16,4,-13]  cutter@[3,-15]  right→ 4,-16 (=B11, C1 进料带)  left→ 3,-16  removes [20039,20040]
   [2,-16,4,-14]  cutter@[3,-15]  right→ 4,-16  ...
   [2,-16,5,-14]  cutter@[3,-15]  right→ 4,-16  ...
   [3,-16,4,-11] ... [3,-16,4,-12] ... [3,-16,4,-13] ... [3,-16,4,-14] ...
   [3,-16,5,-13] ... [3,-16,5,-14] ...
其中 right→(4,-16)=B11(C1 进料带) 的: 9
```

**9/9 都是串联。** 原因在几何：cutter 是 2×1，left 废料口在 `origin+(0,-1)` 且必须落在
region 内（`remove.mjs:784-789`）；场景里 37 条带子几乎都是单格宽，任何 2 格高的 region
都要跨到相邻列 —— 跨过去不是撞 balancer 就是撞 C1。唯一放得下的地方，
`right` 出口正好落在 `B11`（C1 唯一的进料带，uid 20016）。

### 2.3 于是：utilization 翻倍，真实产出为零

```
BASELINE                       util 27.8%   proc 0.5   supply 1.8
放一台串联 cutter@(3,-15) 后   util 55.6%   proc 1.0   supply 1.8
```

真实单链吞吐 = `min(0.5, 0.5) = 0.5/s` —— **一台兄弟机白占，产出一点没多**。
（顺带：串联不毁产品。`cut(RuRu----) = ['', 'RuRu----']`，上游
`item_processor.js:378-381` 的 `isEntirelyEmpty()` 会跳过空槽，产品原样透传。）

⇒ **`QUALITY-METRICS.md:75` 的 L3「`utilization` 或瓶颈是否被处理」会判它满分，
而它什么都没改善。**

**这一条不需要模型学坏。** 模型被 CAPACITY 明确告知「add 3 cutter (1→4) ⇒ 2/s」，
它照做、用唯一合法的方式做，判据就给它加分。**判据在奖励一个零收益动作。**

### 2.4 同类问题：`insert_machine` 也能刷

`assess.mjs:192-208` 的「在产线上」只做四邻 BFS。贴着任何带子放一台**不接货**的 cutter
就进 `processCapacity`。实测（`.tmpverify/rt-gaming3.mjs`）：

```
insert_machine cutter @(5,-7) => ok   (removed=[])
insert_machine cutter @(5,-8) => ok   (removed=[])
AFTER 两台空转 cutter: util 83.3%  proc 1.5  supply 1.8
```

两台**输入槽悬空**（`(5,-6)` 无实体）的 cutter，把 utilization 从 27.8% 刷到 83.3%。
loop 不会拒：`loop.mjs:1218-1248` 只拒 `ok:false`，宏返回的
`output_belt_wrong_direction` / `wiring_mismatch` 只是 **warnings**。

### 2.5 还有一条：分母也能动（当前被宏挡住）

删 2 台矿机 ⇒ `supply 1.8 → 0.6`，`utilization 27.8% → 83.3%`（`.tmpverify/rt-gaming.mjs`）。
当前 `remove_run` 只动带子（「选集里有 N 个非带子实体（整单拒绝）」），**这条路不可达**。
但它证明分子分母**都能被单方面动手脚** —— 一旦以后加了 `remove_machine`，判据立刻破。

> **判据能被一个懒惰策略刷满 ⇒ 这个实验测的是「模型会不会钻空子」，不是「模型有没有变聪明」。**

---

## 3. 判据算错了「命中」：16/25 → 2/23，且这 2 条都是零收益

### 3.1 判据只看参数里有没有 `cutter` 这个词

`arms.mjs:267-277`：`insert_machine.machine` 或 `replace_run.building` 里出现 `cutter`
就算 `acts_capacity`，再算 `addresses_bottleneck`（`:307`）。**没有过宏。**

### 3.2 按 loop 的顺序真跑一遍

`.tmpverify/rt-faithful.mjs` 复现 `loop.mjs:1178-1265`
（`resolveRefs` → `validateMacroCall` → 逐条宏 → `planToTxOps`）：

```
[A2] n=23  判「处理瓶颈」= 0   宏全过=3  且 planToTxOps 过=3
[B2] n=23  判「处理瓶颈」=16   宏全过=2  且 planToTxOps 过=2

B2 卡点: replace_run:precondition_failed 7 | validate:trash_unused:outlet.port 4
         resolveRefs:PATH_NOT_RECT 3 | insert_machine:ambiguous_site 3 | resolveRefs:REF_SHAPE 1
```

**16 → 2。** 换句话说：**「CAPACITY 让模型学会了处理瓶颈」在当前证据下不成立。**

重算 Fisher（`.tmpverify/ab-prompt/stats.mjs`，含 6 组自检）：

```
判「命中」        0/23 vs 16/23   p = 4.95e-07    <- 原报告的口径
既命中又跑得通    0/23 vs  2/23   p = 0.4889      <- 换个口径就不显著
```

### 3.3 那 2 条「跑得通」的，实际效果是什么

| 样本 | 计划 | 真实效果（已实测） |
|---|---|---|
| `B2#21` | `insert_machine cutter @(4,-16) facing top, replace_belts:true` | 删掉 **B11（uid 20016，C1 的唯一进料带）**。新 cutter 的 left（废料）落 `(4,-17)` = **C1 的接受槽**；right（产品）落 `(5,-17)` = **C1 的机身**，不是接受槽。⇒ **产品进死路，废料喂给 C1**。目标形状产出 = 0。 |
| `B2#22` | `replace_run region [3,-9,4,-9] building [{cutter}]`（**裸 cutter，没有 trash**） | 删掉 L1 的两条进料带（uid 20038、20011），新 cutter 夹在 L2 与 L1 之间，**left 和 right 都灌进 L1 的两个接受格**。串联，零收益。 |

两条都被 `judge()` 判成及格（`acts_capacity=true`、`addresses_bottleneck=true`）。

`B2#21` 的完整验证（`.tmpverify/rt-DEFINITIVE.mjs` / `rt-geom.mjs`）：

```
cutter origin (4,-16)  机身格: (4,-16)(5,-16)
  接受槽 cell=(4,-16) dir=bottom → 来料格 (4,-15)
  喷出槽 cell=(4,-16) left  dir=top → 落格 (4,-17)
         cell=(5,-16) right dir=top → 落格 (5,-17)
C1@(4,-17) 机身格 ["4,-17","5,-17"]  接受槽 cell=(4,-17)
  → left 落 (4,-17) = C1 的接受槽 ✔
  → right 落 (5,-17) = C1 的机身     ✘ 死路
```

**产品链从这一格起断掉。** 而 `capacityOf` 从 27.8% 涨到 55.6%，判据说「命中」。

### 3.4 顺带：prompt 教给模型的端口名，宏不认

`handles.mjs:452-455` 把多输出槽渲染成 `top:primary` / `top:secondary`（如
`L1 balancer 输出=top:primary(→B22)/top:secondary(→无)`），
但 `validateMacroCall` 的 `outlet.port` 只收小写标识符：

```
port="primary"     => OK
port="top:primary" => REJECT: outlet.port 角色名必须是小写标识符   (实得 "top:primary")
```

两臂各有 6-7 条样本照抄了 `top:xxx`，会在 `validateMacroCall` 阶段被拒
（`B2` 里有 4 条死在这里）。**这是一个 prompt↔宏契约的 bug，不是模型的错。**
它同时污染了两臂的「可执行率」，必须在实验前修掉，否则经验段的效果会被这个噪声吃掉。

---

## 4. 预算：加经验第一个挤掉的不是带子，是 **CAPACITY 段**

### 4.1 数字

`constants.mjs:156-158` + `prompt.mjs:1672`：
`targetChars = min(2800×3.5, 12000) = 9800`。

逐字符扫（`.tmpverify/rt-final.mjs` 同构；E = 加进去的字符数）：

```
E=0      chars 9311  belts 12/37  CAPACITY full  (220 字符)
E>=490   chars 9222  belts 12/37  CAPACITY 降级为 short (131 字符)   <- options 行消失
E>=579   chars 9089  belts 12/37  CAPACITY 整段消失
E>=712   chars 9049  belts 11/37  <- 带子才开始掉
E>=1190  chars 8583  belts  0/37
```

**先死的是 CAPACITY，不是带子。** 因为 `prompt.mjs:1676-1732` 明写：
先用不含 CAPACITY 的 prompt 跑截断循环（保带子），剩下的余量才给 CAPACITY，塞不下就降级/skip。

而 `renderCapacity` 的 `short` 版（`prompt.mjs:1332-1340`）**只留一条 `act:` 行，
full 版的两条 `options` 全没了** —— 而 §1.2 证明模型抄的正是 full 版那两行。

⇒ **加 490 字经验，正好把模型唯一在抄的东西抄走。**

### 4.2 在真实存档上根本不堪一击

`test/fixtures/saves/L4-obs.json`（真实 L4 存档：8 miner / 161 belt / 7 balancer / 1 cutter，
7 条诊断），用 loop 真会用的候选集（`loop.mjs:495-505` 的 `candidatesFor`）：
`["replace_run","insert_machine","connect","trash_unused","extend_line"]`：

```
chars 10236 / target 9800   belts 0/163   CAPACITY 无(dropped-for-budget)   over_token_budget true
再加经验到 E = 1778 字符 ⇒ buildPrompt 抛 PROMPT_OVER_BUDGET
```

`loop.mjs:1747-1760`：抛 `PROMPT_OVER_BUDGET` 后是
`outcome = "halt"; reason = "INTERNAL"` —— **这一轮直接死，不是降级。**

⇒ **在真实存档上，现在这个 prompt 已经没有任何经验的空间。**
capacity 场景「够用」是**夹具小（37 条带子）**，不是系统有余量。

### 4.3 一个更糟的版本

如果把候选宏从 5 个砍到 3 个（`replace_run/insert_machine/connect`），L4 上是
`chars 9774, belts 3/163, CAPACITY 无`。也就是说：**CAPACITY 段在真实存档上从来没出现过。**
CAPACITY 的 A/B 结论全部来自那个 37 条带子的人造夹具。

---

## 5. 场景代表性与方向判断

### 5.1 这个场景是「只有一个正确答案」，而且那个答案物理上做不出来

一条产线、一处瓶颈、一种修法。而 §2.2 证明：**这个场景里「并行加 cutter」用现有宏
根本无法表达**（9 个合法 region 全是串联）。

⇒ 模型 7 次 `precondition_failed` 不是模型笨，**是这个场景里没有干净的位置**。

### 5.2 那「提示提高命中率」说明什么

A2 有 22/23 自己想加 cutter —— 说明**瓶颈识别不是难的部分**，
难的是「怎么在几何上落地」。CAPACITY 并没有让模型更理解产能，
它只是**把「可以加 cutter」这个授权从 RECIPE 的「cutter×1 / Do not add them」手里抢了过来**。

`renderRecipe` 实测输出（§9.3）：

```
⇒ machines this shape needs: miner×1, cutter×1
⇒ it does NOT need: rotater, stacker, painter — no such step appears above. Do not add them.
```

**prompt 里有两条互相抵消的指令**，而模型自己发现了冲突（`B2#1/#2/#3` 都写着
「but capacity says...」）。**任何经验 A/B 都会把这个已有的冲突放大成噪声。**

### 5.3 真实场景

多产线、多瓶颈、资源有限要排序时，「加 cutter」会同时是正确答案和错误答案。
本场景完全测不出这一点。⇒ **不能外推。**

---

## 6. 结论：值得做，但必须先改这四件事

### 必须改（不改则实验无效）

1. **修 `capacityOf` 的串/并联口径**（`assess.mjs:233`）。
   同种机器 `count × rate` 只在**并联**时成立。当前实现把串联也当并联，
   而 §2.3 证明这个场景里唯一能做的动作就是串联。
   **不修这一条，L3 判据会奖励零收益动作，整个实验的主指标失效。**
   最小修法：按「矿机→机器」的连通链算，同一链上同种机器取 `min` 而不是 `sum`。

2. **换主判据**。L3 改成「**目标形状的真实产出增量**」，不是 utilization：
   - 主：`hub.stored_shapes[goal]` 增量（L2 的定义）；
   - 辅：`utilization`，但**必须同时报 `supplyPerSec` 与 `process.capacityPerSec` 的绝对值**；
   - 加一条**反刷分**判据：`utilization` 上升 **且** 目标产出不上升 ⇒ 记负分。

3. **判据必须过宏**。`arms.mjs:judge()` 只看参数文本，把一个 16/23 的假命中算成真命中。
   改成「`resolveRefs` → `validateMacroCall` → 逐条宏 `ok:true` → `planToTxOps`」
   （照 `.tmpverify/rt-faithful.mjs` 的写法）。否则任何经验形态只要教会模型**写**
   `cutter` 这个词就能刷分。

4. **换对照臂**：`B2 vs B2+经验`，不是 `A2 vs A2+经验`（§1.4）。

### 强烈建议

5. **先修 prompt↔宏的端口名契约**（§3.4）。`top:primary` 是 prompt 自己渲染出来的，
   宏却拒。它同时污染两臂，会吃掉经验本该有的效应量。

6. **先修 RECIPE 与 CAPACITY 的冲突**（§5.2）。两段给相反指令，胜负取决于措辞。

7. **场景扩到 ≥3 种**，至少一种「多产线、多瓶颈、修法互相竞争」。
   并且**换一个能并行加 cutter 的地图** —— 否则你测的是「能不能串联放机器」。

8. **预算先重做**（§4）。真实存档上 `belts_shown=0`、CAPACITY 缺席、再加 1778 字就抛异常。
   经验段要么走「压缩现有段落」，要么走「按诊断相关性选段」。

### 可以后做

9. 修 `prompt.mjs:944-967` 的 `toHub` BFS 遇机器就断（`AB-PROMPT-RESULT.md:249-256` 列的必修项）。
   本轮 V2 只是**在夹具层删掉了那两行标记**（`v2.mjs:55-60` 的 `stripMark`），
   **算法本身没修**。换回真实渲染，这个「11/12 标反」的标记就会回来。
10. 改 `EXPERIENCE-SOURCE-FACTS.md` 的 balancer 条目（§9.13）。

---

## 7. 【已自我更正】两条我一开始写错、后来被实测推翻的结论

留着这一节，是因为它们正好是「简化模型替代真实实现」的复发 —— 本项目最大的成本。

### 7.1 「串联的第二台 cutter 会把产品切没」

**错。** 我一开始从 `cutHalf` 的返回值推断「二次切 = 空形状 ⇒ 产出归零」。
实际上游 `item_processor.js:374-382`：

```js
if (definition.isEntirelyEmpty()) { ejectorComp.slots[i].lastItem = null; continue; }
```

**空槽被跳过，产品原样透传。** `cut(RuRu----) = ['', 'RuRu----']`
⇒ right 出口仍然是 `RuRu----`。所以串联 cutter 只是**白占一台**，不毁产品。

这个更正**加强了**结论：串联是「无害但零收益」，正是最容易被判据误判成「好」的形态。

### 7.2 「B2#21 把 cutter 盖在 C1 的输入口上，所以进料断了」

**部分错。** 端口几何实测（`.tmpverify/rt-geom.mjs`）：C1 的接受槽 cell 是 `(4,-17)`，
**不是 `(4,-16)`**。新 cutter 盖住的是 `(4,-16)`（B11 那条带子所在格），
而它自己的 left 出口恰好落在 `(4,-17)` = C1 的接受槽。

⇒ 正确的说法是：**产品进死路（`(5,-17)` = C1 机身），废料喂给 C1**，产出归零。
比「整条断掉」更糟 —— 因为它看起来是通着的。

---

## 8. 猜想（无证据，不进结论）

1. **经验可能在「几何落地」上有用**，而不是「知道该做什么」。本实验里模型 23/23 都想到加 cutter，
   卡住的是「放哪 / region 怎么给」。所以真正有用的经验形态可能是
   「cutter 2×1，left 废料口在 origin 上方一格，region 必须向上多留一格」——
   但那是**几何事实**，属于 (d)，不是 (a)/(b)/(c)。
2. **形态 (c) 模型自复盘最可能负收益**：本仓库宏失败率 14/16，复盘学到的大概率是错的。
3. **形态 (a) 案例库的检索会失效**：现在唯一的检索是 `RETRIEVAL_TABLE`（诊断码→宏）。
   按诊断码检索会退化成静态规则表，(b) 与 (a) 无法区分。

---

## 9. 复现

### 9.1 逐字抄 CAPACITY
```bash
node -e '
const rec=require("./.tmpverify/ab-capacity/results-v2.json");
const b=rec.filter(r=>r.arm==="B2"&&r.parse_ok);
for(const [k,re] of Object.entries({"add 3 cutter":/add(?:ing)?\s+(3|three)\s+cutters?/i,
  "1→4":/1\s*(?:→|->)\s*4/, "⇒2/s":/⇒\s*2\s*\/\s*s/, "72%":/72\s*%/}))
  console.log(k, b.filter(r=>re.test(r.thinking||"")).length+"/"+b.length);'
```

### 9.2 A2 自己提出加 cutter
```bash
node -e '
const rec=require("./.tmpverify/ab-capacity/results-v2.json");
const a=rec.filter(r=>r.arm==="A2"&&r.parse_ok);
console.log(a.filter(r=>/(add|another|more|second|extra)\s+(a\s+)?(second\s+)?cutters?|parallel.{0,20}cutter/i
  .test(r.thinking||"")).length+"/"+a.length);'
```

### 9.3 RECIPE 段原文
```bash
node -e '
const fs=require("fs");(async()=>{
const SC=JSON.parse(fs.readFileSync(".tmpverify/capacity-scenario.json","utf8"));
const pm=await import("./src/agent/loop/prompt.mjs");
const {buildHandles}=await import("./src/agent/loop/handles.mjs");
const {diagnose}=await import("./src/agent/loop.mjs");
const h=buildHandles(SC.obs,SC.items);
const d=diagnose(SC.obs,SC.items,SC.production,null,"RuRu----",h,{});
console.log(pm.buildPrompt({goal:{shape:"RuRu----",level:4},obs:SC.obs,handles:h,diagnoses:d,
  candidates:["replace_run"],lastRound:null,budget:{},production:SC.production}).blocks.s3_recipe);})();'
```

### 9.4 9 个合法 region 全是串联（§2.2）
```bash
node .tmpverify/rt-nine2.mjs
```

### 9.5 串联 cutter 把 utilization 翻倍但零收益（§2.3）
```bash
node .tmpverify/rt-nine2.mjs      # 看 region [3,-16,4,-14] 的 right→4,-16
node -e '
const fs=require("fs");(async()=>{
const SC=JSON.parse(fs.readFileSync(".tmpverify/capacity-scenario.json","utf8"));
const A=await import("./src/agent/assess.mjs");
const ents=SC.obs.entities.filter(e=>![20039,20040].includes(e.uid))
  .concat([{uid:90002,type:"cutter",x:3,y:-15,r:0,variant:"default",rotation_variant:0,code:9},
           {uid:90003,type:"trash",x:3,y:-16,r:0,variant:"default",rotation_variant:0,code:20}]);
const b=A.capacityOf(A.obsForAssess(SC.obs)), g=A.capacityOf(A.obsForAssess({...SC.obs,entities:ents}));
console.log("before util",(b.utilization*100).toFixed(1)+"% proc",b.process.capacityPerSec);
console.log("after  util",(g.utilization*100).toFixed(1)+"% proc",g.process.capacityPerSec);})();'
```

### 9.6 空转 cutter 刷 utilization（§2.4）
```bash
node .tmpverify/rt-gaming3.mjs     # util 27.8% -> 83.3%，两台输入槽悬空的 cutter
```

### 9.7 按 loop 顺序重放（§3.2）
```bash
node .tmpverify/rt-faithful.mjs    # A2: 0 命中 / 3 可执行 ; B2: 16 命中 / 2 可执行
```

### 9.8 B2#21 的真实效果（§3.3）
```bash
node .tmpverify/rt-DEFINITIVE.mjs
node .tmpverify/rt-geom.mjs
```

### 9.9 端口名契约 bug（§3.4）
```bash
node .tmpverify/rt-portbug2.mjs
```

### 9.10 预算扫描（§4）
```bash
node .tmpverify/rt-final.mjs
```

### 9.11 重算 Fisher（§3.2）
```bash
node .tmpverify/rt-correct.mjs
```

### 9.12 二次切割透传（§7.1）
```bash
node -e 'import("./research/ai-player/proto/shape-ops.mjs").then(S=>{
console.log("cut(RuRu----) =",S.cutHalf(S.parse("RuRu----")).map(x=>S.hash(x)));})'
sed -n "374,383p" recon/upstream-full/src/js/game/systems/item_processor.js
```

### 9.13 balancer 到底轮不轮转
`recon/upstream-full/src/js/game/systems/item_processor.js:341-362`：

```js
process_BALANCER(payload) {
    const availableSlots = payload.entity.components.ItemEjector.slots.length;
    ...
    preferredSlot: processorComp.nextOutputSlot++ % availableSlots,
```

`EXPERIENCE-SOURCE-FACTS.md:158-159` 写「先填满左边，左边堵了才走右边 ✅ 真」，
但这行代码是**每发一个货就 `nextOutputSlot++`**，即**严格轮转**。
`getFirstFreeSlot()`（`item_ejector.js:117-125`）只在「preferredSlot 被占」的兜底路径
（`item_processor.js:147-153`）才走到。

⇒ 「secondary 接 trash = 全损」**是错的**，应该是「一半进 trash」。
这条假事实会直接进入 (b) 形态的经验文本。

---

## 10. 诚实边界

1. 所有攻击基于**现有夹具**（`capacity-scenario.json`，37 带子、1 瓶颈）与
   `results-v2.json` 已有的 51 条样本。**没有跑新的 LLM 样本。**
2. §2.4 的「空转 cutter」是**构造出来的**（我按正确几何放、不改别的）。
   它证明判据可被刷，不证明模型一定会刷。但 §3.3 的 `B2#21` 是**模型自己产出的**
   同类结果（产品进死路、utilization 翻倍），所以不是我编的。
3. §2.3 的「真实吞吐 = 0.5/s」是按上游 `isEntirelyEmpty` 透传语义推的，
   **没有跑游戏内模拟**。若有人在实机验证出不同结果，以实机为准。
4. §4.2 的 `E=1778` 用 `in_chars_max` 的余量模拟 system prompt 变长，与真实同构但
   不是逐字节一致（真实现要改 `SYSTEM_PROMPT` 常量）。方向与量级可信。
5. §2.2 的「不可并行」是**在现行宏集合内**的结论。加 `upgrade` 宏、
   或加「沿链取长度恰好的窗口」这类能力后，结论可能变。
6. 本轮 V2 只有 A2/B2 两臂；C/D 是上一轮四臂的，我没有重算它们。
7. 我自己在起草时写错过两条（§7），已按实测更正。**这说明这个仓库里
   「读返回值推断语义」这个动作本身是高风险操作** —— 建议把
   「任何语义断言必须过宏/过模拟器」写进实验纪律。
