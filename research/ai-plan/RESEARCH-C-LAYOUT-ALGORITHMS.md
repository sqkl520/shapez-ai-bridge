# RESEARCH-C：布局算法（现成解法调研）

> 状态：完成
> 基线：**空地 9/12，带真实世界（181 实体）0/4**（`COMPILER-REALITY-CHECK.md`，2026-10-28 实测；任务书里的"3/6"是更早一轮口径，已过期）
> 证据标记：【实测】读了源码/跑了命令；【文献】有一手 URL；【推断】由已知性质推出
> **注**：本文件曾有一版并行产出，本版合并并修正了其中三处事实错误（见 §0 末）。

---

## 0. 先纠正三个前提

调研前必须先说清三件事，否则会推荐已经做过的东西：

**（1）这个方向已经调研过，且结论已落地。** `research/ai-player/routing-prior-art.md`（585 行）是上一轮对同一问题的调研，选型**已经实现**：`src/ai/compiler/lane.mjs:348 leftEdge()` 就是 left-edge 区间着色，`place.mjs:565` 引用它的 27405 例穷举结论。所以"该用 left-edge / channel routing"不是建议，是现状。

**（2）失败不是因为没做 track 分配。** `L4-COMPILER-DIAGNOSIS.md:215` 的逐格核对：hub 周围 16 个入口里**只有 3 个被旧实体真正挡住**（全在顶排），其余 13 个物理全空却全部报 `column-conflict`。空地图上同样失败。所以 V6 不是轨道不够，**是路由器的几何空间被自己限制死了**（只允许"竖直—横向—竖直"Z 形，横段不许进别的列）。

**（3）真正的缺口是"回边"。** 【实测】`route.mjs:389 routeAll()` 按 `lane.geoms` 固定顺序逐条铺，失败记 failure 后 `continue`，**没有 rip-up、没有重排、没有重试**。`grid.mjs:484` 的 `Grid.clone()`（注释写着"P3 试放置回溯用"）**建好了却从未被接线**（全仓只有测试 `grid.mjs:635` 调用一次）。

一句话：**三类失败不是三个 bug，是"全局决策层"（执行顺序 + 冲突消解）整层缺失——入口分配其实已有（见 §2c），缺的是前两者，所有全局决策都是流水线硬编码的副作用。**

（并行版本的三处错误：①称 left-edge 尚未使用，实际 `lane.mjs:348 leftEdge()` 已在跑；②称"未找到 Factorio 蓝图生成算法文献"，实际有 arXiv:2310.01505；③未引用仓库内 585 行 prior-art，导致重复调研。本版还修正了它自己的第四处错误：把 hub 入口当最大缺口，实测是 1×16 且已排序试路由。）

---

## 1. 现成解法清单

| 解法 / 项目 | 解决什么 | 能否用 | 来源 |
|---|---|---|---|
| **Left-edge 区间着色**（Hashimoto & Stevens 1971） | 多 net 共享轨道 | **已在用**，27405 例穷举达色数最优 | 无一手 URL（1971 期刊，arXiv 零命中【实测】）；实现 `lane.mjs:348` |
| **Dogleg channel routing** | 单 net 需换轨 | **能用，未用** | https://www.doc88.com/p-9415259705467.html |
| **Terminal / pin assignment** | "哪个 pin 给哪条 net" | **我们不需要**（1×16，见 §2c） | https://research.ibm.com/publications/optimal-wiring-of-movable-terminals |
| **Rip-up & reroute（PathFinder）** | 顺序贪心造成的自阻塞 | **能用，核心缺口** | 无 arXiv 一手源【实测：`all:"switchbox routing"` 0 命中】 |
| **Escape routing（BGA 逃逸）** | 引脚密集一圈各自逃出 | **形状最像，可借鉴**【推断】 | 无一手 URL（PCB 领域常识） |
| **Factorio 蓝图 CP 建模** | 网格工厂 → 约束模型 | **只抄建模，不跑求解器** | https://arxiv.org/abs/2310.01505 |
| **Factorio Learning Environment** | LLM 的空间推理极限 | 只用结论：LLM "无法有效运作" | https://arxiv.org/abs/2503.09617 |
| **verilog2factorio `matrix`** | first-fit 区间划分 = channel router | **能用（已参考）** | https://github.com/Redcrafter/verilog2factorio |
| **Shapez2-MIP-Router** | 网格 + 多 net + 每格一实体，与我们同构 | **不能跑求解器；只抄 A1~A11 约束** | https://github.com/jiahao-0204/Shapez2-MIP-Router |
| **shapez-auto（Go 685 行）** | 候选位环 + 带朝向 A* + trial/commit | **能抄骨架**（"竖直走廊预占"） | https://github.com/Songxwn/shapez-auto |
| **MAPF / CBS** | 多个体在共享图互不碰撞 | **只借"冲突驱动重解"框架** | https://arxiv.org/abs/2505.19219 |
| **RCPSP（资源受限调度）** | "做事顺序决定可行性" | **框架正对（§2a），算法不用** | https://arxiv.org/abs/2502.18330 |
| **有向 k 顶点不相交路径** | 多流互不共格 | 理论正解但 NP-hard；平面情形 FPT | https://arxiv.org/abs/1304.4207 |
| **Unsplittable flow** | 一条流不可分叉 | 说明正确问题类 | https://arxiv.org/abs/2308.02651 |
| **Wire routing NP 完全** | 布线本质难 | 只用结论：必须启发式 + 迭代 | https://www.researchgate.net/publication/27699077_Wire_routing_in_NP-complete |
| **FLP / QAP；BO / RL 布局；SMT 布局；NoC 死锁** | 设施布局 / 线长 / 布局编码 / 循环等待 | **均不能直接用**（逐条理由见 §3） | https://arxiv.org/abs/2212.08664 |

---

## 2. Q1：三类失败对应什么学术问题

### a. `V9-unused-outlet` → **不是 deadlock，是 order-dependent infeasibility**

经典 deadlock（含 NoC 的 deadlock-free routing）要求**多个参与者循环等待**：A 持 X 等 Y，B 持 Y 等 X。我们只有一个规划者，没有等待环，只有"先提交的决定封死后一个决定"。严格说不是死锁。

根因诊断文档已写明（`L4-COMPILER-DIAGNOSIS.md:140`）：

> "两个步骤**互相依赖**：trash 必须在 hub 之后，才能知道哪个槽是真废料；而 hub 又需要 trash 先把路面让出来。当前代码没有为这个循环依赖做迭代。"

**存在环，但代码按 DAG 线性执行——诊断已定位根因，只是没有对应机制。** 学术上落在"无回溯贪心"（VLSI 的标准答案是 rip-up & reroute）与 **RCPSP**（同一组活动换个顺序就从不可行变可行）的交界。

### b. `V6-crossing` → **受限 switchbox routing，不是 track 冲突**

如 §0(2) 所证：13/16 报错的格子物理全空。left-edge 已解决轨道冲突；剩下的失败是**拓扑类太窄**（Z-only 三段折线）。解法不是更强的搜索，**是放宽拓扑类**：允许 0~3 拐单调折线、允许 dogleg 中途换道。

### c. hub 入口 → **pin assignment 只是外壳，真问题是走廊争用**

IBM 那篇的 formulation 对得上：给定 netlist 互连两组终端，**终端位置可作为决策变量移动**（https://research.ibm.com/publications/optimal-wiring-of-movable-terminals）。

**但【实测】我们不是 N×16，是 1×16。** `place.mjs:373` 的 `terminals` 是"唯一产出端"，多于一个直接 `out-of-scope:multilayer` 拒单；`place.mjs:2450` 只拿 `terminals[0]` 连 hub，`hubConnection` 是单值对象。而 `place.mjs:2470` 已经按曼哈顿距离**排序 16 个入口、逐个 `route()` 试、失败整段快照回滚**——这已经是最优子集里的枚举了。所以"pin assignment 没做"是错的：**1×16 的分配不存在组合爆炸，做不做都一样。**

真问题是：**每个候选入口都要先铺一条竖直收集带，而这条带的几何（Z-only、`strictLane:true`）在真实厂里全撞。** 入口空着（13/16）也接不上，因为堵的是**通往入口的走廊**，不是入口本身。这正好说明：入口分配是症状，走廊是病。

---

## 3. Q2：能否用（逐条理由）

**能用：**

- **Pin assignment（性价比最低，实测推翻）。** `place.mjs:2470` 已按曼哈顿距离排序 16 个入口逐个试路由、失败整段回滚；`place.mjs:373` 只允许一个产出端（多终端直接 `out-of-scope:multilayer`），`:2450` 只连 `terminals[0]` —— **实际是 1×16，不是 N×16**。1×16 无组合问题，前置分配算法不会改变任何结果。真正该做的是放宽通往入口的走廊几何（见下条）。
- **有限轮 rip-up（≤5 轮，确定性）。** 通道失败 → 收回与它共享走廊的已成功通道 → 重排顺序重铺。顺序按 `(失败次数降序, channelId 码点序)` 排，无 RNG。`Grid.clone()` 现成。n≈10 时毫秒级。
- **放宽几何，让 Dijkstra 先跑（真实场景 0/4 的主修复点）。** `lane.mjs:52` 的 `GEOM_KINDS` 已有 `search` 形态并交给 `dijkstraOriented`，但 Z-only 预计算**先**成功/失败，Dijkstra 常常轮不到。改法：Z 形解不开**不记 failure**，记 `softCost+1` 后交 Dijkstra。13/16 入口物理全空却报 `column-conflict`，正是这条的直接证据。
- **小规模顺序枚举。** V9 那个 case 只有两个步骤，**2! = 2 种顺序**。诊断手工试过反序，V9 直接消失（§1.4 实验 A）。这不是算法问题，是代码里没写这个 for 循环。
- **MIP 的约束清单（不跑求解器）。** prior-art §5 已摘好 A1~A11；其中 **A3「源/宿量必须相等」**（MIP-Router 建模前就 `raise ValueError`）值得抄成 P3 入口断言——最便宜的"编译前先证明不可能"。
- **shapez-auto 的"竖直走廊预占"**（`layout.go:160-202`）：先占一条朝 hub 的纯直走廊，再让 A* 接到走廊底。正对"收集带→hub"失败高发区。

**不能用：**

- **CP-SAT / Gurobi。** ①零依赖铁律（`plan-compiler.md §2`：只有 ESM + `node:` 内置）；②MIP-Router 作者自述开源替代 PULP "significantly slower … impractical for even moderately sized routing problems"；③真实场景 0/4 的主因是**看不到世界**和**没有回边**，换更大的求解器不解决这两条。
- **整题 SAT/SMT 编码。** 技术可行（每格×每朝向一个布尔变量 + at-most-one + 连通性），但：①引入 solver 依赖，违反零依赖铁律；②连通性被迫展开成局部前驱约束，丢失"这是一条路径"的全局语义，产生大量假解；③我们的规模用 Dijkstra + left-edge 已毫秒级，而**可行性都还没到，优化最优性是超前投资**。SAT 的正确用途是**当检查器**（验蓝图合法性），不是生成器。
- **MAPF。** 状态是 `(agent, cell, timestep)`，冲突是"同一时刻同一格"。带子是**静态实体**，无时间维，冲突是"同一格被两条流占用" = **vertex-disjoint paths / unsplittable flow**。套 MAPF 会无谓乘上时间维；**只可借 CBS 的"只重解冲突那一对"**——正是 rip-up 该有的粒度。
- **FLP / QAP 求解器。** NP-hard，精确解只到 n≲30；且不建模连通性（只算流量×距离，不管中间有没有路），我们的设施还有 DAG 偏序，属错配。**但 min-cut linear arrangement** 比现在的 barycenter 更强，属"有余力再做"。
- **模拟退火 / 遗传算法。** verilog2factorio 有（`-g annealing` 默认），但：①用 RNG（`annealing.ts:4,58`），打掉 P5 变异测试与 P7 逐格 diff 方法论；②代价函数**只有边长**（`:232-234`），不含 overlap/congestion，表达不了 hub 争用；③迭代 `2000*sqrt(n)`，n≈20 时 8944 步换 left-edge 的 20 步——纯亏。上一轮已否决，本报告复核同意。
- **BO / RL macro placement。** 评估需跑 `dry_run`，单次秒级；BO 需成百上千次，量级不对。

---

## 4. Q3：手写 vs 求解器的界线

界线不是"难不难"，而是一条可操作判据：

> **约束能否在"局部"（一格 / 一条带 / 一个槽位）判定？**
> 能 → 手写，写成 assert 或一行判断。
> 不能（**全局耦合**：谁先占哪格、哪个入口给哪条流、谁让路）→ 交给搜索/分配算法。

| 层 | 归谁 | 内容 | 现状 |
|---|---|---|---|
| 游戏规则 | **手写，永远** | 带子三形状、单向、`code=1+rv`、`solveTurn(d,d)=null`、拐角由放置时邻居决定、footprint、槽位表、hub 16 口 | ✅ 权威（`belt-rules.mjs`，1906 条实机带子验证） |
| 单条路径 | **算法**（Dijkstra） | 给定起终点 + 障碍，找合法格序列 | ✅ 有，只需放宽几何 |
| 轨道分配 | **算法**（left-edge） | 多流共享走廊分行 | ✅ 有，27405 例最优 |
| **入口分配** | ~~算法~~ **实测不需要** | hub 16 口 ↔ 流；但只有 1 条流（`place.mjs:2450` 只连 `terminals[0]`，多终端直接拒单 `:373`） | ✅ 已有排序 + 逐个试 + 回滚（`:2470`） |
| **执行顺序** | **算法**（小规模排列 + 回滚） | 哪一步先做 | ❌ **缺**，硬编码流水线 |
| **冲突消解** | **算法**（有限轮 rip-up） | 谁让路、重铺哪条 | ❌ **缺**，"失败即放弃" |
| 可行性预检 | **手写断言** | 源宿量相等、fanin≤2、方位可达 | ❌ 缺（A3） |
| 目标/评分 | 手写（分级加权） | 可行 > 吞吐 > 拐角 > 带长 > 面积 | 部分（仅 `cornerCount`） |

**一条反直觉的结论**：该手写的恰恰是**最像领域知识的**（带子怎么拐、hub 几个口）；该交出去的，是**看起来最像"智能"的**（决定顺序、决定谁让路）。现在的代码把两者搞反了——领域规则写到 14,000 行，全局决策却是最朴素的贪心。

---

## 5. 具体建议（按投入产出排序）

**1（~60 行，针对 V6 + 真实场景 0/4）：放宽几何，让 Dijkstra 先跑。**
Z-only 从"主路径"降级为"快路径"；失败改记 `softCost+1` 交 `dijkstraOriented`；同时给它加 dogleg（允许中途换 lane 一次）。**这是唯一一条直接对准"13/16 入口物理全空却报 column-conflict"的改动**，也是带真实世界 0/4 的主修复点。

**2（~100 行，针对 V9）：给 `routeAll` 加"顺序重排 + 回滚"。**
对 bbox 相交的通道组，枚举 ≤3! 种顺序，每种用 `grid.clone()` 试铺，取第一个全成功的。诊断已证反序能让 V9 消失，但反序又引出"trash 抢了 hub 的槽"——所以必须**枚举 + 打分**，不能硬编码一个"更好"的顺序。评分抄 MIP-Miner 的分级加权：`可行 1e9 / 吞吐 1e6 / 拐角 1e4 / 带长 1e2 / 面积 1e1`（prior-art §5 B）。

**3（~0 行，明确不做）：hub 入口分配。**
原本以为这是最大缺口，实测否定：`place.mjs:2470` 已按距离排序 16 个入口并逐个试路由 + 整段回滚，且整个编译器只连一个终端（`place.mjs:373/2450`），是 1×16 而非 N×16。**没有组合爆炸，加分配算法是空转。** 要改的是走廊几何（建议 1），不是分配。

**4（~40 行）：可行性预检。** 抄 A3：`sum(上游产出)===sum(下游消费)`、`fanin≤2`、仅考虑 solid 障碍的 BFS 可达。把"A* 跑 10000 pop 才发现不可能"变成"编译前 1 毫秒判死"。

**5（架构级）：上面几条应做成常驻"局部重解器"，而不是流水线的一段。**
与 E 红队"编译器当主线错"不冲突，是补充：主线改成 `connect(from,to)` 宏动作后，**宏的内部仍需要放宽几何 + rip-up**——否则 `connect` 在拥挤旧厂里一样失败。

---

## 6. 参考链接

**文献**
- Factorio 蓝图自动设计（CP 建模）— https://arxiv.org/abs/2310.01505
- Factorio Learning Environment — https://arxiv.org/abs/2503.09617
- Splitter 网络稳态（负载均衡 Ω(n log n) 下界）— https://arxiv.org/abs/2404.05472
- MAPF 综述 — https://arxiv.org/abs/2505.19219
- Optimal Wiring of Movable Terminals — https://research.ibm.com/publications/optimal-wiring-of-movable-terminals
- Greedy channel router（Ho/Iyengar 1991）— https://www.doc88.com/p-9415259705467.html
- Wire routing is NP-complete — https://www.researchgate.net/publication/27699077_Wire_routing_in_NP-complete
- Planar directed k-Vertex-Disjoint Paths 是 FPT — https://arxiv.org/abs/1304.4207
- Single-Source Unsplittable Flows in Planar Graphs — https://arxiv.org/abs/2308.02651
- Deadlock-Free Routing for Arbitrary Networks — https://arxiv.org/abs/2503.04583
- Single Row Equidistant FLP — https://arxiv.org/abs/2212.08664
- Bayesian Optimization for Macro Placement — https://arxiv.org/abs/2207.08398
- RCPSP 精确法 — https://arxiv.org/abs/2203.06983 ／ 混合启发式 — https://arxiv.org/abs/2502.18330
- SMT-Layout（MaxSMT，非布线）— https://arxiv.org/abs/2411.12271
- weberknecht（One-Sided Crossing Minimization 求解器）— https://arxiv.org/abs/2412.06361

**开源实现**
- Redcrafter/verilog2factorio — https://github.com/Redcrafter/verilog2factorio
- jiahao-0204/Shapez2-MIP-Router — https://github.com/jiahao-0204/Shapez2-MIP-Router
- Songxwn/shapez-auto — https://github.com/Songxwn/shapez-auto
- QXIKmIJ/shapez-ai（NOTICE 声明专利，只取思路）— https://github.com/QXIKmIJ/shapez-ai

**项目内已有材料（必读，勿重复调研）**
- `research/ai-player/routing-prior-art.md`（585 行，本轮直接前驱）
- `research/ai-plan/L4-COMPILER-DIAGNOSIS.md`（571 行，V9/V6 逐格诊断，本报告 §0/§2 数据来源）
- `research/ai-plan/BELT-TOPOLOGY-RULES.md`（带子三条实机规则）
- `src/ai/compiler/lane.mjs`（left-edge 实现）
- `src/ai/compiler/route.mjs`（`routeAll` 无 rip-up = 核心缺口）
- `src/ai/compiler/grid.mjs:484`（`clone()`，回滚基建已就绪但未接线）

---

**一句话结论**：三类失败对应 RCPSP 式顺序不可行（V9）、拓扑类过窄的受限 switchbox routing（V6）、以及**被误判为 terminal assignment 的走廊争用**（hub）。前两者靠"回滚 + 放宽几何"，第三者**不需要分配算法**（1×16 且已排序试路由），同样只需放宽走廊几何。**都不是求解器能力不足，是"执行顺序 + 冲突消解"这一层缺失——而回滚基建（`Grid.clone`）早就建好，只是没接线。**
