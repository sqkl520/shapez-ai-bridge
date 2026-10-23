# 生态调研：shapez / 工厂游戏的 AI·求解器·自动化工具盘点

> **调研 agent**：ecosystem（2026-10-23）。方法：`gh search repos/code`（20+ 组关键词）、`gh repo view` 读 README、
> `git clone --depth 1` 读关键源码、`curl` 到 registry.npmjs.org / pypi.org / export.arxiv.org / codeload.github.com。
>
> **证据标注**：【实测】= 我实际 clone/读取了源码或跑过命令确认；【文档】= 只读了 README/元数据，未读全部源码；
> 【推断】= 基于证据的推测；【待验】= 需要实机验证。
>
> ⚠️ WebFetch/WebSearch 在本环境被拦截，全部证据来自 `gh` CLI 与 `curl`（白名单域名）。

---

## 0. 一句话结论

**在我们正在做的事上，存在两个直接竞品级前作，必须读**：
1. **`Songxwn/shapez-auto`**（Go，MIT，2026-10，0★但目标完全一致）：**已经实现了「LLM 设计产线 → 确定性验证 → 自动摆建筑 → 加速通关到 26 关」的完整闭环**，跟我们的目标几乎逐字相同。
2. **`QXIKmIJ/shapez-ai`**（Python+JS，Apache-2.0，2026-10，0★）：游戏内 mod + WebSocket RPC + A* 路由 + MCP server + watchdog 自修复，
   **架构与我们的 bridge/MCP 几乎同构**（两者的 mod 文件都叫 `shapez-ai-bridge.js`，我们的仓库 2026-10-20 创建，它 2026-10-16 创建 —— 见 §5 时间线）。

**真正有长期价值、可直接复用的是 shapez 1 的「配方求解」前作**：
- **`TomasSirgedas/Shapez-solver`**（C++/JS, Unlicense, 2022）：**shapez 1 的完整配方求解器**——Dijkstra 预计算全部 2^16 形状的最优配方（`recipes_0_1_1.bin`），网页端读 bin 出配方树并**直接生成游戏内蓝图 JSON**。这是我们要做的"配方编译器"的现成参考实现。
- **`nedsociety/shapezio-shape-construction`**（Python, Unlicense, 2020）：BFS 枚举所有可构造形状，输出 `possible_shapes.marshal` 构造表，含火箭形状（`CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw`）分解器。
- **`cpcp1998/shapez2-solver`**（C++23, 2026）：shapez 2 的**完备枚举**（quad4 44M 形状、hex4 633G），并用 **PP-essential（pin-push essential）** 把「需要回退栈的构造」压缩到几千个——方法论可迁移。

**布局/路由的 MIP/CP 先例**：
- **`jiahao-0204/Shapez2-MIP-Miner`**（MIT, 26★）：**OR-Tools CP-SAT** 求解矿机布局（最新版已从 Gurobi 迁到 CP-SAT，免费）。
- **`jiahao-0204/Shapez2-MIP-Router`**（MIT, 14★）：MILP 路由（Gurobi，专有）。
- **`xaviershay/factorio-layout-designer`**：or-tools 经 lambda 服务求解布局（Foreman 移植）。
- **`alegnani/verifactory`**（39★）：**用 SAT(z3) 证明传送带平衡器性质**——不需要模拟。
- arXiv **2310.01505**「Towards Automatic Design of Factorio Blueprints」：**CP 模型优化 Factorio 蓝图**，明确说这是 bin-packing + routing + network design 的组合。

**警告**：FLE（`JackHopkins/factorio-learning-environment`, 1204★）是**评测场**不是解法；它的结论是 **LLM 空间推理弱、长程失败**——正是我们该引用的反面证据。另外 `Factoriax`（arXiv 2610.05569，2026-10）报告 PPO agent 训练后**仍不能摆出功能性的空间布局**，再次确认「别做 RL」。

---

## 1. 仓库清单表

### 1.1 shapez 1（shapez.io）相关 —— 最高优先级

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| **`Songxwn/shapez-auto`** | 0 | 用 LLM 设计产线自动通关 Steam 版 shapez.io 主线到 26 关 | Go 控制面 + 游戏内 mod；**内置确定性求解器 + LLM 提案做 override**；验证不通过就用内置解 | ★★★★★ **最有价值的单仓库**。§2.1 深挖 |
| **`TomasSirgedas/Shapez-solver`** | 6 | shapez 1 配方求解器（C++ 预计算 + JS 网页） | Dijkstra/BFS 分层枚举全部 2^16 形状 → `recipes_0_1_1.bin`；网页端查表出配方树 + 生成蓝图 JSON | ★★★★★ **配方编译器直接参考**。§2.2 深挖 |
| **`nedsociety/shapezio-shape-construction`** | 0 | BFS 枚举全部可构造形状，含火箭形状分解 | Python BFS + `possible_shapes.marshal` 表；`map-construction.py` 反向生成构造步骤 | ★★★★☆ 与前者互补：**穷举保证完备性**的实现在这里；【实测】火箭形状分解可用 |
| **`LeopoldTal/shapezio-scripts`** | 1 | 数一下 shapez.io 有多少可构造形状 | 只追踪「哪些象限非空」（忽略形状/颜色），BFS 闭包 | ★★★☆☆ **证明「可构造性只取决于象限占用模式」**——这是求解器做状态压缩的理论依据 |
| **`EmeraldBlock/shapecount`** | 1 | 同上（Java 版），算到深度 9 的制造树 | 枚举 + 深度统计 | ★★☆☆☆ 数量级参考：**48432 个形状配置**（忽略形状/颜色） |
| **`MengLeiFudge/shapezTools`** | 4 | 中文「异形工厂工具箱」，计算可合成图形/获取谜题 | Java；含 `GetAllShapes.java`、`check_floating`（悬空检测）、`shapes.json` 形状数据库 | ★★★☆☆ **中文社区形状数据库**；悬空检测代码可对照 |
| **`tobspr-games/shapez.io-viewer`** | 24 | 官方形状生成/查看器 | 纯 JS，从游戏源码复制 1:1 的形状代数 + canvas 渲染 | ★★★★☆ **形状渲染的标准参考实现**（`viewer.shapez.io`）；MIT（package.json） |
| **`tobspr-games/shapez-community-edition`** | 205 | shapez 官方停更后的社区版 | 承接官方仓库的活跃开发 | ★★☆☆☆ 【文档】CE 是独立于官方版的分支，**不合并**——我们的 bridge 若依赖内部 API，长期应关注 CE |
| `tobspr-games/shapez2-mod-samples` / `shapez2-shifter` | 18/14 | 官方 shapez2 mod 示例与 Modding API | 官方 | ☆☆☆☆☆ 是 shapez2 的，不适用（我们做 shapez 1） |
| `Sharaal/shapez.io` | 4 | 蓝图集合（染色/矿机各级） | 截图为主 | ★★☆☆☆ 【文档】人工蓝图参考，无代码 |

### 1.2 shapez 2 相关 —— 方法论可迁移

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| **`jiahao-0204/Shapez2-MIP-Miner`** | 26 | shapez2 小行星矿机布局优化 | **OR-Tools CP-SAT**（原 Gurobi，2025 迁移）；布尔变量 per (节点,方向)；流量守恒 = 每小时；目标分级加权 | ★★★★★ **CP 建模的直接模板**。§2.3 深挖 |
| **`jiahao-0204/Shapez2-MIP-Router`** | 14 | shapez2 路径路由 | **MILP + Gurobi**（README 明说开源 PULP 太慢、不优先支持） | ★★★☆☆ 建模思路可看；**但 Gurobi 依赖是坑** |
| **`cpcp1998/shapez2-solver`** | 2 | shapez2 **完备**枚举全部可造形状 + 构造步骤分解 | C++23；`CompactShape` uint64 2bit/part；半形状 BFS；**Algorithm A 全枚举 / Algorithm B 只找 PP-essential**；build_plan 回溯父指针 | ★★★★★ **完备性与状态压缩方法论**。§2.4 深挖 |
| **`cpcp1998/shapez2`**（2024 版） | 5 | 暴力枚举 shapez2 全形状 | C++；quad4 = 349M 形状 / ~1.5 min | ★★★☆☆ 枚举规模基准 |
| **`Vystel/shapez2-solver`** | 13 | 网页版形状求解（BFS 状态搜索 + cytoscape 流程图） | JS；BFS over 可达状态集，`_getSimilarity` 剪枝、`maxStatesPerLevel` 限宽、支持 splitter（吞吐减半） | ★★★★☆ **「可达状态集 BFS + 相似度剪枝」是 shapez1 配方搜索的直接算法模板**。§2.5 |
| **`CaptainFlint/shapez2-swapper-solver`** | 1 | 用 rotator+swapper 链把一组输入形状变成目标组 | Perl，BFS/DFS 组合搜索 | ★★☆☆☆ 特定子问题 |
| `xunmengXY/Shapez2` | 2 | 可编程的形状/流体机器库（C#） | 函数库 | ★★☆☆☆ 流程语义参考 |
| `Loupau38/shapez2-python`（PyPI `shapez2` 2.1.1） | 5 | shapez2 的 Python 库（蓝图编解码、资产、游戏码复刻） | Python | ★★★☆☆ **蓝图编解码 + 资产管线**参考；shapez2 格式与我们不同，但工程做法可看 |
| `DontMash/shapez-vortex` | 20 | shapez2 社区平台（查看/分享/修改内容） | Web | ★★☆☆☆ 社区工具形态参考 |
| `DontMash/shapez-viewer`（npm `shapez-viewer` 1.4.1） | — | 按形状 id 渲染模型 | TS/WebGL | ★★☆☆☆ shapez2 渲染；**npm 上月下载仅 62** —— shapez 生态的包极冷门 |

### 1.3 Factorio —— 规划研究的富矿（理论最近邻）

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| **`JackHopkins/factorio-learning-environment`(FLE)** | 1204 | LLM agent 评测环境（论文 arXiv:2503.09617） | Docker 集群 + Python REPL 动作空间 + 27 个工具 | ★★★★☆ **反面教材 + 工具设计参考**。§2.6 |
| **`alegnani/verifactory`** | 39 | **SAT 验证器**：证明蓝图性质（平衡性/等排空） | 蓝图→中间表示图→**z3 SAT**；64×64 平衡器 <1s | ★★★★★ **「验证 ≠ 模拟」的实证**：性质证明可离线、极快。正是我们 blueprint 级检查器该学的 |
| **`redruin1/factorio-draftsman`** | 185 | 成熟的 Factorio 蓝图操作库（PyPI） | Python，完整实体模型 + 蓝图编解码 | ★★★★☆ **蓝图库工程标准**（测试全面、mod 兼容）；我们的 SZBP1 工具可对照其 API 设计 |
| `demipixel/factorio-blueprint` | 112 | 老的 npm 蓝图库 | JS | ★★★☆☆ 同上（老） |
| **`Redcrafter/verilog2factorio`** | 830 | 把 Verilog 编译成 Factorio 蓝图 | Yosys → 电路图 → **布局生成器（退火/matrix/chunkAnnealing）** | ★★★★★ **「逻辑网表 → 空间布局」的成熟管线**，与「形状配方 DAG → 空间布局」同构。退火布局生成器可借鉴 |
| **`Snagnar/Factompiler`** | 421 | 蓝图编译器语言 | 编译原理 | ★★★☆☆ 【文档】DSL 设计参考 |
| `piebro/factorio-blueprint-visualizer` | 587 | 蓝图可视化（Python + web demo） | Python | ★★★☆☆ 渲染参考 |
| **`xaviershay/factorio-layout-designer`** | 9 | 「Foreman 的 web 移植」，解布局 | **or-tools（google CP-SAT）经 lambda 服务**；与游戏数据解耦 | ★★★★☆ **又一个 CP-SAT 解布局的实证**；「与游戏数据解耦」的设计哲学值得学 |
| **`Rotsor/factorio-lp`** | 0 | Factorio 的 LP 优化（OCaml） | Lisp 导出游戏数据 → LP | ★★★☆☆ 「从游戏导出数据再喂求解器」的流程 |
| `doomeer/factorio` | 142 | 经典 Factorio 规划器（算每分钟机器/原料数） | OCaml→JS；**只做配方计量，不做空间布局** | ★★★☆☆ 【文档】确认「计量」和「布局」是两个独立问题 |
| `PauJimeno/FactorioPlanner` | 1 | **SMT(z3) 编码**优化 blueprint 布局（本科论文） | z3 | ★★★☆☆ 又一个验证/优化的形式化先例 |
| `jwshields/factorio-solver` 等 ~15 个小仓库 | 0-1 | 配方计算/最优配比 | 各种 | ★☆☆☆☆ 大部分是教学项目 |
| `elemenohpi/FLE`, `Metta-AI/cogame-factorio` 等 FLE 衍生 | 0 | FLE 的分支/移植 | — | ★☆☆☆☆ |

### 1.4 Satisfactory —— 主要是 LP 配方优化，非布局

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| `Zistack/Satisfactory-Optimizer` | 16 | LP 优化工厂计划 | `scipy.optimize.linprog` | ★★★☆☆ 约束建模清单（"highly configurable set of constraints"）可看 |
| `TheoKanning/SatisfactoryOptimizer` | 7 | 配方优化器 | LP | ★★☆☆☆ |
| 其余 ~40 个 | 0 | 配方计算器/规划器 | 多为 LP | ★☆☆☆☆ **Satisfactory 生态几乎全是「配方计量 LP」，没有空间布局求解**——与 Factorio 的 verifactory/MIP 形成对比 |

### 1.5 跨游戏 / AI Agent

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| `lxshrd/factorio-agent` | 16 | OpenAI Agent SDK + RCON 玩 Factorio | LLM 工具调用循环 | ★★☆☆☆ 又一个「LLM 直控」实证，但**无验证器**——正是文献警告的模式 |
| `jevplay-games/jev-factorio-agent` | 4 | 「Jev 提目标，确定性代码掌游戏规则与执行」 | LLM 提议 + 确定性执行 | ★★★★☆ 【文档】**与我们的架构判断一致**，可引用为独立佐证 |
| `lvshrd` 同类、`HumanDotPy/FactorioAgentBench` | 0 | 评测平台 | — | ★☆☆☆☆ |
| `PrimeIntellect-ai/prime-agent`（arXiv:2608.23552） | — | 长程 harness，含 Factorio 实验 | IPython REPL + 子 agent | ★★★☆☆ 【文档】"refinement allows continuous technology progression" —— 提到 refinement 在 Factorio 上有效 |

### 1.6 「AI 玩 shapez」专用（极小众，全部低星）

| 仓库 | ★ | 一句话 | 方法 | **可借鉴点** |
|---|---|---|---|---|
| **`QXIKmIJ/shapez-ai`** | 0 | 「自主认知工厂建造器」：mod + WS RPC + A* + watchdog + MCP | Python 确定性 A* 曼哈顿路由（带转向惩罚）+ 形状分析器 + 自修复 + 本地 LLM 策路层 | ★★★★☆ **架构同构竞品**。§2.7 |
| `Corezsl/ShapezAI` | 0 | 探索用遗传算法进化工厂布局 | 【文档】README 只有描述，**仓库只有 `.gitattributes` + README，无代码** | ★☆☆☆☆ **空仓库**——列为反面发现 |
| `sophuric/shapez-finder`, `AyrA/shape-finder` | 2/0 | 找地图上的形状矿脉 | — | ★★☆☆☆ 资源选址工具（与我们 `resources` 观测重叠） |
| `Emily`-系 / cheat 仓库（`Maxmeister/Shapez-2-Cheat` 等） | 0-1 | 修改器 | — | ☆☆☆☆☆ 忽略 |
| `AbandonedCity/Factorio-AI-Bot-Generator` | 0 | 「异形工厂ai」实为 Gemini AI Studio 模板 | — | ☆☆☆☆☆ **标题党，无内容** |

---

## 2. 重点仓库深挖

### 2.1 `Songxwn/shapez-auto` —— 【实测】与我们目标逐字相同的前作 ★最优先

**元数据**：MIT，Go + 单文件游戏内 mod（`assets/shapez-auto.js`，657 行），
创建 2026-10-14、最后推送 2026-10-14，**0★**（极新，未被社区发现）。`minimumGameVersion: ">=1.5.0"` —— 与我们的 1.5.6 兼容。

**它做什么**（README + 实测源码）：控制面是 Windows 程序（Go HTTP server，端口 17831）；mod 每 1.2s 向控制面 POST 一个 `snapshot`
（level / goal shape / rewards / resources / delivered），控制面返回 `plan`（建筑放置列表 + 加速倍数），mod 在 `performBulkOperation` 里**全清再全建**。

**三层架构（实测文件结构）**：
```
internal/shape/shape.go      — 形状代数（Parse/Hash/Rotate/Cut/Paint/Stack/Mix）   ← 与游戏语义核对过
internal/plan/solve.go       — 确定性求解器：目标 short key → 加工树 Op
internal/plan/layout.go      — 加工树 → 空间布局（A* 路由 + 候选位搜索）+ 连 hub
internal/plan/plan.go        — Compile()：求解 → 布局 → 出 placements；LLM override 优先但需验证
internal/llm/llm.go          — OpenAI 兼容客户端 + 系统提示词（中文）
internal/server/server.go    — 控制面 + pace（判断吞吐不够→提高 warp/copies）
assets/shapez-auto.js        — 游戏内 mod：snapshot / apply / fixDelivery / setWarp / buyUpgrades
```

**求解器（`solve.go`）的算法，值得逐条学**：
1. `solveMemo`（记忆化）+ 分派 `solveOnce`：
   - 单层 → `solveLayer`；多层无悬空 → `stackLayers`（逐层堆，**并 eval 检查是否塌**）；
   - 有悬空且左右不对称 → `pinAndCut`：**在空象限放一个"支撑"方块的形状来反推**——把每层补上支撑象限 → 逐层堆 → 最后整体切掉支撑侧，得到悬空象限。这是形状代数里唯一能造悬空的路径；
   - 单元格数 ≤ 14 → `splitStack`：**枚举 2^n 个子集**（n≤14），找出可拆成 lower/upper 的二分，递归。
2. `solveLayer`：4 格同色 → `paintedMine`；2 格 → `solvePair`（用 cutLeft/cutRight + 旋转匹配 4 种半形）；1 格 → `quadrant`（整块 → cutRight → 转 90° → 再 cutRight → 转到目标象限，**两次切割得 1/4**）。
3. `colorOp`：r/g/b → mineColor；y/p/c → mix；**w → mix(mix(r,g), b)**。

**布局（`layout.go`）**：每个 Op 返回一个「出口」`outlet{At, In}`；`placeConnected` 在候选位（螺旋外扩到 r=120，最多 80 个）试放机器 + 用 `route()`（**带前向格检查的 A***，防止起点朝向堵死）连上子出口；`connectHub` 先试南侧直线走廊，失败则换其他三边 16 个进料口。**多副本 `LayoutCopies`（最多 4 条并行线，各从不同方向进 hub）**——这解决吞吐关。

**LLM 的角色（这是最值得抄的一点）**：
- 提示词让 LLM 输出**加工节点 DAG**（`mine-shape/cut-left/rot-cw/paint/stack/mix/deliver`）——**不是坐标**；
- 返回后 `ParseProgram` 编译成 Op，**用 `Eval` 演算**，**只有 `got.Form.Hash() == target` 才接受**（`plan.go:104-119`）；
- 验证不过 → 静默回落到**内置求解器**；LLM 唯一被接受的贡献是「不同的拓扑/comment/copies」。
- `pace`（`server.go`）监测交付进度，停滞就发 hint 让 LLM 提高 `copies`。
- **这就是 LLM-Modulo 的教科书实例**，且是工厂游戏的——可直接引用为「我们不是第一个这么做、且这么做可行」。

**mod 端的两个可复用技巧（`shapez-auto.js`）**：
- **`setWarp`**：monkey-patch `root.time.speed.getTimeMultiplier` 与 `getMaxLogicStepsInQueue` 来加速 —— 与我们的 `set_speed/step` 目标相同但**机制不同**（它改倍率，我们复刻 puzzle 校验循环）。**注意**：它这样加速会改变 tick 行为；我们若不需要，保持现有快照循环更稳。
- **`fixDelivery` / `swapWrongOutput` / `routeOutputsToHub`**：观测 **belt 上实际形状**（`beltShape` 读 `Belt.assignedPath.items`）判断成品颜色对不对，不对就**现场换出口/接回 hub**——这是「观测驱动纠错」的完整实例，补上了我们 obs 缺的「传送带上实际在跑什么」。**这是我们观测升级该做的第一件事**【推断+实测】。
- **`hubFeedTiles`**：用 `hub.components.ItemAcceptor.slots` + `localTileToWorld/localDirectionToWorld` **从组件系统读**进料口，而不是硬编码 `sideFeeds` —— 比 QXIKmIJ 的硬编码 `hub_bounds(-2,-2,4,4)` 更稳。我们的 mod 应采用此法。

**结论（借鉴/避免）**：
- **借鉴**：① 求解器三层（层次/悬空 pinAndCut/子集拆分）② LLM 只出 DAG 且验证后才用 ③ 从 `ItemAcceptor.slots` 读 hub 口 ④ 读 belt 上实际形状做纠错 ⑤ 单文件 mod + 外部控制面（与我们同构，交叉验证了架构选择）。
- **避免**：① **全清再全建**（它每关清空整厂导致无法增量升级）② monkey-patch 时间倍率（改变物理）③ 硬编码 26 关流程、无失败回退的鲁棒策略（它的 `missed` 计数只在跑偏时才触发修复）。
- **对我们最大输入**：**它的 `TestStoryShapes` 列出了 26 个真实关卡形状序列**（`plan_test.go:42-69`），可直接复用为我们的「关卡形状回归集」。

### 2.2 `TomasSirgedas/Shapez-solver` —— 【实测】shapez 1 配方求解的参考实现 ★

**元数据**：Unlicense（public domain，**可自由挪用**），C++ 生成器 + 静态网页；2022-03 后未更新。**6★**。

**核心方法（读了 `main.cpp` 全文 + HTML 关键段）**：
- 形状用 **uint16** 表示（4 层 × 4 bit，每 bit = 一个象限有/无内容）；**颜色与形状类型被抽象掉**（`Layer::str()` 全部输出 `Cu`/`--`）。
- **预计算**：`generateRecipesFile()` 做**按代价分层的 BFS**（`q[cost]` 桶），操作只有：rotate×3（cost 0）、cutLeft/cutRight（cost 1）、stack（cost 1）；每个形状记录首次到达时的 `<a, b, op, mapping>`（**mapping = 每个输入象限最终落在输出哪个位置**，这是 reverse-mode 的关键）。
- 结果 `recipes_0_1_1.bin` —— 【实测】文件大小 327680 B = 65536 × **5 字节**，正是 `#pragma pack(1)` 下的 `Recipe{uint16 a; uint16 b; uint8 op}`。
- **网页端**：加载 bin（含优化变体 `0_9_1`=最小化切割、`0_1_9r`=任意单层可作原料），用 `codeForShape(shape, finalTarget, mapping)` **把无色形状映射回目标颜色** —— 即**用无色彩的"骨架配方" + 映射表推导出彩色蓝图**。
- **它直接输出游戏内蓝图的 JSON**（`Building.toJson()`，含 `StaticMapEntity/origin/rotation/code`），用的是 `FatcatX's Blueprint Strings` mod 的格式（1.5 前）。`ConstantShapeSignal` 用**常量形状信号**作为原料源——即它不模拟矿脉，而是假设原料可得。

**局限（实测）**：
- **不含颜色运算（painter/mixer）**：颜色通过 mapping 直接"贴"到最终形状上，因为 1.5.6 之前的配方场景认为「颜色是后处理」。**对 1.5.6 的真实关卡不够**（painter 有吞吐/输入限制）。
- 蓝图布局是**递归拼积木**（`bluePrintFor` 每个 op 摆一个固定小模块，左右拼），**不做全局优化**——比 `shapez-auto` 的 A* 布局弱。
- 4 层上限、无悬空层支持（`hasFloatingLayer` 只是检查，无法构造）。
- 网页是 ES5 直写游戏代数（`fromShortKey`、`normalizeShortKey`、`renderShape`），**这份 JS 是从游戏源码 1:1 抄的**，可以直接拿来做验证器。

**可借鉴**：① **uint16 + 无色彩抽象**的状态压缩（我们求解器可这样把状态空间砍到 65536）；② **cost-bucketed BFS + first-visit 记录** = 做我们自己的配方表；③ **mapping（象限置换表）** 是 reverse-mode 传播颜色的优雅做法；④ `building codes`（`CUTTER=9, ROTATOR_1=11, ROTATOR_2=13, ROTATOR_3=12, STACKER=14, TRASH=20, PRODUCER=61`）【待验：1.5.6 的 code 表可能变了】。

### 2.3 `jiahao-0204/Shapez2-MIP-Miner` —— 【实测】CP-SAT 建模模板 ★

**元数据**：MIT，Python（FastAPI + OR-Tools），26★，有线上版 shapez2-tools.com；作者是 QS 背景（仓库列表见 §1.2）。**已从 Gurobi 迁到免费 CP-SAT**（README 明说 `pip install ortools`）。

**模型（读了 `app/astroid_solver.py` 的建模部分）**：
- 变量：每个 (节点, 方向) 一个 Bool——`miner_x_y_dx_dy` / `extender_x_y_dx_dy` / `belt_x_y_dx_dy`；每个方向一个 Int——`flow_x_y_dx_dy` ∈ [0, BELT_MAX_FLOW]。
- 节点唯一性：`sum(belts) + sum(extenders) + sum(miners) + elevator ≤ 1`。
- 流量守恒（按用途分派，`OnlyEnforceIf`）：belt：`out - in == 0`；extractor：`out - in == 1`（每台矿机产 1）；elevator：`out == 0`。
- 容量：extractor `out ≤ 4`；belt `out ≤ BELT_MAX_FLOW (12*4)`。
- 方向一致性：`flow > 0 ⇒ 该方向至少有一个实体`（用 `flow_greater_than_zero` 辅助布尔）。
- 交互约束：extender 末端必须是 extractor；**miner/belt 末端不能是 extractor**（防重叠）。
- 目标：`max 1e9 × (miners+extenders) + (saturation bonus)`，饱和 bonus 也是分级加权（4 饱和×1e6, 3×1e4...）—— **分级加权求和是处理多目标的标准做法**。

**附带资产（实测 `blueprint_composer.py` / `astroid_parser.py`）**：
- **蓝图编解码**：`SHAPEZ2-5-` + base64(gzip(JSON))，带正则兼容新旧格式 —— **这是 shapez2 的格式；shapez1 的 SZBP1 是 LZString，不同**（别混淆）。
- `get_brush_blueprint(10)`：生成 10×10 的"刷子"蓝图让玩家在游戏里刷出矿位——**用蓝图当输入设备**的巧思。
- `astroid_parser.py` 用 OpenCV 模板匹配 + `peak_local_max` 从**截图**提取矿机坐标 —— 截图→语义的完整流程。

**可借鉴**：① **建模清单**（上面 8 条可直接映射到 shapez1 的 belt/miner/cutter 布局，只是约束不同）；② 分级加权多目标；③ 迁移到 CP-SAT 的经验（免费、快）；④ `belts 上限 = 12×4` 这类**从游戏读常量**的习惯。

### 2.4 `cpcp1998/shapez2-solver` —— 【实测】完备枚举方法论 ★

**元数据**：C++23，**未标 license**【注意：不能直接抄代码】，2★，2026-04 更新。用它自己的说法：「exhaustive enumerator and solver for all buildable shapes」。

**方法论（README 详述 + 我读了全部 README）**：
- **`CompactShape` = uint64，2 bit/part（EMPTY/NORMAL/PIN/CRYSTAL）** —— 只保留影响「可构造性」的特征，丢弃形状类型与颜色（理由：所有 normal part 在操作下行为一致；painter 可任意改色）。
- **两段式搜索**：先 `half search`（BFS, Ops 1-5 + 外层 Op 6 发现需要跨边界锚的半形），再 `Algorithm A`（全枚举）或 `Algorithm B`（**只找 PP-essential**）。
- **关键洞察：「PP-essential」**（pin-push-essential）= 既非 swappable（可用 swapper 从两个半形拼）又非 stackable（可分解为 base + stacker）的形状。**只枚举这几千个，就能分解任意可造形状**（Quad4: 504 个；Hex4: 180146 个；Quad7: 144M）。**这是完备性与可行性的平衡点**。
- **canonical form**：所有旋转/镜像下的最小 `CompactShape` 值——**同一形状只存一份**；half-canonical：只保留保半边的两个朝向。
- **`build_plan` 从父指针回溯构造步骤**（含 `[swap] [cut_east] [stack] [pin_push] [rotate_cw N] [input]` 等 op）——**输出的是人类可读的构造计划**。
- **`verify` 子命令**：交叉验证（full_set ⊇ PP；每个 half/PP 都能出合法 plan；**检测 PP 父链上的环**）。
- **性能实测**（README 表格）：Quad4 半形 16193 个、总形状 44M、非 swappable 2M、PP 仅 504 个（**半形搜索 0.02s，全集 1.05s，PP 2.88s**）。

**对我们的意义**：
- shapez 1 的 2^16 空间**太小了**（LeopoldTal 已 BFS 闭包），不需要这套完备框架；**但它证明了「先压缩特征 → 半形闭合 → 只枚举关键节点」这条路线对形状问题可行且高效**。
- **`verify` 的思想**（对每个解回放验证 + 检测环）应成为我们配方编译器的单元测试模式。
- **反例警告**：「全枚举」在层数/分片数增长时爆炸（Quad6 = 1M 半形、Quad7 = 8M；Hex4 全集 633G）——**不要为 shapez1 做全枚举内存表，用按需 BFS**【推断】。

### 2.5 `Vystel/shapez2-solver` —— 【实测】可达状态 BFS 的算法模板 ★

**元数据**：MIT，纯 JS（worker 里跑），13★，2026-10 更新。

**算法（读 `shapeSolver.js`）**：
- 状态 = **当前可用的形状集**（含各自吞吐），起点 = 玩家给定原料集；
- **BFS over 状态**（不是 over 形状）：`queue` 按 depth 分层，`visited` 用 `getStateKey`（排序后的形状列表）；
- 扩边：对每个 op（Rotator/Cutter/Half Destroyer/Swapper/Stacker/Painter/Pin Pusher/Crystal Generator）在可用形状上施加，得新状态；
- **剪枝**：`calculateStateScore` = 平均相似度（`_getSimilarity` 到目标），`pruneStatesAtDepth(maxStatesPerLevel)` **按相似度排序保留前 N 个**；
- `checkGoal`：目标形状能被可用形状覆盖（**接受所有旋转等价**，`targetAcceptableSets`）；
- **`allowSplitting`**：splitter 把形状复制两份、吞吐减半——**用吞吐做资源核算**（`tp` 累积），`preventWaste` 拒绝产出无用形状的分支；
- `mixingSolver.js` 单独做**颜色混合 BFS/DFS**（`MIX_PAIRS` + `isGoal` 计数覆盖）。

**可借鉴**：① **状态 = 形状多重集（带吞吐）** 而非单个形状 —— 这对「多产物/并行产线」是必要的表达力；② 到达目标即停 + 相似度剪枝（我们的 `await` 验证是更强的剪枝：直接跑模拟）；③ **颜色子问题独立求解**（染料链和形状链分开）—— 我们的库已有 Mix 的概念，但可显式分治；④ `shapeOperations.js`（737 行）是 **shapez2 操作语义的完整实现**，形状/颜色/pin/crystal/gravity 齐全。

### 2.6 `JackHopkins/factorio-learning-environment` (FLE) —— 【实测部分源码】反面教材 + 工具设计 ★

**元数据**：1204★，arXiv:2503.09617。核心包 `pip install factorio-learning-environment`。

**它的结论（论文摘要，已读）**：
- 「models **still lack strong spatial reasoning**」；lab-play 短程可以、受限环境失效（**error analysis 缺陷**）；open-play 能发现用电挖矿等策略，**但无法完成复杂自动化（电子电路制造）**。
- 历史结论（前研究已引用）：**LLM 不适合做独立规划器**——FLE 是这条结论的工厂游戏专证。

**它的工程做法（读了 `connect_entities` 工具源码）**：
- REPL 动作空间：agent 发**一段 Python**，环境执行并返回 stdout/stderr —— 与我们「让 LLM 出 DSL 程序」思路一致，但**它没有 shapez 那样的精确 verifier**（Factorio 里验证=跑起来看）。
- `connect_entities`：一个**通用连通工具**（transport/fluid/power/wall 四种 resolver），自动处理**实体朝向、绕障、组管理、资源检查**——**这正是我们 `place_path` 该长成的样子**（我们的 `place_path` 只做轴对齐直线；FLE 的 resolver 做障碍绕行 + 朝向推导 + 类型分派）。**可直接借鉴其"连接语义 = 源/目标/类型"的抽象**。
- `nearest_buildable(entity_type, building_box, center)`：**「给我一个能放下 X 的位置」**——比我们逐格 `place` 试错更高效。**建议我们加一个 `find_place` 观测/动作**。
- `agent.md` 工具文档 + `GENERAL_INSTRUCTIONS_BACKTRACKING` 提示词要求「PLANNING + POLICY 两阶段、**最多 20 行代码**、报错后只改第一段短程序」——**是针对 LLM 短程失败的对症设计**。

### 2.7 `QXIKmIJ/shapez-ai` —— 【实测】架构同构竞品 ★

**元数据**：Apache-2.0（但有 `NOTICE` 声明"架构受作者专利保护"——**【推断】这种声明在法律上存疑，但**引用代码前需读 NOTICE**），0★，创建 2026-10-16，是**俄语/中文注释**的项目。

**架构（实测）**：`mod/shapez-ai-bridge.js`（1262 行，class Mod extends shapez.Mod）↔ WebSocket `ws://127.0.0.1:8765` ↔ Python（aiohttp）：`bridge/ws_server.py`、`planner/router.py`（924 行 A*）、`planner/shape_analyzer.py`、`supervisor/watchdog.py`（433 行自修复）、`supervisor/tools.py`、`mcp_server.py`（5 个 tool）。

**它做了什么（实测）**：
- **A* 曼哈顿路由**：状态含方向，**转向惩罚 1.5** 让路径"美观"；`path_to_belts` 按进出向量算 `rotation` + `rotationVariant`（左转=1/右转=2/直行=0）——**与我们的 belt 定向逻辑同一份知识**。
- **机器几何硬编码**：`get_cutter_geometry(rot, keep_half)` / `get_painter_geometry(rot)` 把 4 个旋转下 cutter/painter 的**占地、输入口、丢弃口、输出口**都写死——**分解出"每个旋转下每个口在哪"是布局求解的必要表**（我们的 repo 尚无此表）。
- **形状分析器**：`analyze_target_goal(target_code)` 把目标分成 `raw / paint / mix_and_paint / cut / cut_and_paint` 五类，**逐类处理**——这是"有限分类 + 特化处理"，**比我们的"通用求解器"上限低但落地快**。
- **watchdog**：监测人类干预（`entityDestroyed` 信号）、交付延迟（`transit_time_est = max(4.0, dist/2 + 3)`）、产线停顿，**自动重铺**。
- **`eval_code` RPC**：在游戏里 `new Function("root","bridge", code)` 执行任意 JS——**危险的通用逃生舱**；我们**不应**提供（无审计、易断）。
- **MCP server**：`get_game_state / plan_and_build / inspect_tile / eval_code / list_sessions / get_session_state` —— **与我们 MCP 的定位完全一致**。

**它的局限（实测）**：
- **无 stacker 支持**（`shape_analyzer.py` 里没有 stack）——**只能做单层形状**，到多层关卡就废了（对比 `shapez-auto` 的 `stack` 完整实现）。
- 硬编码 hub `(-2,-2,4,4)`；硬编码 raw 候选 `["CuCuCuCu","RuRuRuRu","SuSuSuSu","WuWuWuWu"]`。
- **无 `step/await` 快进**（grep 确认不存在）——它靠实时帧 + 心跳 1.5s 观测，**没有我们"同步确定性快进"这个反脆弱性关键武器**。

**对我们的意义**：**它是一个"我们如果偷懒会做成的样子"**——有路由有 mod 有 MCP，但缺 stacker、缺快进、缺完备求解。**我们已在设计上超过它**；它的价值在于（a）交叉验证 A* 路由和机器几何表必要；（b）它的 `analyze_target_goal` 分类可以借鉴到"快速路径"（先处理简单目标，再升级到通用求解）。

### 2.8 `alegnani/verifactory` + arXiv 2310.01505 —— 验证与 CP 的实证 ★

- **VeriFactory（39★）**：把蓝图转图 → **z3 SAT 编码** → **证明**「这是一个平衡器」「输入等排空」「吞吐无上限」「通用平衡器」。README 称 64×64 平衡器**<1s** 完成验证，「因为不需要尝试所有组合来模拟」。**对我们**：belt 层面的性质（如「这条线不会堵」「这个 balancer 是 n:m」）可以**离线 SAT 验证**，而不是靠跑模拟——比 `await` 更便宜【推断，未实测】。
- **arXiv:2310.01505「Towards Automatic Design of Factorio Blueprints」**（2023-10）：「an optimal blueprint is a **hard combinatorial problem, interleaving elements of bin-packing, routing or network design**」，探索 **constraint model** 去优化。「balancing correctness, optimality, and performance」。**这是「为什么该用 CP/MIP」的权威引用**，前研究未收录（我确认 `04-ai-planning-research.md` 中 0 命中）。
- 其他我新找到、前研究未收录的：**arXiv:2102.04871「The Factory Must Grow: Automation in Factorio」**（定义「logistic transport belt problem」并给出**整数规划模型** + 模拟退火/遗传编程/进化 RL 基准）；**arXiv:2005.03192**（Factorio 的 PSPACE-completeness，**证明布局问题难度**）；**arXiv:2404.05472「The steady-states of splitter networks」**（splitter 网络稳态可计算 + 负载均衡下界 Ω(n log n)）；**arXiv:2610.05569「Factoriax」**（GPU-JAX factory RL 模拟器；**PPO 训完仍不会摆功能性布局**）；**arXiv:2502.01492**（主张用 Factorio 训练"系统工程" agent——与 FLE 同旨）。

---

## 3. 可复用资产（可直接用的库/数据）

| 资产 | 出处 | 许可 | 用途 | 状态 |
|---|---|---|---|---|
| **`recipes_0_1_1.bin` (+`0_9_1`/`0_1_9r`) & `shape_is_possible.bin`** | `TomasSirgedas/Shapez-solver` | **Unlicense（public domain）** | shapez1 全部形状的**最优配方表**（无色彩骨架），**可直接读** | 【实测】文件在仓库根，327680 B |
| **`possible_shapes.marshal` + `map-construction.py`** | `nedsociety/shapezio-shape-construction` | Unlicense | BFS 构造表反查；`map-construction.py SHAPECODE` 出步骤 | 【实测】已在本地 clone 验证 |
| **`shapez_solver.html` 里的 JS 游戏代数**（`fromShortKey`/`renderShape`/`normalizeShortKey`） | 同上（1:1 抄自游戏源码） | Unlicense | **离线形状渲染与解析** | 【实测】读了函数 |
| **官方 `shapez.io-viewer` 的 `index.js`** | `tobspr-games/shapez.io-viewer` | MIT（package.json） | 权威渲染（颜色 hex、quadrant offset、多层绘制） | 【实测】已下载 tarball |
| **`shapezTools/shape database/shapes.json`** | `MengLeiFudge/shapezTools` | — | 中文社区形状库 | 【文档】 |
| **CP-SAT 建模 + 蓝图编解码 + 刷子蓝图** | `Shapez2-MIP-Miner` | MIT | CP 建模清单；蓝图 gzip+base64 手法 | 【实测】代码已读 |
| **`CompactShape`/PP-essential/verify 方法论** | `cpcp1998/shapez2-solver` | ⚠️ **无 license** | 方法论借鉴（**不可抄码**） | 【实测】 |
| **shapez2 操作语义完整实现（含 gravity/pin/crystal）** | `Vystel/shapez2-solver` `shapeOperations.js` | MIT | 若做跨版本 | 【实测】 |
| **`shapez2` Python 库（PyPI 2.1.1）** | `Loupau38/shapez2-python` | — | 蓝图编解码参考 | 【文档】 |
| **`factorio-draftsman`（PyPI）** | `redruin1` | — | 蓝图库 API 设计参照 | 【文档】 |
| **FLE `connect_entities` / `nearest_buildable` 设计** | FLE | — | 连接语义抽象 + "找位"工具 | 【实测】源码已读 |
| **26 个真实关卡形状序列** | `shapez-auto/plan_test.go:42-69` | MIT | **关卡形状回归测试集** | 【实测】 |

**npm/PyPI 生态结论**：`npm search shapez` 里除了 `shapez-viewer`（**月下载 62**）几乎全是无关包；`pip shapez2` 是唯一正经的 shapez 包（shapez2 专属）。**npm 上 `factorio-blueprint` 类老旧**。→ **shapez 生态没有现成的 npm/pip 包可用**，我们自己的 bridge/agent 就是「生态里最完整的那一份」。

---

## 4. 结论：该借鉴什么 / 避免什么 / 别人做完了什么

### 4.1 「别人已经做完了」的部分（必须承认）

| 问题 | 现状 | 我们的差异化 |
|---|---|---|
| **形状配方求解（shapez 1）** | **已存在**：`Shapez-solver`（最优配方表，公开域）+ `shapezio-shape-construction`（BFS 表） | 差异：他们**忽略颜色/不接真实游戏状态**；我们要的是**在线、按解锁进度、含颜色、直接出 `place`** 的编译器。**先把他们的 `.bin` 读进来对答案**（低成本、高价值回归） |
| **LLM 设计产线 + 验证 + 自动通关** | **已存在**：`Songxwn/shapez-auto`（**目标逐字相同**，MIT） | 差异：它**全清再全建**、无增量升级、无 `step/await` 快进、无 MCP/可编程界面、硬编码 26 关。**我们的产品形态（可编程接口 + 观测算子 + 确定性快进）仍有位置**；但它证明**核心闭环可行** |
| **游戏内 mod + 外部 RPC + MCP + A* 路由** | **已存在**：`QXIKmIJ/shapez-ai`（架构同构） | 差异：**它没有 stacker、没有快进、没有完备求解、没有 LLM 验证门**。我们的 stacker + step/await + verifier 是硬优势 |
| **工厂布局的 MIP/CP 建模** | **已存在**：MIP-Miner（CP-SAT）、MIP-Router（Gurobi）、factorio-layout-designer（or-tools）、verifactory（z3） | 差异：**都是 shapez2/Factorio，没有一个是 shapez1 的 1.5.6 + 我们的 API**。建模清单可抄，**实例化没有现成的** |
| **形状渲染** | **已存在且权威**：官方 `shapez.io-viewer`（MIT） | 差异：不需要重造；**直接拿来用或抄** |

### 4.2 该借鉴什么（按优先级）

1. **【最高】抄 `shapez-auto` 的求解器分层设计**（`solve.go`）：层次堆叠 / `pinAndCut` 造悬空 / `splitStack` 子集二分 / `quadrant` 两次切割。**它是 shapez1 语义下已验证可行的确定性求解器**（`TestStoryShapes` 覆盖 26 关）。
2. **【最高】抄它的「LLM 只出 DAG + Eval 哈希验证后才接受 + 失败回落确定性解」模式**——这正是 `04-ai-planning-research.md` 推导出的 LLM-Modulo 架构，**现在有了工厂游戏的实证**（`plan.go:100-125`）。
3. **【高】读进 `recipes_0_1_1.bin`（public domain）做交叉验证**：我们的求解器输出 vs 公开域最优表，**免费的真值回归集**。
4. **【高】从 `ItemAcceptor.slots` 读 hub 进料口**（`shapez-auto.js:hubFeedTiles`）替代硬编码 —— **我们 obs/plan 的 hub 口应当是派生的**。
5. **【高】读 belt 上的实际形状做纠错**（`beltShape` via `Belt.assignedPath.items`）—— 我们 `obs` 目前只有实体列表，**缺"在传送带上跑的是什么"**；这是解释"为什么交付不涨"的关键观测。
6. **【中】FLE 的 `connect_entities`/`nearest_buildable` 抽象** → 我们的动作原语升级方向（"给我连上 A 和 B" / "给我找一个能放下 X 的地方"）。
7. **【中】CP-SAT 建模清单**（MIP-Miner）用于未来「布局最优性」需求（比如"用最少带子连通 N 条线"）。
8. **【中】`analyze_target_goal` 的分类快速路径**（QXIKmIJ）：简单目标直接映射到固定拓扑，复杂目标才进通用求解器。
9. **【低】`verifactory` 的 SAT 性质证明思路** —— 长期方向（证明"线不堵"），短期用模拟更直接。

### 4.3 该避免什么

1. **不要做全枚举内存表**：Quad7 需要 144M PP-essential、Hex4 需要 633G 形状 —— **shapez1 的 2^16 已有人做完（读 bin 即可）**，我们不需要重复；更不要说 shapez2 规模。
2. **不要依赖 Gurobi**：`MIP-Router` 明说开源替代（PULP）"不适合中等规模" —— **一律用 OR-Tools CP-SAT**（`MIP-Miner` 已示范迁移）。
3. **不要做 `eval_code` 逃生舱**（QXIKmIJ 的做法）：无审计、版本一换就断。
4. **不要 monkey-patch 时间倍率**（`shapez-auto.setWarp`）：改变游戏物理；**我们的 `step`（复刻 puzzle 校验循环）是更干净的快进机制**。
5. **不要全清再全建**（`shapez-auto.apply`）：丧失增量升级能力；**我们应做增量 patch**（这正是我们桥接已有 `place/delete/region` 原语的优势）。
6. **不要做「LLM 直接摆坐标」**：`lvshrd/factorio-agent` 是这条路（LLM 直控 RCON），而 FLE 的结论 + `shapez-auto` 的验证门都指向反面。
7. **不要相信遗传算法/RL 方案**：`Corezsl/ShapezAI`（遗传算法）**是空仓库**；`Factoriax` PPO 训练后**仍不会摆布局**；Satisfactory 生态 40 个仓库全是 LP 配方、无人用 RL 做布局。**证据一致**。
8. **不要抄无 license 的代码**：`cpcp1998/shapez2-solver` 无 license（方法论可学，码不可抄）；`QXIKmIJ/shapez-ai` 有 Apache-2.0 但附专利声明（引用需谨慎）。
9. **不要无视 `Shapez2-MIP-Miner` 的 Gurobi 遗留**：它的新代码是 CP-SAT，**旧 README 段落仍在讲 Gurobi** —— 读时要看代码不看 README【实测：两者已不一致】。

### 4.4 时间线旁注（值得警惕的巧合）

- `QXIKmIJ/shapez-ai`：创建 **2026-10-16**，mod 文件 `shapez-ai-bridge.js`。
- `sqkl520/shapez-ai-bridge`（**本仓库**）：创建 **2026-10-20**，mod 文件 `shapez-ai-bridge.js`。
- `Songxwn/shapez-auto`：创建 **2026-10-14**。
- 【推断】**2026 年 10 月中旬至少有 3 个团队/个人在做"AI 玩 shapez"**。这既说明**时机成熟（技术可行）**，也说明**"第一个做出来"的窗口在关闭**。差异化必须靠：**stacker/多层 + 确定性快进 + 可编程接口（MCP）+ 增量升级**，而不是"能不能让 AI 摆一条带子"。

---

## 5. 访问过的源（实际命令/URL）

**gh CLI 搜索（节选，全部实跑）**：`gh search repos` × 关键词：
`shapez`（50 条全读）、`shapez2`、`shapez solver/optimizer/planner/bot/AI/agent/automation/factory/blueprint/viewer/llm/gpt/mcp/script/level/competition/challenge/leaderboard`、
`shapezio`、`shapez.io`、`异形工厂`、`factorio layout/optimizer/planner/solver/blueprint/agent/constraint/cp-sat/learning environment`、
`satisfactory factory planner/optimizer`、`factory game AI`；
`gh search code`：`shapeActionStack`、`SZBP1`、`shapez shapeActionCutHalf`。

**clone 并读源码（实测）**：
- `https://github.com/Songxwn/shapez-auto`（全仓库读：solve/layout/plan/llm/server/shape/mod）
- `https://github.com/TomasSirgedas/Shapez-solver`（main.cpp + shapez_solver.html）
- `https://github.com/nedsociety/shapezio-shape-construction`（3 个 py）
- `https://github.com/QXIKmIJ/shapez-ai`（router/shape_analyzer/watchdog/tools/mcp/main/mod）
- `https://github.com/jiahao-0204/Shapez2-MIP-Miner`（astroid_solver/astroid_parser/blueprint_composer）
- `https://github.com/Vystel/shapez2-solver`（shapeSolver/shapeOperations/shapeConstants）
- `https://github.com/LeopoldTal/shapezio-scripts`（shapesearch.py）
- `https://github.com/JackHopkins/factorio-learning-environment`（tarball 79MB；connect_entities/nearest_buildable/backtracking_agent）
- `https://github.com/tobspr-games/shapez.io-viewer`（tarball；index.js/package.json）
- `https://github.com/jiahao-0204/Shapez2-MIP-Router`（README 全文）
- `https://github.com/cpcp1998/shapez2-solver`（README 全文，含 benchmark 表）

**curl（白名单域名）**：
- `https://registry.npmjs.org/-/v1/search?text=shapez&size=25`（实测：`shapez-viewer` 1.4.1, MIT, 月下载 62）
- `https://registry.npmjs.org/-/v1/search?text=factory%20planner`（无相关）
- `https://pypi.org/pypi/shapez2/json`（`shapez2` 2.1.1）
- `https://export.arxiv.org/api/query?search_query=all:factorio`（返回 10 篇，全部读摘要）
- `https://export.arxiv.org/abs/2310.01505`（CP 优化 Factorio 蓝图，摘要实读）
- `https://codeload.github.com/...`（tarball 下载）
- `https://shapez.io/`（**返回 demo 页 HTML，无 AI 内容**）
- `https://shapez.io/modding.html` / `modding` / `modding/` / `wiki/` → **全部 404**（负面结果：官方 mod 文档 URL 已失效；mod 文档实际在 `https://github.com/tobspr-games/shapez.io/tree/master/mod_examples`，`gh api` 实测 20 个示例文件）
- `https://viewer.shapez.io/` → **200**
- `https://shapez2-tools.com/` → 200（MIP-Miner 的线上版）
- `https://shapez.mod.io` → **连接失败（000）**——shapez mod 站可能已下线【待验】
- `https://tomassirgedas.github.io/Shapez-solver/shapez_solver.html` → **200**（线上求解器可用）

**本地核证（recon/bundle.pretty.js，1.5.6 @ ee2279d）**：
- `performBulkOperation` :29456 / `checkCanPlaceEntity` :29589 / `tryPlaceBuilding` :29425 —— **QXIKmIJ 与 shapez-auto 用的内部 API 在 1.5.6 全部存在**
- `signals`: `entityDestroyed` :3504、`upgradePurchased` :3512、`shapeDelivered`、`storyGoalCompleted`、`bulkOperationFinished`、`preEditModeChanged`
- `hubGoals.tryUnlockUpgrade` :28135 / `canUnlockUpgrade` :28115 / `getUpgradeLevel` / `isRewardUnlocked` / `getCurrentGoalDelivered`
- `productionAnalytics.getCurrentShapeRateRaw` :7690 + **`analyticsSliceDurationSeconds: 10`** :880（**单位核对【实测】：游戏自己的 HUD 在 :16482 用 `raw / analyticsSliceDurationSeconds` 得到 shapes/秒；而 QXIKmIJ 的 mod（`shapez-ai-bridge.js:501-504`）把 raw 值直接当 rate 塞进 heartbeat —— 差 10 倍的单位错误**。我们若用这个 API 必须除以 10）
- `getBeltBaseSpeed` :28201 = `2 × upgradeImprovements.belt`（`beltSpeedItemsPerSecond: 2` :888 是基准）
- `_getBeltBaseSpeed`/`getMinerBaseSpeed`/`getUndergroundBeltBaseSpeed` 都在 `hubGoals` 上
- 奖励 id 全集 :1212+（与 `shapez-auto` 的 26 关 rewards 序列一致）
- `mapChunkSize: 16` :883；`map.getLowerLayerContentXY` :22204；`root.systemMgr.systems.belt.findFollowUpEntity` :17266；`StaticMapEntity.localTileToWorld/localDirectionToWorld` :6184/:6252；`Belt.assignedPath` :9143 —— **全部存在，第三方 mod 的用法在 1.5.6 成立**

---

## 6. 对「AI 玩 shapez」项目的最终建议（一段话）

**借鉴 `shapez-auto` 的骨架（确定性求解器 + LLM 提案验证门 + 布局 A*），但补上它没有的四件事**：
(a) **增量建造**（用它没有的 region 级增量 patch，而非全清全建）；
(b) **多层形状的 stacker 链**（它只做了基本 stack，我们串在 `step/await` 快进上做端到端验证）；
(c) **可编程接口**（MCP + 协议化观测/动作，QXIKmIJ 只做了薄版、它根本没做）；
(d) **确定性快进**（`step/await`，两者都没有 —— 这是让"验证成本趋零"的关键，也是本项目的护城河）。
**并把 `TomasSirgedas/Shapez-solver` 的 public-domain 配方表读进来当回归基准**（免费真值）。
**避免**：RL/遗传算法（无一次成功记录）、Gurobi 依赖、全枚举内存表、`eval_code`、monkey-patch 时间。
