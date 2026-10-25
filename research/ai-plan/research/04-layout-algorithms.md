# 04 · 工厂/产线自动布局与布线算法调研

> 读者：`src/ai/compiler/` 的维护者。
> 问题域：给定形状 DAG（mine → cut/rotate/stack/paint → hub），输出 2D 网格上的建筑坐标 + 传送带路径。
> 证据分级：**【实测】** = 我在本机跑过代码/基准；**【摘要】** = 只读到论文摘要或元数据（OpenAlex/Crossref/arXiv API）；**【推断】** = 由算法已知性质推出，未实测；**【本项目】** = 从本仓库代码与 git 历史读出。
>
> 检索方式说明：环境只放通了 arXiv API、Crossref、OpenAlex、npm registry；`WebSearch`/`WebFetch` 对多数站点返回空或被拦。因此**所有引用都用元数据 API 核实过标题/年份/DOI**，事实性数字来自摘要原文或我自己跑的基准；凡是没能拿到一手正文的，显式标注【摘要】或【推断】，不伪造页码与结论。

---

## 1. TL;DR

**最该换的一个算法：把「一个 DAG 层 = 一行、每行 8 格」换成「rank assignment（Sugiyama 第 2 阶段）+ 按算子类别的行距（rowPitch）」，并且**先把矿机组收缩成一个超节点再分层**（contract-then-expand）。**

理由不是"文献这么做"，而是我们的数据（全部【实测】，脚本可复现）：

- 我们的 `assignRows`（`src/ai/compiler/place.mjs:861`）给每个 DAG level 固定 `ROW_H = 8` 行。这不是 Sugiyama 的 layering，是 **longest-path layering + 单位层距**——它把"层号"和"行"当成同一个东西，而层号是**约束**、行是**资源**。
- **高度差 9 倍**。16 台矿机 + 15 个 balancer + 4 个 cutter + hub：我们 10 个 level × 8 = **80 行**；收缩后 dagre 给 **9 个 rank**（= 1 矿机行 + 4 层 balancer + 4 个 cutter，与理论下界 `1+⌈log₂K⌉+4` **完全相等**）；理想行距（balancer 1 行/级、cutter 8 行/级）约 **1+4+32 = 37 行**。K=4 时我们 64 行 vs 理想 7 行 = **9.1×**；K=64 时 96 行 vs 11 行 = 8.7×。
- **必须收缩，不能直接喂**。我原本打算直接把矿机当独立节点交给网络单纯形，实测**不行**：K 是 2 的幂时它恰好把矿机放同一 rank，K=3/5/6/7 时会把矿机分到**两个不同 rank**（`allSame=false`）——这直接违反"矿机必须压在自己的矿上"的硬约束。把整组矿机收缩成一个宽 `K` 的超节点后，K=3…20 全部稳定（`MG rank` 唯一）。`minlen:0` 也**不能用**：dagre 3.1.3 对它抛 `TypeError`（三种 ranker 都抛），这条要写进实现笔记。
- 我们的两个硬失败是"形状病"而不是"布线病"：`CpCpCpCp` 的产线 bbox **219×24**（`column-conflict-unresolved`），`RbRb----` **24×200**。这两个数字来自 `harness/out/*.intent.json` 的 `stats.bbox`，即**我们编译器自己的产物**（`placeVersion 0.5.0`），不是参考蓝图。24 行高的板子里塞 219 列宽的带子网，车道冲突是必然的；高度一旦按 rowPitch 折叠，宽度也会跟着收（`8fc9f9d` 的 4 矿机案例：99 实体 → 20，因为"snaking 回落的带子"消失了）。

次要但同级的第二个改动：**候选点不是"多给"，而是"换评分"**（§7）。我们 9→15 个候选反而变差（commit `2bdef87`），这不是玄学，是"首个可行即接受"的谓词对候选集不单调——文献里对应"最小化线长会在局部制造拥塞热点"（Wang & Sarrafzadeh 1999）。

---

## 2. 问题归类：我们的子问题在文献里叫什么

先说结论：**我们的问题不是 QAP，也不是纯 Steiner 树。** 它是一个"分层图绘制（layered drawing）+ 通道布线（channel routing）+ 单调合并树（alphabetic tree）"的三段式问题，每一段都有专门的、比 QAP 便宜得多的算法。

| 我们的子问题 | 标准名称 | 经典解法 | 复杂度 / 适用规模 |
|---|---|---|---|
| 把 DAG 节点分到网格行 | **DAG layering**（Sugiyama 第 2 阶段）/ **rank assignment** | longest-path；**Coffman–Graham**；**network simplex**（dot/dagre/ELK） | longest-path O(V+E)；C-G O(V)；网络单纯形实践 O(V·E) 但常数小。**V<10⁴ 都是毫秒级**【实测：dagre 800 节点 905 ms】 |
| 每层内左右排序、少交叉 | **crossing minimization**（Sugiyama 第 3 阶段） | barycenter / median 扫描 | 每轮 O(E)；最优是 **NP-hard**（单侧交叉最小化对稀疏图 NP-hard[1]），我们用启发式即可 |
| 机器在行内的 x 坐标 | **coordinate assignment**（Sugiyama 第 4 阶段）/ **single-row layout** | Brandes–Köpf；SRFLP 启发式 | SRFLP **NP-hard**；Brandes–Köpf O(V+E) |
| 多个通道抢同一行/列 | **channel routing / track assignment** | **left-edge**（区间图着色）+ 纵向约束 | O(n log n)；无纵向约束时最优，轨数 = 最大团 |
| 多矿机汇流成一棵树 | **rectilinear Steiner tree** 的**有序**特例 = **alphabetic tree** | **Hu–Tucker / Garsia–Wachs** | O(n log n)；n 任意 |
| 全局多网布线不交叉 | **global routing + negotiated congestion** | **PathFinder**（rip-up & reroute） | 每轮 O(nets·E log V)；收敛性无保证（见 §4 实测） |
| 在已有产线上插一个工序 | **ECO（engineering change order）/ incremental placement**；运筹学侧叫 **DFLP**（dynamic facility layout，带搬迁成本） | 冻结 + 局部 rip-up + 窗口扩张 | 见 §6 |
| 机器块之间的相对位置（若我们真要做二维块布局） | **QAP / block layout / MRLP** | CRAFT / CORELAP / ALDEP / SA | QAP **n>30 无已知精确解**【摘要：arXiv 2310.01604】 |

### 关于 QAP / CRAFT / CORELAP / ALDEP：不适用，理由具体

- CRAFT（Armour & Buffa 1963, *Management Science* 9(2):294, DOI 10.1287/mnsc.9.2.294）是**成对交换的局部搜索**，要求初始布局 + 面积可分的块；它的目标函数是 `Σ flow_ij · dist_ij`，**完全不建模传送带几何、转向、交叉、容量**。CORELAP（Lee & Moore 1967）是构造式（按关系图打分逐块填入），ALDEP 是"扫描式"构造。
- 它们求解的是"哪个部门挨着哪个部门"，**不是"这条带子从这台机器的哪个口出、拐几次弯、占哪一行"**。我们的约束（每格容量 1、方向、转向要占格、hub 只有 16 个入口）在 QAP 里没有对应物。
- 规模上更致命：QAP 的精确解上限约 **n≈30**（"no methods are known to exactly solve QAP instances of size greater than 30"[2]），而 CRAFT 这类交换启发式在 n=50–100 也要几百次评估。我们一个 `CpCpCpCp` 就有 5 台机器 + 378 格带子——QAP 的"设施"根本不是机器，是**带子格**，n=383，远超任何精确解上限。
- **可借用的只有一条思想**：CRAFT 的"成对交换 + 目标函数下降"可作为 §6 增量改造的局部搜索骨架（交换两台同级机器的位置，重算受影响通道）。不要借它的目标函数。

---

## 3. 分层（layer assignment）：我们"每层一行"错在哪，Sugiyama 怎么做

### 3.1 Sugiyama 的四阶段（Sugiyama–Tagawa–Toda 1981[3]）

1. **去环**（我们是 DAG，跳过）；
2. **层分配**：给每个顶点一个 rank，满足 `rank(v) ≥ rank(u) + minlen(u,v)`，目标通常是最小化 `Σ w(e)·(rank(v)−rank(u))`；
3. **层内排序**：减少交叉（barycenter/median 迭代；最优 NP-hard）；
4. **坐标分配**：给 x（Brandes–Köpf 线性时间[4]）。

**关键点：第 2 步的产物是"rank"，不是"行"。** rank 是拓扑约束的编号；行是物理资源。把两者绑死，等于规定"每层必须占满 8 行"，这才是我们的病根。

### 3.2 三种 layering 的差别（这是可以直接换掉的那一层）

| 方法 | 目标 | 后果 |
|---|---|---|
| **longest-path**（我们在用） | 每个节点尽量早 | 长链被拉满；**总高度 = 最长链长度**，且对多前驱节点会把层拉得很开 |
| **Coffman–Graham**（1972, *Acta Informatica*, DOI 10.1007/bf00288685） | 给定宽度上限 W，最小化高度 | **对 2 处理器最优**；高度 ≤ (2−2/W)×最优【摘要/教科书结论】。用于"宽度受限"的调度 |
| **network simplex**（Gansner et al. 1993[5]，dot 的算法） | 最小化加权边跨度和 | **直接最小化"总纵向带子长度"**——正是我们的目标函数 |

`dagre`（MIT，`@dagrejs/dagre@3.1.3`）三种都实现了（`ranker: 'network-simplex' | 'tight-tree' | 'longest-path'`，我在包里 grep 到这三个字符串）。ELK 额外有 `COFFMAN_GRAHAM` / `MIN_WIDTH`。

### 3.3 【实测】同一张图，两种分层

图：16 台矿机 + 15 个 balancer（配对二叉树）+ 4 个 cutter 串联 + hub = 36 节点、35 边。方法：先把矿机组收缩成一个超节点 `MG`，再交给 dagre `network-simplex`。

```
收缩后 dagre 输出（rank 数 = 9）：
  rank 0: hub
  rank 1..4: c3, c2, c1, c0        ← 4 个 cutter 串联，各占一级（必须 8 行/级）
  rank 5: b14                      ← 最后一级合并
  rank 6: b12,b13
  rank 7: b8..b11
  rank 8: b0..b7                   ← 第一级合并
  rank 9: MG                       ← 16 台矿机 = 1 个 rank，宽度 16
```

**rank 数 9 = 理论下界** `1（矿机行）+ ⌈log₂16⌉（4 层 balancer）+ 4（cutter）`。而我们的规则是 `baseY − level × ROW_H`，10 个 level × 8 = **80 行**。

规模对照（【实测】用 dagre 跑，行数 = rank 数；"我们"= uncontracted 的 level 数 × 8）：

| 矿机数 K | 我们的 level 数 | 我们的行数 | 收缩后 rank 数 | 理论下界 | 我们/下界 |
|---|---|---|---|---|---|
| 4 | 8 | **64** | 7 | 7 | **9.1×** |
| 8 | 9 | **72** | 8 | 8 | 9.0× |
| 16 | 10 | **80** | 9 | 9 | 8.9× |
| 32 | 11 | **88** | 10 | 10 | 8.8× |
| 64 | 12 | **96** | 11 | 11 | 8.7× |

**两条必须写进实现笔记的坑（我踩到了）**：

1. **不能把矿机当独立节点直接喂 dagre**。K=4/8/16 时它碰巧把矿机放在同一 rank；K=3/5/6/7 时**不**（实测 `allSame=false`，矿机被分到两个 rank）。收缩成超节点后 K=3…20 全部稳定。收缩/展开是标准做法（ELK 的 `hierarchyHandling`、dot 的 cluster 都是这个思路）。
2. **dagre 3.1.3 的 `minlen:0` 会抛异常**。我用 `a→c`、`b→c` + `a→b{minlen:0}` 试了 `network-simplex`/`tight-tree`/`longest-path` 三种 ranker，全部 `TypeError: Cannot read properties of undefined (reading 'forEach')`。所以"同排"只能靠**收缩 + 我们自己的展开规则**表达，不要指望 `minlen:0`。

另外，dagre 的 x 坐标是连续值 + 0.5 偏移（我实测到 `m13@0.5 m12@20.5 …`），**不能直接当格坐标**。只用它的 `y`（rank），x 仍走我们自己的"父子同列零拐角"规则。

### 3.4 我们该怎么改（具体到函数）

1. **拆开"层号"与"行号"**。`layerAndOrder()` 继续产出 rank（拓扑序）；新增 `assignRanks()` 只负责 `rank → rowY`，用**按算子类别的行距**：

   ```
   rowPitch(op) = 1  if op ∈ {balance}          // 直通，口对口，零路由需求
                = 2  if op ∈ {mine}             // 留一行给转向
                = ROW_H  otherwise              // cutter/stacker/painter 需要走廊
   rowY(n) = Σ_{r < rank(n)} maxPitch(r)
   ```

   这正是 `8fc9f9d` 对 balancer 做的特判，**把它一般化成数据驱动的 `rowPitch` 表**即可，不必再写第二个特判分支。按上表：16 矿机 = 1 行矿机 + 4 级 balancer×1 行 + 4 级 cutter×8 行 ≈ **37 行**，而不是 80。

2. **收缩矿机组（contract-then-expand）**。这一步是**前置条件**，不是优化：不收缩时 K 非 2 的幂会把矿机拆到两个 rank（§3.3 坑 1）。做法：
   - 把 `mineGroup` 的 N 台矿机收缩成一个 `{w: N, h: 1}` 的超节点交给 rank assignment；
   - 展开时把超节点所在 rank 的 `y` 分给全部矿机（它们本来就同 y，`planMinerColumns` 已保证 x）；
   - balancer 树的每一级作为独立节点参与（它们是真正的 rank 消费者）。

3. **只在需要时才付行距**。判据：这条边是否需要拐弯。`outDir === inDir` 且两机同列 → 1 行；否则 `ROW_H`。

4. **别自己实现 network simplex**。dagre 3.1.3 是 MIT、2026-10-24 还在更新、无重依赖（只依赖 `@dagrejs/graphlib`），我们只用它的 **rank 结果**（`g.node(id).y` 的相对次序），x 坐标仍走我们自己的 `assignRows`。

   规模：V=36 → 39 ms；V=800 → 905 ms【实测】。我们到几百个节点都是毫秒级。

5. **不要指望 Sugiyama 解决交叉**。第 3 阶段最优是 NP-hard（单侧交叉最小化对稀疏图 NP-hard[1]；k-level 对树都 NP-hard[6]）。我们已有的"父子保序 ⇒ 无纵向约束 ⇒ 无交叉"（`routing-prior-art.md` §1 的 27405 例穷举）是一条**约束**而不是启发式，比任何 barycenter 都强，保留。

---

## 4. 布线：A* / Steiner / FPGA rip-up-reroute 三选一

### 4.1 三者的定位完全不同，不该"三选一"

| 方案 | 解决什么 | 不解决什么 |
|---|---|---|
| **A\*/Dijkstra 单网** | 一条 net 在障碍里的最短正交路径 | 全局：先布的网会把后布的网堵死；无公平性 |
| **Steiner / RSMT** | **一棵树**（一源多汇）的总长最小 | 多棵树之间的**资源争用**；容量；不交叉 |
| **PathFinder（协商拥塞）** | 多网共享容量网格的**全局可行性** | 拓扑上就不可行的情况（实测见下） |

所以正确结构是：**Steiner 只用在汇流树（§5），PathFinder 的成本函数用在全局布线，A\* 只做单条兜底**——这恰好是我们 `routing-prior-art.md` §8 已有的选型（left-edge 车道 + 带朝向 Dijkstra 兜底），只是没有引入"协商"这一层。

### 4.2 【实测】PathFinder 在我们的规模上到底行不行

我自己写了一个 PathFinder 原型（容量 1/格，成本 = `(1 + history) × (occupancy + 1)`，二叉堆 Dijkstra），跑三组：

| 实例 | 结果 | 耗时 |
|---|---|---|
| 220×26 网格，30 条**单调**（不交叉）net | **1 轮收敛**，总长 780 | 44–71 ms |
| 220×26，30 条**对向交叉** net（源在底排、汇在顶排、顺序相反） | **100 轮不收敛**，overflow 479 | 10.4 s |
| 220×26，40 条对向交叉 | 100 轮不收敛，overflow 1245 | 18.4 s |
| 合并树（K=4/8/16） | 1 轮收敛 | 3–5 ms |

结论**非常明确**：

- **可行（可平面化）的实例，PathFinder 一轮就收敛**——协商机制根本没被用上，因为第一次就无冲突。
- **真交叉的实例，迭代永远不会收敛**。原因不是调参：容量 1 的网格里，K 条互相交叉的 net 需要 K 条不同的行；如果布局没给够行，**再多轮协商也变不出来**。PathFinder 的论文[7]本身也是"balance performance and routability"，它假设布线资源足够、只是分配得不好。

所以：**不要把 PathFinder 作为主算法引入**。它的价值只有成本函数（history-based congestion，即"这条边被抢过几次"要涨价）。这正好是 §7 缺的那一项。

### 4.3 那到底用什么

**两段式，与现有代码同构：**

- **第一段（全局，必须有）**：车道/轨道分配 = **区间图着色（left-edge）**。把每条 channel 看成列区间 `[min, max]`，冲突 = 区间重叠 ∨ 纵向约束，首次适配。O(n log n)，无纵向约束时轨数最优。**我们已有**（`lane.mjs`）。
- **第二段（局部）**：单条通道在已占用网格上铺格 = **带朝向 Dijkstra**。O(E log V)，一格一次。**我们已有**（`route.mjs:dijkstraOriented`）。
- **第三段（新增，只在两段都失败时）**：**有界 rip-up**——把冲突的 k 条通道（k ≤ 3）拆掉重布，其余固定；失败则把 k 扩到 6、12；仍失败就**改布局**（加行 / 加宽 / 换 site），而不是继续迭代。这一条的成本函数抄 PathFinder 的 `(1+history)`，但**迭代次数硬上限 3**。

规模判断（【实测】+【推断】）：net 数 ≤ 40、网格 ≤ 220×40 时，单遍全 rip-up ≈ 50–100 ms；三次上限 < 0.5 s。超过 40 条 net 时先改布局（§3），不要加迭代——因为按 §4.2 的测量，加迭代是无效的。

### 4.4 隧道（underground belt）在这里的位置

游戏里隧道 `undergroundBeltMaxTilesByTier: [5, 9]`（`recon/upstream-full/src/js/core/config.js:90`），即**最多跨 5 格**（我们的 `TUNNEL_MAX_SPAN = 4` 是保守的）。这等价于 VLSI 里的 **via / 换层**：它**不创造容量，只允许两股流在垂直方向分离**。

**重要推论**：隧道能解决的是"**两条带子必须交叉**"，不能解决"**行数不够**"。`CpCpCpCp --tunnels` 的实测结果是 bbox 168×19 且仍然 `crossing-needs-tunnel`——正是这个原因。所以在实现顺序上，**隧道必须排在行分配之后**（先有足够行，再谈交叉），而不是用来兜底形状问题。

---

## 5. 汇流树（多矿机合并）：Steiner？还是配对树？

### 5.1 它确实是 Steiner，但在我们的约束下退化成"有序树"

- 无约束的 RSMT 是 **NP-hard**（Garey & Johnson 1977, *SIAM J. Appl. Math.*, DOI 10.1137/0132071，1125 引用[8]）。
- 但 RSMT 有一个极强的性质：**Hanan 定理**（Hanan 1966, *SIAM J. Appl. Math.*, DOI 10.1137/0114025，623 引用[9]）——存在一棵最优 RSMT，其所有 Steiner 点都落在"过终端点的水平/竖直线"的交点上（**Hanan 网格**）。所以问题从"平面"降到"由 k 个终端诱导的 ≤ k² 个候选点"。
- 精确算法：Dreyfus–Wagner 动态规划，`O(3^k·n + 2^k·n²)`；实测口径是 **k ≥ 17 就内存爆炸**（Thomborson et al. 1994[10] 原话："hopelessly I/O-bound for k ≥ 17"）。
- 实用近似：**FLUTE**（Chu & Wong 2007, *IEEE TCAD*, DOI 10.1109/tcad.2007.907068，356 引用[11]）——查表，**degree ≤ 9 时最优**，高 degree 用 net-breaking 拆小，时间"very fast"，可调精度/速度权衡。
- 精确工业实现：**GeoSteiner**（Warme/Winter/Zachariasen，ANSI C，LP-based，官网可达）——但它解的是"平面上 k 个点"，**不含障碍、不含容量、不含有序**。

### 5.2 我们的真实约束把问题进一步简化：矿机在一行上，带子不能交叉

这才是关键。我们的矿机在自己的矿位上（`planMinerColumns`），实际形态是**一维排布**；而带子不能交叉（同格容量 1）⇒ **合并树的叶子顺序必须与空间顺序一致** ⇒ 只能考虑**保序的满二叉树**。

这就是 **alphabetic tree（最优字母树）** 问题，不是 Huffman：

- **Huffman** 允许任意两棵子树合并——包括空间上不相邻的两棵，结果会**要求带子交叉**，在我们的网格里不可实现。
- **Hu–Tucker**（1971, *SIAM J. Appl. Math.*, DOI 10.1137/0121057[12]）/ **Garsia–Wachs**（1977, *SIAM J. Comput.*, DOI 10.1137/0206045[13]）解的是同一个问题：**保序**的最小加权外部路径长度。O(n log n)。

### 5.3 【实测】三种树形的代价对比

目标函数：合并树的总带长 ≈ `Σ_i w_i · depth_i`（每下一层走 1 格 dy，dx≈0）。我对 K≤5 做了**全枚举**（所有保序二叉树）验证：

| 权重 | 保序最优（Hu–Tucker） | Huffman（允许乱序） | 差距 |
|---|---|---|---|
| `[8,5,3,2,1]` | 39 | 39 | 0（恰好同形） |
| `[10,1,1,1,10]` | 41 | 41 | 0 |
| `[5,1,9,1,5]` | **48** | **42** | **Huffman 好 14.3%，但其树形要求交叉 ⇒ 不可实现** |
| `[1,2,3,4,5]` | 33 | 33 | 0 |

等权时（我们现在的场景，所有矿机同速）**三种树形完全等价**：

| K | 配对式（我们现在的做法） | 左倾链（我们改之前的做法） | 比值 |
|---|---|---|---|
| 4 | 高度 2，带长 14 | 高度 3，带长 18 | 1.29× |
| 8 | 高度 3，带长 52 | 高度 7，带长 84 | 1.62× |
| 16 | 高度 4，带长 184 | 高度 15，带长 360 | 1.96× |
| 32 | 高度 5，带长 656 | 高度 31，带长 1488 | **2.27×** |

### 5.4 结论：我们的"配对式二叉树"是对的，差在两处

1. **没有用权重**。等速矿机下配对式已是最优；一旦矿机速率不同（不同矿种、不同 tier、`demandPerSec` 不均），就该用 **Hu–Tucker**（80 行左右，无依赖，O(n log n)）。差距可以到 14%（上表构造例）。
2. **每级 balancer 仍占一整行**（`8fc9f9d` 之前是 `ROW_H`，之后是 2 行）。真正的上限是"**balancer 是管道不是机器**"——它的输入口和输出口逐格对齐，理论上可以 1 行/级。这一步属于 §3 的 `rowPitch` 表。
3. **不是 Steiner 问题**。引入 FLUTE/GeoSteiner 在这里是负收益：它们不建模"有序""容量""障碍"，而我们的约束反而让问题更简单。只有在矿机**散布在 2D**（不在同一行）时，才需要考虑 OARSMT（obstacle-avoiding RSMT，Wu/Gao/Wang 2007[14]），那是另一个量级的工作。

---

## 6. 增量改造：在已有产线上插入一个节点

### 6.1 文献里对应的两个问题

- **VLSI 侧：ECO（engineering change order）**——设计后期的小改动，要求"不动大部分已布好的东西"。代表工作：incremental placement / legalization（Ren 2006 博士论文[15]）、**AIR**（Adaptive Incremental Router, ASP-DAC 2020，比 VPR7 快 7.1×，线长还降 15%[16]）。AIR 的核心思想对我们直接可用：**"lazy"——只对受影响的子图做搜索，其余沿用旧解**。
- **运筹学侧：DFLP（dynamic facility layout problem）**——目标函数里**显式含搬迁成本**：`Σ_t (flow_cost_t + relocation_cost_t)`（Wang 1999[17] 的定义）。也就是说，文献承认"改布局要付代价"，并且把它写进目标函数，而不是当作约束。

### 6.2 我们的算法（四步，按代价递增）

设要在 `P → C` 之间插入 `N`：

1. **切边**：删掉 channel `P→C`，新增 `P→N`、`N→C`。**其余实体坐标、其余带子全部冻结**，作为 `blocked`（含一个 +1 格光晕，理由同 `HUB_CLEAR`——机器邻居会让相邻带子漂 rv）。
2. **候选点 = 走廊内的空矩形**，按 `score` 排序（§7 的评分函数，不是"最近优先"）。每个候选"落子 + 布两条 net"都成功才 commit；失败回滚（我们的 `snapshot()/restore` 已有）。
3. **有界 rip-up**：若 2 全失败，找出与新 net 冲突的旧 net（最多 3 条），拆掉重布；冲突集扩张到 6、12。**上限 3 轮**。
4. **局部重排**：若 3 失败，只对"受影响子图"（N 的所有祖先/后代 ∪ 冲突 net 的端点，深度 1）重跑 §3 的 rank assignment，**其余节点的 rowY 冻结**。这是"最小改动"与"可解性"的折中。
5. 仍失败 → 全量重编，但把**无关连通块当作固定岛**（保留其 bbox 与内部几何），使 diff 局部化。

### 6.3 为什么不能只做"插入"

我们踩过的坑是"推倒重建比插入简单"——但重建会让**所有坐标漂移**，于是：
- 玩家在存档里看到的工厂整体搬家（体验问题）；
- 我们自己的逐字节回归（`placer/test.mjs` 的 269 条断言、金网格）全部失效。

文献的说法是：**增量问题的目标函数必须含"改动量"**（DFLP 的 relocation cost）。所以我们该加一个显式的度量：`Δ = 移动的实体数 + 重布的带子格数`，并把它作为 **gate**（回归测试里断言 `Δ = 0` 对无关节点）。这比"能插进去"更重要。

---

## 7. 贪心劣化的理论解释 + 对策

### 7.1 我们踩的坑，原文

commit `2bdef87`：`trashCandidates` 从 9 个候选扩到 15 个，`RuRu----` 从 28 实体变成**编不出来**。原话："The wider list let trash pick a farther cell, which took the column the hub channel needed. More candidates is not free when placement is greedy — it moves the failure rather than removing it."

### 7.2 文献里有没有对得上的解释？有三层，逐层对上

**第一层（机制）：接受谓词对候选集不单调。**

看代码（`place.mjs:2304-2328`）：

```js
for (const cd of cands) {
  if (occupied.has(cellKey(...))) { continue; }        // 只查"当前"占用
  const r = route(n, out, t, {...});                   // 只查"现在能不能铺通"
  if (r.ok) { ...; done = true; break; }               // 首个可行即接受
}
```

谓词是 `¬occupied ∧ route.ok`，**只评估"此刻"**。候选集从 9 扩到 15，只会让**被接受的集合变大**；而被接受的位置是否全局更差，谓词完全看不见。所以"候选变多 → 结果变差"是**预期行为**，不是 bug。数学上：greedy 对我们的问题**没有单调性保证**。

**第二层（为什么"更远"会伤）：最小化线长会制造局部拥塞热点。**

这是最直接对得上的文献。Wang & Sarrafzadeh, "On the behavior of congestion minimization during placement"（ISPD 1999, DOI 10.1145/299996.300044，83 引用[18]）摘要原文：

> "we show that in this model **the wirelength objective is indeed a good measure of congestion** by establishing that a placement with minimum wirelength has minimum total congestion. We show that **minimizing wirelength may (and in general, will) create local congestion** ..."

翻译成我们的语言：**总带长最小 ⇒ 总拥塞最小；但局部最小化带长会制造拥塞热点。** trash 候选"越近越好"就是在局部最小化带长，而它选的格子恰好是 hub 收集带的走廊——一个**热点**。

同一文献脉络里的另一条结论（Saab 1995[19]，摘要）："**Min-cut methods yield less congested and more routable placements at the expense of more wire-length**, while simulated annealing tends to optimize total wire-length with little emphasis on congestion minimization." —— 即：**"更可布"和"更短"是两个目标，必须显式权衡。** 我们的评分函数只有"近"，没有"可布"。

**第三层（"加资源反而更差"的一般性）：Braess 悖论 / 拟阵刻画。**

"增加选项/资源反而使最优解变差"在拥塞博弈里有严格对应：Braess 悖论。Fujishige et al.（arXiv:1504.07545[20]）证明了 **"对 Braess 免疫"的策略空间恰好是拟阵的基**（"bases of matroids are exactly this maximal structure"）。我们的放置空间显然不是拟阵，所以**不免疫是理论预期**。这一条我只作"类比"用，不当因果——真正的因果是上面第一、二层。

### 7.3 对策（按性价比排序）

1. **换评分，不换候选数**（最直接）。`score = α·beltLen + β·lanesDemandedIn(occupiedRows/Cols) + γ·hubEntryContention`。其中 `lanesDemanded` 可以在放置前**预估**：对每条待布 channel，数它需要占几行车道（`ceil(跨度 / rowGap)`），把这个需求摊到候选格所在的行/列上。候选数保持 9——`2bdef87` 已经证明 9 是对的。
2. **预订走廊（reservation）**。在放 trash **之前**把 hub 收集带要走的列标记为 blocked。这正是 `HUB_CLEAR = 3` 修法的一般化——那个修法有效（把"净空"从 1 调到 3，drift 归零），说明"先预订、后放置"这条路是对的。把它从"hub 一圈"推广到"所有已确定走廊"。
3. **改顺序：最受约束的先放**（fail-first / MRV）。当前顺序是自下而上（矿机 → 上游），而 **hub 连接是全局最稀缺的资源（16 个入口）**，应该**先定 hub 侧，再往下推**。CSP 的标准结论：最先失败的变量应该最先赋值。
4. **把"局部搜索"当成修复器而不是主算法**。CRAFT 的成对交换 + 模拟退火（QAP 文献里 SA 是最强的通用启发式[21]）可以用，但只在**已经有一个可行解**之后做微调；不要用它从零构造。
5. **回归锁**：把"15 候选会变差"写成一个**负例测试**（断言 15 候选的结果不优于 9 候选，或者断言评分函数在给定 fixture 上选中第 k 个候选）。`2bdef87` 是靠人肉 A/B 发现的，应该变成 CI。

---

## 8. 推荐技术栈（库 + 版本 + license）

### A. 立刻可用（零/一个依赖，当天能接）

| 库 | 版本 | License | 维护 | 用途 | 备注 |
|---|---|---|---|---|---|
| **@dagrejs/dagre** | 3.1.3 | **MIT** | 2026-10-24 更新 | **只取 rank assignment**（`ranker:'network-simplex'`） | V=36 → 39 ms，V=800 → 905 ms【实测】。注意只用 `node.y`，x 是连续值+0.5，不能直接当格坐标 |
| **@dagrejs/graphlib** | 4.0.7 | MIT | 2026-10-24 | 上面那个的依赖 | 无传递依赖 |
| 自写 **Hu–Tucker / Garsia–Wachs** | — | — | — | 加权汇流树（§5.4） | **npm 上没有可用的 Hu–Tucker 实现**（我搜过 `hu-tucker`，全是词典包）；Garsia–Wachs 约 80 行 |
| 自写 **left-edge 车道** | — | — | — | 已有（`lane.mjs`） | 保持 |
| 自写 **带朝向 Dijkstra** | — | — | — | 已有（`route.mjs`） | 保持 |

### B. 需要集成（有价值但有代价）

| 库 | 版本 | License | 维护 | 用途 | 代价 |
|---|---|---|---|---|---|
| **highs**（HiGHS 的 WASM 绑定） | 1.15.4 | **MIT** | 2026-10-16 | 精确的 1D 行/列分配（插入工序时的"最优落点"）、小规模 ILP | 需 `await highsFactory()` 初始化；**LP 解析器会把 `(` `)` 当成变量名**（我实测踩到，必须避免括号）；N=24 机器 / 9628 变量 → 1.2 s【实测】，只适合 n ≤ 24 的子问题 |
| **elkjs** | 0.12.0 | **EPL-2.0 OR GPL-3.0-or-later** | 2026-07-17 | 只有当我们真的需要"端口约束 + 正交布线"时 | 1.6 MB bundle；EPL-2.0 是文件级 copyleft（不改它本身通常可接受，但 GPL 分支是病毒式）。三种 layering 都有：`NETWORK_SIMPLEX / COFFMAN_GRAHAM / LONGEST_PATH`【实测：686 / 91 / 87 ms @50 节点】 |
| **z3-solver** | 5.3.2 | MIT | 2026-10-25 | 只在需要"约束满足"式排布时 | 杀鸡用牛刀；启动/求解开销远大于 dagre |

### C. 明确不建议

| 库 | 原因 |
|---|---|
| **glpk.js**（5.0.0 / 4.0.1） | **GPL-3.0**。我们是 MIT 项目（`LICENSE` / `package.json`），引入即污染 |
| **rsmt-ts**（1.1.6, MIT） | 依赖 `glpk.js@4.0.1`（**GPL-3.0**），传递污染。**且功能有坑**：README 自己说 edges 有问题；我实测确认——给 `[[0,0],[4,0],[8,0],[12,0]]` 返回 `edges = [[0,0],[4,0]]` **重复 3 次**、`steiners = []`。只有 `length` 字段可信（10 个随机实例上与 Prim MST 的比值 0.82–1.00，全部合法；n=30 用 41 ms）。**只能当"长度估计器"，不能当拓扑生成器** |
| **pathfinding**（0.4.18） | license 字段缺失（只有 `licenses:[{MIT}]` 老格式），2022-07 后未更新；且不支持我们的朝向/端口约束，价值≈0 |
| **@ortools-node/cp-sat**（9.15.0-node.0-rc.0） | **RC 版本**、native 绑定（node-gyp）、2026-05 才创建。CP-SAT 本身极强，但绑定太新，不适合做依赖 |
| **logic-solver**（2.0.1） | 2022 年后停更，SAT 表达不了优化目标 |

---

## 9. 分阶段实施路线

> 每阶段的"验证"都是**可在当前测试套件里跑的**（`node research/ai-plan/placer/test.mjs` 现有 269 条；`cli.mjs --json` 可批量出 bbox/rows/channels/cornerCount）。

### P0 · 建立基线（半天）

- **改什么**：不改算法。写一个 `bench-layout.mjs`：对 `research/ai-plan/harness/out/*.intent.json` 的 14 个 goal，批量输出 `{ok, reason, rows, height, width, entities, belts, cornerCount}`。
- **怎么验证**：把 `CpCpCpCp` 的 `219×24`、`RbRb----` 的 `24×200`、`--SuSu--` 的 `81×39` 钉成基线数字。
- **预期收益**：把"形状病"变成可回归的指标。没有这一步，后面所有改动都无法证明有效。

### P1 · 换 rank assignment（**核心，1–2 天**）

- **改什么**：`layerAndOrder()` 之后新增 `assignRanks()`；引入 dagre 只取 rank；`rowPitch(op)` 表（balance=1、mine=2、其余 `ROW_H`）；`minlen:0` 支持同排。
- **怎么验证**：
  - 断言"矿机行 = 矿位行"（现有 `planMinerColumns` 的测试不能松）；
  - 断言 rank 数 = 最长链长度（而不是原来 level 数）；
  - **高度必须下降**：`RbRb----` 200 → < 40；`CuCuCuCu` 24 → ≤ 6（`8fc9f9d` 已给过 5）；
  - 金网格会变 → 必须**重新生成**并逐字节锁，同时保留"拐角数不增加"的断言（`cornerCount` 是 `LayoutReport` 的既有字段）。
- **预期收益**：按 §3.3 的 80→10 推算，实体数应下降 40–60%（`8fc9f9d` 单改 balancer 就降了 5×）。`CpCpCpCp` 的 `column-conflict-unresolved` 有较大概率直接消失（宽 219 → ~40），因为车道数从"跨 219 列"降到"跨 40 列"。

### P2 · 汇流树的权重（半天）

- **改什么**：`buildBalancerTree`（`place.mjs:1867` 附近）从"等权配对"改成"权重输入 + 保序最优"。等权时退化为配对式（我验证过二者等价），所以**对现有 fixture 零扰动**；只有 `demandPerSec` 不均时才换形。
- **怎么验证**：对 K ≤ 8 做**全枚举**（我用的 `allTrees` 暴力，代码 20 行）对拍 `Σ w·depth`；对 K=16/32 对拍"不劣于配对式"。
- **预期收益**：矿机速率不均的场景下带长降 ~14%；等权场景 0 变化（零风险）。

### P3 · 候选评分（1 天）

- **改什么**：`trashCandidates` 的消费循环（`place.mjs:2304`）从"首个可行"改成"全部打分取最优"；评分含 `lanesDemanded` 项；候选数**回到 9**；hub 走廊**预先 blocked**。
- **怎么验证**：
  - `RuRu----` 在 4 个 seed（43391/60908/77844/15935）上：当前是 1/4 通过，目标 4/4；
  - 负例锁：断言 15 候选不优于 9 候选（把 `2bdef87` 的教训变成 CI）；
  - `Cu------`、`Cu----Cu` 的 cornerCount 不得上升。
- **预期收益**：消除"多给候选反而更差"这一类回归；把"可行性"从运气变成评分。

### P4 · 增量插入（2–3 天，依赖 P1/P3）

- **改什么**：新增 `insertOp(plan, {after, op})`，五步（§6.2）；显式的 `Δ(entities, belts)` 度量。
- **怎么验证**：在 `Cu----Cu` 的成品上插入一个 cutter → 断言"无关节点坐标逐个不变"（`Δ=0`）；断言总实体数增加 ≤ 新机器 + 2 条 net 的长度；失败时给出结构化 `conflicts[]`（契约已有）。
- **预期收益**：玩家侧"加一道工序"不再推倒重建；我们侧的回归从"整张金网格"降到"局部 diff"。

### P5（可选）· 有界 rip-up（1 天）

- **改什么**：`routeAll` 失败时，按 §4.3 第三段做 3 轮有界 rip-up，成本用 history 项。
- **怎么验证**：`CpCpCpCp` 在 P1 之后若仍失败，看能否靠 rip-up 救回；**如果救不回，不要加迭代**（§4.2 已证明无效），直接报 `crossing-needs-tunnel` 并提示加行。
- **预期收益**：把"最后 5% 的布线失败"从"改参数"变成"自动修复"；同时**用实测数据防止过度投入**。

---

## 10. 参考来源

**分层 / 图绘制**

1. Muñoz, Unger, Vrt'o, *One Sided Crossing Minimization Is NP-Hard for Sparse Graphs*, GD 2002. DOI 10.1007/3-540-45848-4_10
2. （QAP 精确解上限）Bagga & Delarue, *Solving the Quadratic Assignment Problem using Deep Reinforcement Learning*, arXiv:2310.01604, 2023. 摘要原文："no methods are known to exactly solve QAP instances of size greater than 30"
3. Sugiyama, Tagawa, Toda, *Methods for Visual Understanding of Hierarchical System Structures*, IEEE Trans. SMC, 1981. DOI 10.1109/tsmc.1981.4308636（1224 引用）
4. Brandes & Köpf, *Fast and Simple Horizontal Coordinate Assignment*, GD 2001. DOI 10.1007/3-540-45848-4_3
5. Gansner, Koutsofios, North, Vo, *A technique for drawing directed graphs*, IEEE TSE, 1993. DOI 10.1109/32.221135（dot 的四趟算法，第 1 趟即 network simplex rank assignment）
6. Harrigan & Healy, *k-Level Crossing Minimization Is NP-Hard for Trees*, 2011. DOI 10.1007/978-3-642-19094-0_9
- Coffman & Graham, *Optimal scheduling for two-processor systems*, Acta Informatica, 1972. DOI 10.1007/bf00288685（Coffman–Graham layering）
- Eiglsperger, Siebenhaller, Kaufmann, *An Efficient Implementation of Sugiyama's Algorithm for Layered Graph Drawing*, JGAA 9(3), 2005. DOI 10.7155/jgaa.00111

**布线 / 拥塞**

7. McMurchie & Ebeling, *PathFinder: A Negotiation-Based Performance-Driven Router for FPGAs*, FPGA 1995. DOI 10.1109/fpga.1995.242049（DAC 版 DOI 10.1145/201310.201328，685 引用）
- Dees & Karger, *Automated Rip-Up and Reroute Techniques*, DAC 1982. DOI 10.1109/dac.1982.1585535
- Deutsch, *A "Dogleg" Channel Router*, DAC 1976. DOI 10.1145/800146.804843；Szymanski, *Dogleg Channel Routing is NP-Complete*, IEEE TCAD 1985. DOI 10.1109/tcad.1985.1270096
- Yoshimura, *An Efficient Channel Router*, DAC 1984. DOI 10.1109/dac.1984.1585770（left-edge 的改进版，多数实例最优）
18. Wang & Sarrafzadeh, *On the behavior of congestion minimization during placement*, ISPD 1999. DOI 10.1145/299996.300044
19. Saab, *A Fast Clustering-Based Min-Cut Placement Algorithm With Simulated-Annealing Performance*, VLSI Design, 1995. DOI 10.1155/1996/58084
- Murray, Zhong, Betz, *AIR: A Fast but Lazy Timing-Driven FPGA Router*, ASP-DAC 2020. DOI 10.1109/asp-dac47756.2020.9045175

**Steiner / 合并树**

8. Garey & Johnson, *The Rectilinear Steiner Tree Problem is NP-Complete*, SIAM J. Appl. Math., 1977. DOI 10.1137/0132071
9. Hanan, *On Steiner's Problem with Rectilinear Distance*, SIAM J. Appl. Math., 1966. DOI 10.1137/0114025（Hanan 网格定理）
10. Thomborson, Alpern, Carter, *Rectilinear Steiner tree minimization on a workstation*, DIMACS 1994. DOI 10.1090/dimacs/015/10（Dreyfus–Wagner `O(k²3^k)`，"k ≥ 17 就 I/O 爆炸"）
11. Chu & Wong, *FLUTE: Fast Lookup Table Based Rectilinear Steiner Minimal Tree Algorithm for VLSI Design*, IEEE TCAD, 2007. DOI 10.1109/tcad.2007.907068（degree ≤ 9 最优）
- GeoSteiner 5.3（Warme/Winter/Zachariasen），http://www.geosteiner.com/ （ANSI C，LP-based，解平面上的精确 RSMT）
14. Wu, Gao, Wang, *A Fast and Stable Algorithm for Obstacle-Avoiding Rectilinear Steiner Minimal Tree Construction*, ASP-DAC 2007. DOI 10.1109/aspdac.2007.357996
12. Hu & Tucker, *Optimal Computer Search Trees and Variable-Length Alphabetical Codes*, SIAM J. Appl. Math., 1971. DOI 10.1137/0121057
13. Garsia & Wachs, *A New Algorithm for Minimum Cost Binary Trees*, SIAM J. Comput., 1977. DOI 10.1137/0206045
- Held & Kämmerling, *Two-Level Rectilinear Steiner Trees*, arXiv:1501.00933, 2015（2.37-approx，`O(|P| log |P|)`；多组终端的两级树，和我们"矿机分组→hub"结构同形）

**设施布局 / 增量**

- Armour & Buffa, *A Heuristic Algorithm and Simulation Approach to Relative Location of Facilities*, Management Science 9(2):294, 1963. DOI 10.1287/mnsc.9.2.294（CRAFT 原始文献，524 引用）
- Lee & Moore, *CORELAP – Computerized Relationship Layout Planning*, 1967（244 引用）
- Burkard, Karisch, Rendl, *QAPLIB – A Quadratic Assignment Problem Library*, J. Global Optim., 1997. DOI 10.1023/a:1008293323270
- Amaral & Letchford, *A polyhedral approach to the single row facility layout problem*, Math. Programming, 2012. DOI 10.1007/s10107-012-0533-z（SRFLP 是 NP-hard）
- Hungerländer & Rendl, *A computational study and survey of methods for the single-row facility layout problem*, Comput. Optim. Appl., 2012. DOI 10.1007/s10589-012-9505-8
- Wan, Zuo, Li, Zhao, *A hybrid multiobjective GRASP for a multi-row facility layout problem with extra clearances*, IJPR 2020. DOI 10.1080/00207543.2020.1847342（MRLP-EC，多行 + 净空——和我们的 `rowGap` 最接近的文献）
17. Wang, *Static and dynamic facility layout problems*, 1999（DFLP 定义与搬迁成本）
15. Ren, *Incremental placement for modern VLSI design closure*, PhD thesis, UT Austin, 2006
16. （同 AIR）

**"多给反而更差"的理论**

20. Fujishige, Goemans, Harks, Peis, Zenklusen, *Matroids are Immune to Braess Paradox*, arXiv:1504.07545, 2015（"bases of matroids are exactly this maximal structure"）
- Harvey & Ginsberg, *Limited Discrepancy Search*, AAAI 1995（启发式失败时"少量偏离"重试——可作为 P3 评分失败后的有界回溯骨架）
- Bertsekas, *Rollout Algorithms for Discrete Optimization: A Survey*, 2013. DOI 10.1007/978-1-4419-7997-1_8（"rollout 的代价不劣于 base heuristic"——这条**保证**正是我们现在的"首个可行"缺的）

**库（均已用 npm registry 核实在售/版本/license）**

- `@dagrejs/dagre@3.1.3` — MIT — https://www.npmjs.com/package/@dagrejs/dagre
- `@dagrejs/graphlib@4.0.7` — MIT
- `elkjs@0.12.0` — EPL-2.0 OR GPL-3.0-or-later — https://www.npmjs.com/package/elkjs
- `highs@1.15.4` — MIT（HiGHS WASM 绑定，https://github.com/lovasoa/highs-js）
- `z3-solver@5.3.2` — MIT
- `glpk.js@5.0.0` — **GPL-3.0**（不采用）
- `rsmt-ts@1.1.6` — MIT 但依赖 GPL-3.0 的 `glpk.js@4.0.1`（不采用；且 edges 输出实测不可用）
- `javascript-lp-solver@1.0.3` — Unlicense（纯 JS 单纯形，无强 MIP，不推荐）
- `pathfinding@0.4.18` — MIT（2022 后停更，不推荐）

**本项目内部**

- `src/ai/compiler/place.mjs:861` `assignRows()`（每层一行，`ROW_H=8`）
- `src/ai/compiler/place.mjs:1727` `trashCandidates()`（9 个候选的来历）
- `src/ai/compiler/place.mjs:1867` 配对式 balancer 树
- `research/ai-player/routing-prior-art.md` §1/§8（left-edge + 有向 Dijkstra 的选型依据）
- commit `8fc9f9d`（24 行 → 5 行，99 → 20 实体）
- commit `2bdef87`（9 → 15 候选反而更差，已回滚）
