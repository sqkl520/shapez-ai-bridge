# 批判：把「世界死了」当定论之前，先问它是什么时候、因为什么死的

2026-11-23。攻击对象：`.findings/WORLD-IS-DEAD-2026-11-23.md` 与
`.findings/DEADLOCK-CHAIN-2026-11-23.md`。全部离线，只读 `research/ai-plan/runs/`
（575 个 run 目录，567 个有 obs + production）与 `recon/upstream-full/` 的游戏源码。
临时脚本在 `.tmp-critic/`，跑完已删。

## 判决摘要

| 质疑 | 结论 |
|---|---|
| 1 `produced_total` 为空 = 世界不产出吗 | **原结论成立**（并被我加固：排除了 warm-up 与载入预热这两个替代解释） |
| 2 「259 件堵住」与「零产出」的因果方向 | **原结论错误（因果反了）**：259 件不是因，死亡那一刻它还是 162 件 |
| 3 painter#13552 color 槽坐标算错了吗 | **坐标对，但「空格」的表述错**：它长期有带子；且这不是死锁的锚点 |
| 4 「575 个 run 目标形状 0 次产出」是口径问题吗 | **成立**（格式一致，无隐藏写法；但数字口径要改成 508） |
| 5 是不是过度概括 | **是，有一处**：真实死因是一个具体动作，不是「L12 这关结构上死」 |

**最重要的单条发现**：真正的断裂点可以精确定位到
`r-20261115121125-264d` 第 3 轮的一次 `insert_machine`，
它在 `(-3,-8)` 放了一个垃圾桶，**同时把邻居 `belt#14953` 的 `rotation_variant`
从 2 改写成 0**（一条左→下的转角带被掰成了左→右的直带）。
dt = 2 游戏秒后，painter 的颜料线清零，`produced_total` 从 10 个键变成 `{}`。
两份结论文件里一个字都没有这一次动作。

---

## 质疑 1：`produced_total` 为空，真的等于「世界不产出」吗

**我的核查方法**

```
node .tmp-critic/scan1.mjs            # 全部 567 份 production-last.json
node .tmp-critic/q1h.mjs              # 按 tick 预算分桶（warm-up 检验）
node .tmp-critic/q21.mjs              # L12 且推进 ≥12000 tick（≥200 游戏秒）
node .tmp-critic/q20.mjs              # 逐时间片检验（不是只看总和）
node .tmp-critic/final.mjs            # 与 productionAnalytics 完全无关的旁证
node .tmp-critic/q18.mjs              # 反例搜索：产出为空但 hub 库存却在涨
```

**结果**

```
567 份快照：slices_returned === 0 的 **0 份**（没有一份是"没数据"）
             produced_total 为空 517（91.2%）
             零产出 且 belts 非空 516（91.0%）

按推进 tick 分桶（L12）：
  0 tick          n=182  empty=181
  2400..4799      n= 66  empty= 62
  4800..7199      n= 57  empty= 55
  ≥7200           n=203  empty=202
  ≥12000 (≥200 游戏秒)  n=68  empty=68   ← warm-up 解释被彻底排除

逐时间片（608 个片，每片 10 游戏秒）：
  500 份快照 6 个片全为 0；只有 8 份有任意非零片，且全是 11-15/11-16 那批活着的。
```

旁证（完全不经过 `productionAnalytics`）：`hub.stored_shapes` 在死亡后 503 个快照里
只出现过 3 个取值 —— `145707 / 145709 / 145719`，横跨 **154.9 游戏小时**。
库存不涨，是独立于 analytics 的第二条证据。

反例搜索只找到 3 处「产出为空但库存涨了」，最大的一次 +49，
全部落在同一次 run 内（`production` 是 60 秒窗口，`obs` 是瞬时 —— 时窗错位，不是矛盾）。

还有一个我没想到的强证据：仓库自己的 `src/agent/loop/health.mjs:727` 注释里，
**2026-11-15 夜**就记过一笔：「`production()` 的 `produced_total` 恒为空
（拉长窗口、加切片、甚至重启游戏重载存档之后仍然空）」。这直接反驳了 warm-up 假说 ——
我不是第一个到这里的人，只是没人把它和「世界真的死了」连起来。

**结论：原结论成立。** `produced_total` 为空在这个存档上确实等于「世界不产出」，
不是测量假象。质疑 1 攻击失败。

⚠️ 但有一条边界必须写进结论：`observeProduction` 读的是
`pa.history[key].slice(-6)`，而 `productionAnalytics` **不进存档**
（`savegame_serializer` 里没有任何 `ProductionAnalytics` 注册；它只在
`core.js:127` 与 `new ProductionAnalytics(root)` 一起被创建，构造时塞满
`statisticsGraphSlices=100` 个空片）。严格说，「载入后前 60 游戏秒的窗口」
在结构上不可信 —— 但上面 ≥12000 tick 的 68 个 run 已经把这条出口堵死了。

---

## 质疑 2：「259 件堵住」和「零产出」的因果是不是反了

**我的核查方法**

```
node .tmp-critic/verify.mjs     # path8 数量随时间的完整轨迹
node .tmp-critic/q2d.mjs        # path8 首次到达 259 的时刻
node .tmp-critic/q2f.mjs        # 同一 world_hash 内 pos 是否漂移（A/B 判据）
node .tmp-critic/q2i.mjs        # 死亡前那份"活着"的快照里 path8 长什么样
node .tmp-critic/q2l.mjs        # path8 满载 vs 仍在产出的交叉表
```

**结果**

```
死亡那一刻 = r-20261115121951-39ea, tick 556784（11-15 12:19:51）
  path8: 162 件 / 102 格

path8 首次到达 259 件 = r-20261116154241-6124, tick 660986（11-16 15:42）
  → 259 比死亡晚了 104202 游戏秒 = 28.9 游戏小时

死亡之前（11-15 11:13，世界还在产出，10 个形状键 + delivered 14 件）：
  path8 = 162 件 / 102 格 = 159%（每格 1.59 件，标称 1/0.63 = 1.587）
  → 那时 path8 **已经满载**，而世界活得很好

交叉表：path8 ≥99% 格的快照 461 个，其中仍有非零产出的 7 个
  → 「满载」与「产出」并不互斥
```

**这是原结论最严重的硬伤。** 259 件出现在死亡后 28.9 游戏小时，不可能是死因；
它甚至是用**我们自己后来的动作**（把 path8 从 102 格拉长到 165 格）攒出来的。
原文件 §三 说「这是一条从 hub 一路堵到矿机的反向淤积」，方向对，
但把它当成「根因」是把**结果**当成了**原因**。

对照 §九 自己也发现了这一点（「满载 ≠ 死亡，50 个活着的快照里有 30 个也全堵」），
却在 §十 又写回「一条 259 件/165 格的堵带」是根因。**结论文件内部自相矛盾。**

**结论：原结论错误，因果反了。** 259 件是果，不是因。真正的因在别处（见质疑 3）。

---

## 质疑 3：`painter#13552` 的 color 槽真的是「空格」吗

**我的核查方法**

```
node -e "import('./src/agent/verify_runtime.mjs').then(m=>console.log(m.slotsOf('painter','default',-5,14,90)))"
node .tmp-critic/q3.mjs     # 全历史里 painter#13552 与 (-4,15) 的状态
node .tmp-critic/q3b.mjs    # (-4,15) 有实体的全部 L12 快照
node .tmp-critic/q3c.mjs    # (-4,15) 上有没有货
node .tmp-critic/q9.mjs     # belt#14953 的 rv 全历史
node .tmp-critic/q12.mjs    # 8b63 → 264d / 264d → 39ea 的实体级 diff
```

**结果**

坐标**算对了**。`slotsOf('painter','default',-5,14,90)` 给出：

```
inputs[color] = { slot:[-5,15], dir:"right", cell:[-4,15] }
```

与两份结论文件一致。而且 `-4,15` 在 `r-20261123151728-52a3` 里确实是空地
（`obs-last.json` 的 749 个实体里没有它）。**几何没错。**

但「color 槽是空格」这个表述有严重问题 —— 它**不是一直空**：

```
L12 共 508 个快照，(-4,15) 有实体的 23 个，空的 485 个。
23 个里有 22 个是 belt#14976（r=270, rv=0），1 个是 belt#17649。

其中 5 个快照那条带上还装着货：
  11-15 11:13 / 11:16 / 11:18 / 11:57 / 12:11  →  green @ pos 22.15~24.56
  而那 5 份快照的 produced_total 是 10 个键（世界在产出）
```

也就是说：**颜料线通着的那些快照，世界是活的；line 断掉之后，世界死了。**
「color 槽空」是**同一次断裂的下游症状**，不是独立的锚点。

真正的断裂点在这里（`.tmp-critic/q12.mjs` 的实体级 diff）：

```
r-20261115115724-8b63  (tick 555547)  →  r-20261115121125-264d (tick 556385)
  改动（同 uid，不同几何）只有两处：
    belt#14953 @(-3,-7):  r90 rv2  →  r90 rv0
    belt#15019 @(-2,-7):  r180 rv0 →  r90 rv2

按 src/ai/belt-rules.mjs：
  rv2 @ r90 → entry=left, exit=bottom   （左进，向下转，接住下一格 (-3,-6)）
  rv0 @ r90 → entry=left, exit=right    （左进，向右直走，接 (-2,-7)）

而 264d 那一轮只做了一件事：
  insert_machine { at: $ref B109, machine: "trash" }
  tx_plan: ops=2, destroys=[15021]（(-3,-8) 的那一格带子）, placements=1
```

**`insert_machine` 只声明了 1 个 destroy，却改写了 2 个邻居的 rv。**
`belt.js:165` 的 `updateSurroundingBeltPlacement` 会在 `entityAdded` /
`entityDestroyed` 上按邻居重算 `rotation`/`rotationVariant`，
唯一豁免是 `root.immutableOperationRunning === true`。
而 `tx` 确实包了 `runGuarded`（`shapez-ai-bridge.js:3792`）……

⚠️ 这里我停下来，说清我能证到哪：**我证到的是「rv 被改了、改完世界就死了」；
我没能证到「是 tx 的 immutable 没生效」还是「宏自己算错了 rv」。**
两个候选机制都在源码里存在，需要真机插桩才能分辨：

- 候选 A：`tx` 的 `runGuarded` 外层没问题，但 `repairBeltPaths`
  （`shapez-ai-bridge.js:3846`，`beltNetworkHealth` 报 problem 时触发
  `recomputeAllBeltPaths()`）**在 immutable 块之外**执行；
- 候选 B：`insert_machine` 自己在 `placeOne` 里算错了邻居的 rv。

无论哪条，结论都指向同一处：**这一轮改了地图却没有把「改了哪些已有实体」报出来。**
`tx` 返回里明明有 `diff.modified`（`diffSnapshots` 里就有），
而 `loop.mjs:5015` 落盘时只留了：

```js
diff: { added: (...).length, removed: (...).length }
```

**`modified` 被整个丢掉了。** 这和记忆里那条 `computed-but-never-delivered`
是同一个病：算出来了，没送到。模型下一轮看到的 `diff` 是 `added:1, removed:1`，
完全看不出「顺手掰弯了一条别人的转角带」。

**结论：坐标对，但「空格」是本末倒置的描述；死锁链的锚点应该是 belt#14953 的 rv 被改写，
不是 painter 的 color 槽。原结论需要修正。**

---

## 质疑 4：「575 个 run 目标形状 0 次产出」是不是口径问题

**我的核查方法**

```
node .tmp-critic/q4c.mjs   # 全量 key 集合 + 目标 run 计数
node -e "..."              # recon/upstream-full/src/js/game/shape_definition.js:266 getHash()
```

**结果**

```
产出 key 全集（18 个）：
  ------Cu | ----CgCg | ----CuCu | ----RuRu | ----SuSu | CgScScCg | CrCrCrCr |
  Cu------ | Cu----Cu | CuCu---- | CuCuCuCu | RbRb---- | RuRu---- | RuRuRuRu |
  ScSc---- | ScScCgCg | SuSu---- | SuSuSuSu

含冒号的 key：**0 个**（produced / delivered / hub.stored_shapes 三处都是）

目标 run 数：508（不是 575 —— 575 是 run 目录总数，其中 8 个没有 obs）
目标 run 中含任意 "Cb" 的：0
目标 run 中含冒号 key 的：0
目标 run 中含中间层 CbCbCbRb 的：0
```

格式口径**没问题**。`ShapeDefinition.getHash()`（`shape_definition.js:266-284`）
是逐层拼接、层间用 `":"` 分隔，所以两层形状的 key 必然是 `A:B`。
而 hub 里 `CbCbCbCb: 6`（单层）确实存在 —— 说明蓝圆颜料/形状原料进过 hub，
只是从来没有被叠成两层。

所以 **「目标形状 0 次产出」成立，而且比原结论更硬**：连中间层
`CbCbCbRb` 都一次没出现过。

**结论：原结论成立。** 唯一要修的是数字：是 **508** 个 run，不是 575。
（575 是目录总数；8 个目录没有 `obs-last.json`。）

---

## 质疑 5：这个结论的实际后果是什么 —— 是不是过度概括

**我的核查方法**

```
node .tmp-critic/q17.mjs   # 按日期 × 关卡的 run 分布
node .tmp-critic/q24.mjs   # 零产出 run 被判成 cleanup/positive/constructive 的数量
node .tmp-critic/q25.mjs   # 其中"理由是 items_on_belts 涨了"的数量
git log --format='%ad %h %s' --date=short -S "<feature>" -- src/agent/loop/
```

**结果**

```
按关卡：L9 58 个快照（16 空）；L12 508 个快照（500 空）。
        但 L9 全部在 11-13 之前，L12 全部在 11-15 之后 —— 两者不在同一个世界。
        原文件 §八 拿它们对比，前提是"同一个存档"，这条**没被验证过**：
        `run_start` 里 575 个 run 的 `world` 字段**全是 null**（没有一个记了 world id）。

零产出 run 被判为 cleanup / positive / constructive 的：288（其中 cleanup 274）
其中理由是「▲ items_on_belts」的：**221**
```

这一条最锋利。`health.mjs:384`：

```js
const GOOD_UP = new Set(["delivered", "stored_goal", "belts_reaching_hub",
                         "items_on_belts", "reach_pct"]);
```

**`items_on_belts` 变大被算成「改善」。** 而在一个堵死的世界里，
货**只会**往带子上堆 —— 于是「越堵越干净」。
221 个零产出的 run 就是这样被判成 `cleanup` 的，
模型收到的 `## LAST STEP` 是「GOOD — the world got cleaner」。

这批数字里，`r-20261115121951-39ea`（正是产出归零那一轮）的收尾判定就是：

```
净效果: cleanup（清理（改善但不是交货）） — 带上的货 350→362
```

**世界在这一轮死了，评分给的是 GOOD。** 这是一个可复现、可量化的评分缺陷，
比「世界死了」这个事实本身更值得先修。

至于「过度概括」：**是，有一处。**
原文件把它写成「L12 这一关在结构上已经堵死」，
但证据显示的是一个**具体动作**（`r-20261115121125-264d` r3 的 `insert_machine`）
在 2 游戏秒内把唯一还活着的颜料线掰断了。这不是「关卡结构问题」，
是「我们的一个宏静默改写了邻居、并且没报告」。
两者的修法完全不同：前者要重做这一关，后者要修 `diff.modified` 的投递。

另一个必须自己承认的边界：`7c93b3dd` 这个实验存档死了，
**不能推出「玩家真实存档也会有这个问题」**。恰恰相反 ——
改动是**我们自己**的 agent 做出来的，真实玩家存档里不会有这个动作。
把「实验存档被我们自己改死」写成「这个项目的世界是死的」，是过度概括。

**结论：原结论需要修正为** ——
「L12 的实验存档从 2026-11-15 12:19 起不产出；
根因是 `r-20261115121125-264d` 第 3 轮的一次 `insert_machine`
把邻居 `belt#14953` 的 rv 从 2 改写成 0，掰断颜料线；
`tx` 的 `diff.modified` 没有投递给模型，所以这一步无人知晓；
而 `health.mjs` 把「货堆积」算作改善，给这一轮打了 GOOD。」

---

## 我攻击失败的、以及我顺手加固的

- 质疑 1 和 4 我打不动。相反，我又加了两条独立佐证
  （`slices_returned` 无一为 0；hub 库存在 154.9 游戏小时里只变了 12）。
- §三 的 78.3%、§九 的 30/50、§一 的 91.2% —— 三个百分比我逐条复算，**全部对得上**。
- `WORLD_FROZEN` 的判据（`semantic.mjs:3547` 三条）逻辑上没问题，
  但它的 `observed` 文案把 259 件当成因，建议连同这次因果修正一起改。

## 建议的动作（按价值排序）

1. **修 `loop.mjs:5015`：把 `tx.diff.modified` 投递出去**（至少给 uid + 改前/改后的
   `r/rv/code`）。这是 `computed-but-never-delivered` 的又一例，
   而且它直接掩盖了一次真实的世界损坏。
2. **修 `health.mjs:384`：`items_on_belts` 不能单向算 GOOD_UP。**
   在「零产出」上下文里，货量上涨是**堵塞**的同义词。至少应在
   `produced === 0` 时把它降级为「不判方向」。
   这一条影响 221 个已归档 run 的评分。
3. **查 `insert_machine` / `repairBeltPaths` 谁在 immutable 之外改了邻居 rv。**
   候选路径已给出，需要真机插桩分辨（不能只靠读源码 ——
   记忆里 `never-write-code-against-imagined-schema` 已经栽过一次）。
4. 修 `DEADLOCK-CHAIN` 与 `WORLD-IS-DEAD` 两份文件的因果表述，
   把「259 件是根因」改成「259 件是死亡 28.9 小时后攒出来的结果」。
