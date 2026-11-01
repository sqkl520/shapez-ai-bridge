# Prompt 重建 —— 工作包拆解（主线程整理）

> 2026-11-02。规划 agent 因 API 中断未完成拆解，但它留下的 35 个探测脚本把关键事实全测出来了。
> 本文基于**实测数据**整理。每个包由独立 agent 执行。

---

## 已实测的事实（全部可复现）

### 三个 prompt 硬伤——全部证实

| # | 事实 | 证据 |
|---|---|---|
| 1 | **B34 在句柄表里，但渲染时被挤掉** | `B34 exists in table? true` / `B34 in rendered belts? false` |
| 2 | **PRODUCTION 段永远 unavailable** | `renderProduction(obs)` 读 `obs.production`，而 loop 传的是 `ob.obs`（production 是独立字段） |
| 3 | **规则编号乱序** | `1 2 3 4 5 11 12 6 7 8 9 10` |

### 第 4 个硬伤：prompt 预算超了，带子显示 0 条

```
tokensMax=2800 (chars 9800):  chars=10624  belts_shown=0/163     ← 超预算
tokensMax=3600 (chars 12600): chars=11371  belts_shown=12/163
tokensMax=4500:               chars=11371  belts_shown=12/163    ← 封顶 12
tokensMax=6000:               chars=11371  belts_shown=12/163    ← 加预算也不涨
```

**在真实存档（163 条带子）上，默认预算下一条带子都显示不出来。** 只有 12 条是硬上限。

### 第 5 个硬伤：`insert_machine` 不支持 balancer

```
"balancer" -> unsupported_building: balancer/default 不在本宏支持矩阵
```

模型即使想用 balancer 分流，宏也做不了。

### 产能真相（这是用户「有快捷方法却没用」的答案）

L4 存档：`belt:1 miner:1 processors:0 painting:0`

| 项 | 值 | 算法 |
|---|---|---|
| 带子 | **3.0 items/s** | `2 × 1.5` |
| 矿机（单台） | **0.60 items/s** | `0.4 × 1.5` |
| 3 台矿机供给 | **1.80 items/s** | |
| 单台 cutter 消费 | **0.50 items/s** | `2 × processors(1) × 1/4` |
| **产能利用率** | **28%** | 0.5 / 1.8 |

**72% 的矿机产出堵住了。** 两个解法模型一个都没提：
1. 加 cutter：3 台 ⇒ 1.5/s，到 70 个只要 47 秒（现在 140 秒）
2. 升 processors：tier2 要 `RuRu----×600`（正是当前目标），升完 0.75/s

而 **`src/agent/assess.mjs` 已经能算出这些**（`upgradeGaps` / `throughput`），
但那是老 agent（`play.mjs`）用的，**loop 完全没接**。

### 布局质量（第一个可量化的「丑」）

```
belts 34  machines 7  hub 1
corners(rv!=0) 7
longestSingleBeltRow 1  longestSingleBeltCol 0
belt bbox [5, 14]
miner->hub manhattan: [8, 9, 10]   合计 27
actual belt cells: 34
```

**绕路率 = 34 / 27 = 1.26** —— 只有 26% 的绕路，其实不算太丑。

真正的浪费在**产能利用率 28%**，不在几何。

---

## 工作包

### 波 1：修观察面（用户说「立刻做」，全部离线）

#### P1 —— 句柄表不再漏掉诊断点名的实体

**问题**：`pickBelts`（`prompt.mjs:574-607`）先 push `byGoal`，填满 12 个名额后
`referenced`（诊断点名）一个都进不来。表头统计 `referenced.length=2` 但实际渲染 0 条。

**要做的**：
- `referenced` 必须有**保底名额**（比如至少 min(referenced.length, 3) 条）
- 表头数字必须与实际渲染一致（现在是在撒谎）
- 加测试：诊断点名 N 条带子 ⇒ 渲染里必须至少出现 min(N,保底) 条

**判据**：用真实半成品世界的 obs，`B34` 必须出现在 BELTS 区。

#### P2 —— 把 production 接进 prompt

**问题**：`renderProduction(obs)` 读 `obs.production`，但它是 `observeOnce` 的独立字段。

**要做的**：`loop.mjs` 传给 `buildPrompt` 时注入 production（改签名或塞进 obs，
你判断哪个更干净）。`renderProduction` 相应调整。

**判据**：prompt 里 PRODUCTION 段显示真实数字，不再是 unavailable。

#### P3 —— 规则重排 + 消除矛盾

**要做的**：
- 编号连续（1..N）
- 规则 10（「prefer converting that run」）与诊断「cutter fits at 0 place(s)」的矛盾要解
  —— 建议：把「没地方放」这个事实做成**诊断的一部分**，让规则 10 明确写
  「若诊断说 fits at 0 place(s) 且 run 不能改造，则考虑 remove_run + 重建」

#### P4 —— prompt 预算与带子显示

**要做的**：默认预算下 `belts_shown` 不能是 0。要么提预算，要么压缩其它段
（MACHINES 段很占地方）。**必须保证诊断点名的实体永远显示。**

---

### 波 2：让模型看见「产能」（这是「质量」的核心）

#### P5 —— 接上产能与升级分析

**要做的**：
- 复用 `src/agent/assess.mjs` 的 `upgradeGaps` + `throughput`（先核对准确性）
- 在 prompt 里加一段 `## CAPACITY`：
  ```
  供给 1.80/s（3 矿机×0.60）| 处理能力 0.50/s（1 cutter）| 利用率 28%
  瓶颈: cutter。两条路：加 cutter（3 台→1.5/s）或升 processors（+0.5 → 0.75/s）
  可升级: processors tier2 需 RuRu----×600，当前 45
  ```
- **关键**：这不只是「告诉模型」，还要让它知道**哪个更划算**

**判据**：prompt 里能读出「瓶颈在哪、怎么解、代价多少」。

#### P6 —— 让 `insert_machine` 支持 balancer

**问题**：`unsupported_building: balancer/default 不在本宏支持矩阵`

**要做的**：扩 `SUPPORTED_BUILDINGS`。注意 balancer 是 2×1，footprint 逻辑要覆盖。

---

### 波 3：经验形态 A/B（用户要求「都试试」）

#### P7 —— 四种形态的公平对比

用户要求的四种：
- (a) 案例库
- (b) 手写玩法心得
- (c) 模型自己复盘
- (d) 其它

**必须先定义「怎么算好」**：
- 修好没（现在已能做到）
- **产能利用率**（P5 引入）
- **绕路率**（belt cells / manhattan sum）
- **交互轮数**（越少越好）

**用同一批场景跑 A/B，样本数 ≥10**，否则结论无效。

---

### 波 4：红队

#### P8 —— 预判这次改造会在哪骗人

重点：
- prompt 越长越糟（模型注意力被稀释）
- 质量指标被刷分而不是真变好
- 案例库学到错的经验
- A/B 样本太少结论无效

---

## 优先级

用户说 Q3「立刻做」= 修观察面。所以 **P1-P4 先行**，P5-P6 紧随。

P7（经验 A/B）是用户最关心的方向，但**必须在 P1-P6 之后**——
否则测的是「在残缺观察面上的经验积累」，结论不可信。

## 我的判断

用户说的「低质量」，我拆成三层：

1. **看不见**（P1-P4）—— 诊断点名的实体没显示、产量看不见、规则矛盾
2. **不会想**（P5-P6）—— 不知道有升级、不知道瓶颈在哪、想用 balancer 但宏不支持
3. **没经验**（P7）—— 前三层修好之后，经验积累才有意义

**P1-P2 是「让模型发挥现有能力」，P5 是「给它新能力」，P7 才是「提升上限」。**
