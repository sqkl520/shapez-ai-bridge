# P-a0 结果（2026-10-30）

## 交付

| 文件 | 行数 | 测试 |
|---|---|---|
| `src/agent/loop/topology.mjs` | 484 | — |
| `src/agent/loop/structural.mjs` | 565 | — |
| `src/agent/loop/topology.test.mjs` | 441 | 32 ✓ |
| `src/agent/loop/structural.test.mjs` | 493 | 31 ✓ |

全量回归：**2007 条，0 失败**。

## 实测（主线程复跑）

| 存档 | 条数 | 码分布 | tier 分布 |
|---|---|---|---|
| L4 (`RuRu----`) | 7 | DEAD_END×2, BELT_HANDOFF_REJECTED×2, CHAIN_UNFED×3 | t0=2, t1=2, t2=3 |
| L5 (`Cu----Cu`) | 8 | DEAD_END×2, BELT_HANDOFF_REJECTED×3, CHAIN_UNFED×3 | t0=3, t1=2, t2=3 |

**对比改造前**：L4 冷启动只有 1 条（`NO_PRODUCTION`）。现在有 7 条结构事实。

## 五条必要条件的达成情况

| # | 条件 | 状态 |
|---|---|---|
| 1 | 删全部矿机 ⇒ 报原料中断 | **部分**：报了 `CHAIN_UNFED`×3，但**没有** `RAW_MATERIAL_MISSING`（见下） |
| 2 | 删全部 trash ⇒ 报产物无去处 | ✅ L5 有 `WASTE_NO_SINK`；L4 **不该有**（见纠正 4） |
| 3 | L4 ⇒ 报出 x=2/3/4/5 链上的诊断 | ✅ tier0 有 2 条（B129/B130 在链上） |
| 4 | L5 ⇒ 报「产物被当废料丢弃」 | ❌ **未做**（属 P-a 语义层，P-a0 范围外） |
| 5 | `DEAD_END` 真能触发 | ✅ L4/L5 各 2 条（改造前恒 0） |

## 实现 agent 纠正我的三处（全部验证成立）

### 纠正 1：`10024` **应该**被报，我之前说不该

`balancer#10035@(-8,-3)` 的两个输入槽都是 `dir:"bottom"`（从南进）。
`10024@(-9,-3)` 从西边（`right`）过来 ⇒ **确实接不上**。
`debug_items` 的 `boundAcceptor` 也是 `null`。

⇒ 「正确的判据下不该误报 balancer」这个说法**不成立**。它本来就该报。

### 纠正 2：「6 vs 1」这个数字复现不出来

正确规则下 L4 是 **1 vs 13**，不是 6 vs 1。方向对，量级不对。
（我那个 6 大概把 `slotsOf → null` 算成了"拒收"；实现的 `accepts()` 返回 `opaque:true` 并跳过。）

### 纠正 3：footprint 展开不能只特判 hub ★

我以为是 6 条全落在 hub。实测：

```
带子 10032 → hub#10000      @ -1,-2
带子 10051 → balancer#10035 @ -7,-3     ← balancer 2×1 的第二格
带子 10115 → balancer#10083 @ 3,-32     ← 同上
带子 10137 → balancer#10084 @ 4,-24     ← 同上
带子 10151 → balancer#10085 @ 5,-16     ← 同上
带子 10183 → hub#10000      @ 1,-2
```

**只有 2 条在 hub 上，4 条在 2×1 的 balancer 第二格上。**

⇒ footprint 展开**必须对所有多格建筑做**。谁"优化"成 hub 特判，会立刻引入 4 条假死端。

### 纠正 4：L4 删光 trash 不报 `WASTE_NO_SINK` 是**正确的**

L4 唯一那台 cutter 的废料口（left）走一条长链**到达 hub** —— 所以"没有 sink"在 L4 上是假的。
只有 L5 的 `cutter#10902` 左口直指 trash#10901，删光 trash 才真的没 sink。

## 已知边界（P-a0 范围内做不到）

### `RAW_MATERIAL_MISSING` 在 loop 里触发不了

它需要 `opts.recipe`（判断"配方是否需要 mine"），而 `diagnose()` 不接收 recipe。
测试里能触发（测试传了 recipe），loop 里不能。

**这是 P-a0「只做结构层、不碰语义层」的直接后果**，不是缺陷。
P-a（语义层）接上 recipe 注入后自动可用。

### L4 的 x=5 有一个更隐蔽的缺陷

`miner#10082@(5,-8)` **脚下没有矿**（`obs.resources` 里那格是空的），但它喂着 7 条带子。

这是 L4 除"缺 cutter"之外的第二处真缺陷。实现把"贫矿矿机"归成一条诊断（subject 是矿机本身），
而不是逐条带子报（那会吃掉整个 8 条预算）。

## 一个必须记下的教训（我第四次同类错误）

主线程在"入口格判据"和"footprint 范围"上又错了两次。累计：

| # | 错误 |
|---|---|
| 1 | L4/L5 夹具搞混 |
| 2 | `hubReachable` 手工复刻错 |
| 3 | `byCell` 用 origin 级而不是 footprint 级 |
| 4 | 以为 footprint 只为 hub 需要（实际 balancer 2×1 更需要） |

**共同点：都是"用简化模型替代真实实现/真实测量"，而简化模型静默地给出不同答案。**

规律已经很清楚：**凡是要判断几何事实，必须用 footprint 级索引 + 直接 import 真函数**。
