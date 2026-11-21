# L12 交付恒为 0 —— 调查结论

采集：2026-11-21 05:36–06:59，存档 `7c93b3dd`（seed 60908，L12，hub_level 12），全程只读。
方法：6 个 Agent 并行（执行×3 / 红队 / 检索 / 验证），A 与 D 两份独立报告交叉验证。

---

## 一句话结论

**不是「货到了 hub 没入账」，是「一件货都没到 hub」。**

`belts_reaching_hub = 390 (56%)` 这个数是**下行通路数**，它只回答「假设这条带上有货，
能不能顺着推到 hub」，完全不看：这条带有没有货、上游有没有源头、中间机器在不在跑。

真实可交付带子数 = **0**。

---

## 真正的死锁链（A 报告，已交叉验证）

唯一有产能的线，死在一台**只有单路进料**的 stacker 前：

```
painter#13552@(-5,14)   color 槽 approach (-4,15) 是空格  ← 断点
        ↓ 不喷漆
belt#14977 → 14978..14992（16 格竖列）  全空
        ↓
stacker#14684@(-2,5)    两路进料，只来了一路（上路 ScSc---- 顶满）
        ↓ 攒不满 2 件 → 不处理 → 不吐货
rotater#14685 → belt#15000@(-2,2) → hub 入口#2   ← 拓扑完美的通路，永远空着
        ↓ 反过来
上游 path 8（165 格）被 259 件货塞到 1.57 件/格（理论满 1.59）
        ↓
miner#16204 出料口堵死，ejector progress=1.0
```

**19 个 ejector 全部 `progress = 1.0`**（独立复核确认，A 说 18/19，实际 19/19）。

---

## 六条叠加原因

| # | 原因 | 数据 |
|---|---|---|
| ① | 一半以上的货物理上进不了 hub | 376 件里 **218 件是颜料**，hub 16 个入口全 `filter:"shape"` |
| ② | 剩下的形状一件都不是目标 | `ScSc----` / `----CuCu` 等中间品，hub 照收但按自己的哈希入账 |
| ③ | 全图从没造出过任何 2 层形状 | 库存 22 个键，**没有一个含 `:`**；目标键不存在 |
| ④ | 主带压到理论容量 | `path8` 98.9%、`path20` 99.7%；满带时推进量恒为 0 |
| ⑤ | ejector 全卡死，把上游产出也掐死 | 19/19 progress=1 → `itemProduced` 不触发 → **1000 秒零产出** |
| ⑥ | 载货主带都不通 hub | 末端贴 hub 的 3 条带**全空**；`path20` 的 `boundAcceptor = null` |

**六条里没有一条需要 mod/桥出 bug。** `delivered=0` 是这台工厂当前状态的正确答案。

---

## 三个方法论陷阱（比结论更重要）

### 陷阱一：三重同源读数当成了三重印证

我把这三条当成互相印证的证据：

- `production.delivered_total` 为空
- hub 存量 `145709 → 145709`
- 目标 `0/1000`

实际上后两条**都是 `hubGoals.storedShapes` 这一个数字**——
L12 不是 throughput-only 关卡（`levels.js:248-254`），`getCurrentGoalDelivered()`
直接返回 `storedShapes[goalHash]`（`hub_goals.js:171-182`）。
而 `production.stored_delta` 也是 `storedShapes` 的拷贝（`production_analytics.js:67-79`）。

**同一个数念了三遍。** 真正独立的只有 `produced_slices` / `delivered_slices`。

### 陷阱二：看到局部在动，就以为整体在流

我说「带上有 375 件货在流」。独立实测（15 秒游戏时间）：

```
T0 总件数=375   T1 总件数=375
新增 0  减少 0   7 条路径里 5 条零位移
```

45 秒探针：**376 件里只有 8 件 pos 变化，0 件换格**。
那 8 件在 `path0` / `path15` 上——**两条往垃圾站丢废料的线**。

### 陷阱三：类型口径是空转的

`belts_deliverable` 与 `belts_reaching_hub` 在本世界上**完全相同（都是 390）**，
给人「类型问题已排除」的错觉。实际它只剪「直接喂 hub 且末端是颜料」的边，
而本世界那 5 条直接喂料带**全是空的**，所以 `badFeeders = 0`。
真正该被扣掉的是「末端是颜料、且颜料根本进不了 mixer」的 77 条，判据不覆盖。

---

## 189 条断口只集中在 3 处

681 处带子→带子交接，**666 正确 / 15 错**，其中 3 处致命、吞掉全部 189 条：

| 断口 | 上游带（出口） | 下游带（入口） | 影响 |
|---|---|---|---|
| A | `#17586@(29,-50)` exit=right | `#17258@(28,-50)` entry=right | **81 条** |
| B | `#16477@(81,-2)` exit=bottom | `#16451@(80,-2)` entry=right | **79 条** |
| C | `#16401@(30,-2)` exit=left | `#16162@(30,-1)` entry=top | **29 条** |

三处都是 T 形交接。A 那条是沿 hub 西侧 `x=-3` 铺到底再向东的 81 格长链——
**它只是从 hub 旁边经过**，却在最远端断掉，`flowReachable` 仍把整条算成「到 hub」。

---

## 16 个入口的真实状态

**正确喂料 5 / 朝向不对 1 / 垃圾站占位 3 / 机器不指向 1 / 空 6**

那 5 条「接线正确」的入口带，**0 条有货**，其中 4 条上游本身是死的。

顺带一个真实布局缺陷：`(0,-3)`、`(1,-3)`、`(2,1)` 三个 hub 入口门口压着垃圾桶。

---

## 如果要改，改什么

不建议改 `belts_reaching_hub` 的既有语义（`health.mjs:127` 注明多处依赖）。
缺的是一个**「当前真的在交付路径上」**的度量，三条判据同时满足：

1. 本带下游严格 `accepts` 通到 hub（已有）
2. 上游逐跳 `accepts` 通到一个**非 trash** 的机器（本轮 390 → 1）
3. 途经机器**当前不在停摆**（出口有货 / ejector 非 progress=1 / 两路都有料）

按这套口径，本世界真实可交付 = **0**，对得上 `delivered_total: {}`。

---

## 关键源码位置

| 事实 | 位置 |
|---|---|
| 16 个入口全 `filter:"shape"` | `hub.js:79-82` |
| 颜料被类型闸挡掉 | `item_acceptor.js:83-86`, `color_item.js:27-29` |
| `goal.delivered` = `storedShapes[goalHash]`（同源） | `hub_goals.js:171-182` |
| stored 切片 = storedShapes 拷贝（非独立） | `production_analytics.js:67-79` |
| `produced` 只在矿机/加工机触发 | `miner.js:77`, `item_processor.js:318` |
| 带满即推进量 0 | `belt_path.js:1130-1200` |
| ejector 卡 progress=1 | `item_ejector.js:163-190` |
| stacker 两路进料 | `stacker.js:60` `inputsPerCharge: 2` |
| `flowReachable` 每跳验 accepts | `topology.mjs:546-656` |
| `belts_reaching_hub` 不传 itemsDoc | `health.mjs:101-112` |
