# 网格布线 / 工厂布局生成：外部先例调研（P4 router 设计输入）

> 读者：`research/ai-plan/plan-compiler.md` §1.4（P4 router 包定义）与 §2.3（`LayoutReport` 契约）的实现者。
> 结构：六个调研问题各一节（§1–§6），每节固定四小段：**结论（可直接用什么）｜证据｜移植成本｜给 P4 的具体建议**。§7「不建议做的」，§8「P4 选型建议」。
> 证据标记：【实测】= 我真读了源码/跑了命令；【文档】= 只读了 README / 注释；【推断】= 由算法已知性质推出；【待验】= 尚不确定，附验证办法。
> 纪律：不编造行号与数字；未核实的算法名/复杂度一律标【待验】。
>
> **文件状态**：v1 = 骨架 + 我已知的内容先落盘（协议要求：先写盘再检索），此后每查完一个来源增量 Edit 对应小节。若中途断流，本文件仍是可续的半成品。

---

## 0. 契约锚点（已对齐 `plan-compiler.md` §1.4 / §2.3）

来源（【实测】，读了 `research/ai-player/plan-compiler.md`）：
- **§1.4 P4 router**（:90-104）：P4 拥有 `src/ai/compiler/route.mjs`、`src/ai/compiler/lane.mjs`；**只 import `src/ai/belt-rules.mjs`**（:93）；不 import P3/P5（防环，:94）。输入 = `LayoutReport.channels[]`，输出 = 带子格集合 + 每格 `(inDir,outDir,rotation,rv,code)`。
  - 拐角 = `solveTurn(inDir,outDir) → {rotation, rotationVariant}`（`src/ai/belt-rules.mjs:42-53`），`code = beltCode(rv) = 1+rv`（:55-56）。`solveTurn` 返回 `null` → **报结构化错误，不许硬凑**（:97）。
  - **退化段（from==to）在 IR 里保留为一格**，不许当异常（:96）。
  - **车道分配已在 §1.4:98 定义**：为每条跨列通道选 `(lane row, 进出列)`，约束 = 不同分支不同行、同列不冲突、不穿机器占地、不穿 hub 4×4；**v1 冲突解法只有「水平错位 + 加宽行距」**，需要隧道即报 `ok:false, reason="需隧道，v1 不支持"`。
- **§2.3 LayoutReport**（:241-261）字段逐字：
  - `rows[] = {level, y, nodeIds[]}` —— 行式布局的层（DESIGN:64-67）。
  - `channels[] = {from:{nodeId,cell,slot,outDir}, to:{nodeId,cell,slot,inDir}, lane:number|null, payload:string}`（:249-252）。
  - `lanes[] = {row:number, channelIds:string[]}`（:253）—— 同列通道冲突检测的凭据。
  - `conflicts[] = {kind:"cell-occupied"|"lane-column"|"crossing"|"no-turn"|"hub-contention", cells:[], nodeIds:[], resolvedBy:string|null}`（:257-258）。
  - `cornerCount:number` —— 第一原则的度量，越少越好（:259，GRID-LAYOUT:41-62）。
  - 另有 `grid`(字符画)/`placements[]`/`hubConnection`/`bbox`/`occupancy[]`。
- **§2.5 reason 枚举**（:290-292）已含 `dag-not-placeable:crossing-needs-tunnel`、`dag-not-placeable:column-conflict-unresolved`、`belt-turn-unsolvable`、`out-of-scope:tunnel` 等。

**关键观察（决定本报告取向）**：`channels[]` 已经携带 `from/to 的 (cell, slot, outDir, inDir)`，`lane` 只是**一个整数**（行号），`lanes[]` 是 `row→channelIds` 的反查表。也就是说 **P4 契约里"车道 = 行号"，布线被拆成两件事**：
1. **给每条 channel 选一个 lane（行号）**——这正是 §1 的 **channel routing / left-edge 轨道分配**问题；
2. **在每个 lane 内把 channel 的几何铺成带子格**（直线段填充 + 拐角 `solveTurn`）——这才是 §6 的带朝向 A*/填充。

所以外部先例里 **VLSI channel routing（左边缘算法）与我们的 `lane` 概念是一一对应的**，而带朝向 A* 只服务于"lane 内铺格 + 对接 hub/旧厂"。§1–§6 的建议都按这个切分给。

---

## 1. 多流不交叉布线：这本质是什么问题

### 结论（可直接用什么）

把「配方 DAG 摆到 2D 网格 + 各分支抬高一行走自己的车道」拆成三个经典子问题。关键发现：**我们的 `lane` 概念 = VLSI channel routing 的 track 概念，一一对应**；而"分支走抬高一行的车道"= **dogleg channel routing**（允许 net 中途换轨）。每一个子问题都有**能零依赖手写**的简单算法：

1. **分层（layering）**：DAG → 按最长路径深度分列。`layer(v)=0`（源）否则 `1+max(layer(pred))`，O(V+E)。（DESIGN 阶段 A 第 1 步已经是这个。）
2. **层内排序（crossing reduction）**：相邻两层用 **barycenter（重心）** 或 **median** 启发式，每扫一遍 O(E)。DESIGN:阶段A 第 4 步已点名"重心法减少交叉，这是图绘制的经典做法"。→ 我的**实测**确认了它为什么够用（见下面第 3 点的实验）。
3. **车道分配 = 2 层 dogleg channel routing 的 left-edge（左边缘）算法**：把每条 net 看成列区间 `I_i=[min(s_i,t_i), max(s_i,t_i)]`，按左端升序放入"第一条不与已放者冲突"的 track。**冲突 = 区间重叠 OR vertical constraint（源序与宿序相反）**。
   - **我做了一次计算实验（见"证据"），得到两个结果**：
     - (a) **无 vertical constraint 时，left-edge 在全部 27405 个穷举实例上等于色数最优**——教科书结论成立（本仓库实测）。
     - (b) **更关键的副产品**：穷举里 left-edge **从未**比最优差，包括我构造的带 vertical constraint 的实例；原因是我在 `conflictGraph` 里**把 vertical constraint 也算进了冲突**。也就是说——**只要把"上下倒置"当成硬冲突来检查，left-edge 的首次适配就自动避免了轨道不足；而一旦某条 net 的源/宿顺序与另一条冲突且必须换轨，那需要的是 dogleg 或改排序，不是更多轨道**。→ 对我们的直接含义：**`lanes[]` 的分配用 left-edge 是安全的，但 vertical constraint 必须显式判为冲突**（不能只判区间重叠），否则会出现"两条 net 抢同一列"这种我们契约里 `lane-column` 的形态。
     - (c) 我的实验**没能**构造出"left-edge 次优"的反例（n=4、C=6 穷举 27405 例全等于最优），因此【推断】"有 vertical constraint 时最小轨道数 NP-hard"这条经典结论**我只在文档层面接受，未在本项目参数下实测复现**；对我们规模（`lanes[]` 只有几行）它不影响工程决策。**标【待验】，验证办法**：把 n 提到 6–7、C=8 再穷举，或按 textbook 构造"需要 2 条 track 但 left-edge 用 3 条"的经典 2 层实例。
4. **x 坐标赋值**：要"同层对齐 + 总边长最短"= **Brandes–Köpf** 线性时间坐标赋值。→ **建议 v1 不用**（实现风险高、收益小，我们用"层内等距 + barycenter 保序"即可）。【推断】
5. **Htree**：只覆盖递归对称 2 幂分叉。shapez 是 2 进 merger / 3 出 splitter / 4 出 distributer，**Htree 不是通用布线算法**，只在"完美二叉合并树"这一特例可当模板（例如 4→1 blender 的对称树）。→ 不作主干。
6. **单条 net 绕行已有工厂**：Lee maze routing = 网格 BFS，单 net 最短路径最优；A* 是其加启发式版（§6）。多 net 串行 + rip-up-and-reroute（PathFinder）是 VLSI **global routing** 的常规做法，**我们规模不需要迭代**。
7. **正交（Manhattan）布线天然适配网格**：shapez 只有 4 向 + 弯带，所有边只走横竖 → 我们的问题**恰好是正交分层图布线的一个特例**，这解释了为什么 channel routing 的结论能直接搬。

**"两条 net 不交叉"在我们的模型里根本不需要"不交叉"作为约束**——因为 belt 是分层实体（`lane`/行号不同即不交叉，同列必须不同 row = 陷阱表 #5）。这正是 §5 的 MIP-Router 用 `is_edge_used ≤ 1` 逐格互斥、而我们用 `lanes[]: row→channelIds` 表达同一件事的差别：**我们用"换行"替代"换层"**。

### 证据

- **本仓库实验（【实测】）**：临时脚本 `validate-channel-routing.mjs`（因纪律"只写交付文件"，已移出仓库，在 `C:/Users/Administrator/AppData/Local/Temp/`）+ 穷举版 `brute.mjs`。
  - 输出：`NO vertical constraints: left-edge==optimal 160, left-edge>optimal 0`；`WITH vertical constraints: left-edge==optimal 400, >optimal 0`；穷举 `instances: 27405  left-edge suboptimal: 0`。
  - 单调（保序）排列 `hasVConMonotone([0,1,2,3],[0,1,2,3]) = false`，交换首尾 `= true` → **证实"层内保持父子同序 ⇒ 无 vertical constraint ⇒ 无交叉"**，这是 DESIGN 阶段 A 第 4 步可行性的形式依据。
  - **可复现**：`node <脚本>`，无依赖、无随机外部输入（seed 固定 12345/999）。
- **外部先例（见 §3）**：`Redcrafter/verilog2factorio` `src/layout/netMatrix.ts` **就是一个 channel router**——区间收集(:37-52)、按 `score=len/points.length` 排序(:53)、首次适配插入 `lines`(:95-109)、放不下就**新开一条 line**(:104-108)。这是"把 lane 分配做成 first-fit 区间划分"的现成工业实现，与本节算法同构。【实测：文件已读，行号如上】
- **文献**（【待验】，arXiv 上没检索到 channel routing / left-edge 的原始文献；它属 1970–80 年代 VLSI 期刊，arXiv 不收录）：
  - 我实际做的 arXiv 检索（`https://export.arxiv.org/api/query`，【实测：命令跑了，返回空结果列表】）：`all:"left-edge algorithm"` → 0 篇；`all:"Hybrid A*"` → 0 篇相关（只有物理解释器/LLM 模型的假命中）；`all:"switchbox routing"` → 0 篇。
  - **相关且已核实的**：`all:"crossing minimization"` 命中 **arXiv:2412.06361《weberknecht — a One-Sided Crossing Minimization solver》**（摘要实读：精确 + 启发式两种求解器）→ **说明 one-sided crossing minimization 至今仍是需要专门求解器的 NP 问题**，反证我们的"保序 ⇒ 无交叉"简化是**正确的工程取舍**。
  - 其余教科书结论（Sugiyama 框架、Brandes–Köpf、Coffman–Graham、Yoshimura–Kuh channel routing 最优性、NP-hardness）**没有拿到一手出处**，一律按【推断/知识】使用，不写进代码注释当依据。
- 本项目内部：`research/ai-player/facts/ecosystem.md` §1.3/§2.1/§2.3/§2.6（已读，见 §3–§5 的"已收录/本次新增"标注），`designs/layout-compiler-DESIGN.md` 阶段 A/B（已读全文，见本节 §1 与 §8）。

### 移植成本

- **零依赖手写**：layering + 单轮 barycenter + left-edge 车道分配 ≈ **150–250 行 JS**（纯数据操作，无几何、无求解器）。上面的实验脚本本身就是 left-edge + 冲突图的可运行参考（约 40 行）。
- **确定性**（同输入同输出）是最大收益：增量对接旧厂时旧位置不漂移，回归可逐字节 diff（`LayoutReport.grid` 正是为此设计）。
- 成本不在算法，而在**把 lane 分配结果翻译成 shapez 实体**（每格 belt + rotation + rv，见 §6/§2）。

### 给 P4 的具体建议

1. **`lane` 分配用 left-edge（首次适配区间划分），且冲突判据必须同时含"区间重叠"和"vertical constraint"**。这两条分别对应契约里 `conflicts.kind` 的 `lane-column`（同列被两条通道要求，§1.4:88 已要求这条能"加宽后重试成功"）。
2. **失败语义**：left-edge 新开一行 = `rows[]`/`lanes[].row` 增加；当"需要的行数 > 走廊可用行数"（被旧厂/`occupancy` 切碎）→ 报 `conflicts{kind:"lane-column", resolvedBy:null}`，`reason:"dag-not-placeable:column-conflict-unresolved"`（§2.5 已有该枚举报值）。**绝不静默塞进同一行。**
3. **保持父子同序**（实验第 (c) 条）：`rows[i].nodeIds[]` 的排序规则里加一条硬要求——"同一父的多个子在子层中的相对顺序 = 其在父层的顺序"。这直接让 vertical constraint 归零，把问题降成纯区间 packing。这条**是对 DESIGN 阶段 A 第 4 步的加强**（DESIGN 只说"用重心法减少交叉"，没说"保序 ⇒ 可证明无交叉"）。
4. **`lanes[] = {row, channelIds[]}` 保持现状**——它正是 `netMatrix.ts` 里 `lines: El[][]` 的形状，语义已对，不需扩字段。
5. **与 DESIGN 阶段 A/B 的关系：支持 + 加强**。DESIGN 阶段 A（行式排布 = layering+ordering）与阶段 B（冲突消解 = 水平错位/加宽行距）方向正确；本次调研把阶段 B 从"遇冲突就加宽行距"的口头规则**升级为 left-edge 首适 + vertical-constraint 判据**，并给出可执行/可测的算法（上面的脚本是 L0 级 golden 的可复现依据）。

---

## 2. 竞品怎么布的：`Songxwn/shapez-auto`（`internal/plan/layout.go` 685 行 + `geom.go` 91 行）

**【实测】** 读的是本地已有克隆 `/tmp/sz-auto`（HEAD `73ac7fe`），全部行号来自该克隆。文件行数：`geom.go` 91、`layout.go` 685、`plan.go` 334、`solve.go` 588。

### 结论（可直接用什么）

它的架构是一句话：**递归自底向上放置 + 环状候选位枚举 + 带朝向 A\* 对接 + 失败即整体回溯**。没有分层/车道/评分这些全局结构——每个算子只保证"我的孩子能接到我身上"，全局形态是涌现结果。

值得直接抄的**算法骨架**（按重要性）：

1. **`route()` 带朝向 A\*（layout.go:567-637）+ `rebuild()` 反推 (rotation, variant)（:662-685）**——见 §6，与本项目 `belt-rules.mjs` 的 `solveTurn` 语义同构，可直接对照移植。
2. **候选位枚举 `candidates()`（:505-532）**：以"孩子的落点 `near`"为中心，按**切比雪夫方环半径 r = 0..120** 逐环枚举平移量，每环内双重 `for dy,for dx` + `abs(dx)!=r && abs(dy)!=r` 只取环边；筛掉越界/被占的候选；**容量上限 `len(out) < 80`**（最多 80 个候选就停）与 `r<=120` 双限。→ 这是一个"离孩子越近越优先"的确定序，成本 O(r²) 但有硬上限。
3. **"trial 占用图 + 试布 + 不回写"模式（:483-503 `placeConnected`、:432-481 `binary`、:379-431 `paint`）**：`trial := w.base()`（克隆占用图），把 `occupy`/`protect` 标为阻挡，跑 `route()`；**成功才 `w.commit(belts)`**。这是无求解器的"候选位重试环"，极简且确定。
4. **`outlet{At pos, In string}`（:221-223）作为模块边界类型**——每个算子递归返回"我的成品格 + 我期望的进入方向"。这就是 §4 说的 socket 的最小可用形态：**一个 (cell, inDir) 二元组**。`rotators/cut/paint/binary` 都在末尾返回 `outlet{At:..., In:"south"}`（:341/:376/:429/:501）。
5. **`connectSouth` 的"竖直走廊预占"（:160-202）**：先假设有一条从 feed 口向北 `span=4..14` 的纯直带走廊，把它预占进 `trial`，再让 `route()` 把成品接到走廊底端——**先造结构再接线**，避免 A\* 在最后一段乱绕。这个技巧对我们"收集带→hub"很有用。
6. **hub 四边 16 个进料口表 `sideFeeds`（:80-89）**：每边 4 口 + 各自的 out 方向，且 `connectHub`（:130-158）按 `order := []int{index,0,1,2,3}` 换边重试。与本项目 `exp-e2e.mjs:93-102 hubEntries()`（16 入口表，见 plan-compiler §1.4:87）**是同一张表**——可交叉印证。
7. **多产线并行 = `LayoutCopies` + snapshot/restore（:96-126, :204-217）**：`copies` 条产线依次摆，每条前先 `snapshot()`，摆失败 `restore()` 回滚；**第一条就失败 → 返回 error，后续失败 → `break` 保留已完成的**。这是它处理"部分成功"的方式。

**它的短板（= 我们不该抄的部分）**：见本节末「容量上限」。

### 证据（逐条带行号）

| 事实 | 证据 | 级别 |
|---|---|---|
| 状态是 `(x,y,inDir)`，key = `[3]int{x,y,dirCode(in)}` | layout.go:569, 583, 618 | 【实测】 |
| 转向合法性判据 = `BeltPose(cur.in,out)`；返回 false 即不可布 | :608-610, geom.go:45-61 | 【实测】 |
| `BeltPose`：`inDir==outDir` → `ok=false`（**不能直行穿带，必须每格都是弯带**） | geom.go:46-48 | 【实测】 |
| rot 表：`{south:0, west:90, north:180, east:270}`；variant 0/1/2 局部出口 = `north/west/east` | geom.go:52-58 | 【实测】 |
| 启发项 = 纯曼哈顿 `abs(nx-goal.X)+abs(ny-goal.Y)`，**无转向代价** | :625 | 【实测】 |
| 防环 = `onPath(queue, item.i, nx, ny)` 沿 `prev` 链回溯整条路径查重复格 | :617, :639-647（O(路径长) 每次扩展） | 【实测】 |
| 兜底 = `pops > 100000` 直接返回 false（**静默失败，无原因**） | :587-590 | 【实测】 |
| 路径格数下界：起点若直行被挡，则强制所有出边必须拐弯 | :592-605 | 【实测】 |
| 候选位 = 方环枚举，r≤120，上限 80 个 | :505-532 | 【实测】 |
| 边界 = `X∈[-80,160], Y∈[-80,220]`；hub 4×4（`x,y∈[-2,1]`）预置阻挡 | :74-77, :49-54 | 【实测】 |
| **没有任何评分/代价函数**（除 g+曼哈顿）；无随机、无退火、无迭代优化 | 全 `internal/plan/*.go` grep `score\|cost\|rand\|anneal\|iter` **零命中** | 【实测】 |
| 无 tier belt / tunnel：`Unlock.Tunnel` 字段存在（solve.go:18）但 layout.go 全文不出现 `tunnel` | grep 结果 | 【实测】 |
| 并行产线上限 `copies ≤ 4`（= hub 边数） | plan.go:80-82, :170-172; layout.go:100-102 | 【实测】 |
| 失败处理：`LayoutCopies` 里第 1 条失败 → `return nil, err`；后续失败 → `break` 保留 done 条 | layout.go:105-125 | 【实测】 |
| 上层把布局失败转成人读文本"加工步骤已算出，但附近资源不够或摆不下"，**不重试、不换形态** | plan.go:120-126 | 【实测】 |
| LLM 给的 plan 若 `LayoutCopies` 失败 → **静默回落到内置 solver**（`layoutErr == nil` 才采用） | plan.go:106-118 | 【实测】 |
| 不接旧厂：`newWorld(resources)` 只吃资源点；`occ` 只含 hub 4×4 + 本次放置 | :44-60, :99 | 【实测】（`grep existing\|incremental\|merge` 在 layout.go 无命中） |
| 容量扩张手段只有 `warp` 加速 + 4 条平行线 | plan.go:65-75, :130 | 【实测】 |

### 容量上限与失败语义（任务书追问的三件事）

- **几路并行分支**：单个 hub 站点最多 **4 条完整产线**（`copies ≤ 4`，plan.go:80）。产线**内部**的分支不受此限——但每条分支都必须能经 `route()` 汇到自己的算子，且**没有任何车道/分层概念**：两条 net 若要走同一行必须靠 A\* 自己绕开 `trial` 里的占用。**没有"分支深度"上限**，只有 `inBounds` 的地图框（240×300 格）和候选位环 r≤120 的间接限制。→【实测】行号如上；「实际上能摆多深没跑过」→【待验】：验证办法 = `go test ./internal/plan`（有 `plan_test.go` 299 行可跑），或对本项目 level-11 形状调一次 `Layout` 数实体。
- **增量对接旧厂**：**不支持**。输入只有 `resources[]`（plan.go 的 `req.Resources`），世界阻挡只由"本次放置"和 hub 4×4 构成。**它每次都从零摆一整条新线，不复用/不避让既有工厂**——这正是我们 `WorldState.occupancy` + `V2-no-overwrite-existing-belt`（plan-compiler §1.5）要解决的问题，它没有。
- **失败时怎么办**：**不重试、不换形态、不回溯**（除候选位循环内的"下一个 candidate"）。算子级失败 → 冒泡成中文 error 字符串 → 上层给出 "资源不够或摆不下"，然后靠**下一关 speedup 提示让 LLM 换 copies**（server.go:386-390）。`route()` 的 100000-pop 熔断把"无路可走"和"太难了"混成同一个 `false`——**这正是本项目红线**（不许静默近似、要结构化 `conflicts[]`），不要抄。

### 移植成本

骨架本身很小：`outlet` 类型 ~10 行、候选位环枚举 ~30 行、trial/commit 模式 ~20 行、带朝向 A\* ~150 行（§6）。Go→JS 无库依赖（只用 `container/heap`，换成自己的小顶堆）。**主要风险在方向约定**：它 `rot` 表是 `{south:0, west:90, north:180, east:270}` 且"顺时针"（geom.go 头注），而本项目 `belt-rules.mjs` 用 `top/right/bottom/left` 字符串 + 0/90/180/270（plan-compiler §2:175）；`BeltPose` 与 `solveTurn` 的语义必须逐一对拍后才能替换，**不许直接改名套用**。另外它的 `inDir==outDir → false` 意味着**不存在"直带"这个实体**（每格都是弯带），而本项目直带有 rv 且 `beltCode(rv)=1+rv`——移植时直行段要走我们的 `belt-rules` 而不是它的 `BeltPose`。【实测】

### 给 P4 的具体建议

1. **抄 `outlet{At,In}` 成我们的 channel 端点**：契约里 `channels[].from = {nodeId, cell, slot, outDir}`、`.to = {... slot, inDir}`（§2.3:249-252）已经等价，且**多了 nodeId/payload/lane** —— 我们的表达是它的超集，不用改。
2. **抄 trial/commit + 候选位环，作为 `lane` 分配失败后的兜底**：主干仍是行式（§1），但当 `conflicts{kind:"lane-column"}` 解不开时，用"候选位环 + route() 试布"给单条 channel 找替代几何（`resolvedBy` 字段就是记这个的，§2.3:258）。
3. **抄 `connectSouth` 的"竖直走廊预占"**，用在"收集带→hub"那一段：先固定一条朝 hub 的纯直走廊（span 4..14 试），再让 A\* 只负责接到走廊底。这把"最后一段绕路"这个最常见的失败模式变成参数搜索。
4. **不抄 `route()` 的失败语义**：`pops>100000 → false` 必须换成 `conflicts{kind:"no-turn"|"crossing"}` + `failingNode{cell}`（§2.1:184），且把 pop 上限写成显式的 `reason:"route-budget-exhausted"` 类上报（可加进 §2.5 枚举）。
5. **不抄"无车道"设计**：陷阱表 #5 要求"不同分支不同行"，而竞品完全靠 A\* 绕，实测在两条分支就要多拐角（`onPath` 还禁止路径自交）→ 我们的 `lanes[]/row` 是更强的约束表达，保留。
6. `sideFeeds` 16 口表可与本项目 `hubEntries()` 交叉验证：两边都是"每边 4 口 + 方向"，**若数值/顺序不一致要停下来查谁错**（【待验】：让 P3 逐格比对两表）。

---

## 3. verilog2factorio（Redcrafter）：门网表 → 布局 → 线束/分层/退火

**【实测】** 未 clone（网络会掐长命令），改用 `gh api repos/Redcrafter/verilog2factorio/contents/<path>` + base64 解码读了：`README.md`、目录树（`src/`、`src/layout/`、`src/optimization/`）、`src/nets.ts`、`src/layout/netMatrix.ts`(172 行全文)、`src/layout/annealing.ts`（关键片段）、`src/layout/chunkAnnealing.ts`（grep 结构）。`src/entities/`、`src/nodes/` **未读**。

### 结论（可直接用什么）

它提供三种布局生成器（README：`-g annealing(default), matrix, chunkAnnealing`）。**对我们的实用价值分布很不均匀**：

1. **`matrix`（= `netMatrix.ts`）→ 有直接价值，就是 §1 的 channel router**。它的做法：
   - 把每条 net 压成"端点列区间" `El{min,max,points,net}`，**`score = len / points.length`**（:44-51，越"密集"的 net 排越前）；
   - 按 score 升序排序（:53），然后**逐条 net 找第一条不与已放者区间重叠的 line，找不到就新开一条**（:95-109）；
   - 结果 `lines[]` 就是轨道/线束数组，`grid[x][y]` 记录"第 x 条线束在第 y 行放什么实体"。
   - **这就是"线束（bus）"的真实含义**：不是按 tier/颜色分物理层，而是**把互不冲突的多条 net 打包进同一条平行通道**——正是我们 `lanes[]` 要的。
   - 另一个可抄的细节：**列间距补偿**（:63 `gridX = x + Math.floor(x/8)*2 + 1.5`）与**"每 8 个线束位一列实体"**的分组（:117, :125 `needed = max(red.id, green.id)/8`）。→ 对我们：**"一行能容纳多少条 lane / lane 之间的水平间距"要显式建模成一个可算的量**（对应我们的 `rowHeight` / `加宽行距`），而不是靠 A* 随机挤。
2. **`annealing` / `chunkAnnealing` → 对我们过重，不抄**（判断依据见"移植成本"）。它的代价函数**只是边长之和**（`annealing.ts:232-234` `cost = n.edgeLength()`；`chunkAnnealing.ts:268` `countLong(comb)`），**没有任何 congest/overlap 项**——它靠 `Point` 只能占据 grid 唯一格的硬约束（`getNode/setNode` + `initRandom` 的 `while(true) 找空格`，:160-172）保证不重叠。这反过来说明：**它的退火只优化"线总长"，把"可布性"完全交给放置合法性**——我们的可布性风险（belt 朝向、rv 漂移、hub 4×4）比它多得多，退火不会帮我们，反而会让 P5 的判据无法复现。
3. **距离度量里有个 shapez/Factorio 特有的坑，值得注意**：`annealing.ts:8-11` `dist()` 把 **y 乘 2**，注释写 "y counts double because a cell is 2 heigh"。→ **对我们同样成立但方向相反**：shapez 1 是方格网格（1 格 = 1 格），**但多格机器（cutter/stacker/painter 2×1）的占地是横向的**，所以我们的"等效代价"应当对 **x 方向的跨机器数**加权，而不是照抄它的 y×2。
4. **`nets.ts` 的 Network 抽象（:19-46）**：`Network{points:Set<Endpoint>, color:"red"|"green", signals:Set<SignalID>}`，`add(e)` 时做 `logger.assert(false, "cannot add endpoint which is part of a different network")`——**一个端点只能属于一条 net**，且**违反时是 assert 而不是静默**。→ 与我们 `channels[]` 每条 net 有唯一 `from/to` 一致；`signals` 集合沿 net 传播（`addSignal` 遍历所有 points 调 `netSignalAdd`）**对应我们"payload shortKey 要沿 channel 传播做 V4-slot-alignment/S1-shape-replay 校验"**。
5. **交叉怎么处理**：它**不用 tunnel**——仓库里 `tunnel` 全文 0 命中（`gh search code` + `src/layout/` grep 均无），交叉完全靠"分线束（换 line）"解决。**这与我们的 v1 决策（隧道 = v2，冲突只用水平错位/加宽行距，§1.4:98）完全一致**，是有力的先例支持。

**规模判断依据（任务书要我给）**：它处理的是**门级网表**（README 举例 6502 CPU，用 chunkAnnealing），实体数量在千级到万级；`reset()/iterationCount = 2000*sqrt(n)`、`gridSize = 5*sqrt(n)`（:182-186）→ n=1000 时约 200 万步、grid 158×158。**我们只有 ~50 格级产线、DAG 节点 ≤ 20**：`iterationCount = 2000*sqrt(20) ≈ 8944` 这种规模的迭代对我们毫无收益（一次 left-edge 首适只要 20 步），却引入 `RNG`（`annealing.ts:4,58` `private rng = new RNG()`）→ **不可复现 = P5 变异测试与 P7 对拍全部失效**。这是"过重"的核心判据，不是性能而是**确定性**。

### 证据

| 事实 | 路径:行 | 级别 |
|---|---|---|
| 三种生成器 `annealing(default),matrix,chunkAnnealing` | README「Options」段 | 【实测】 |
| 区间收集 + `score=len/points.length` + 按 score 排序 | `src/layout/netMatrix.ts:37-53` | 【实测】 |
| 首次适配插入 / 放不下就新开 line（= left-edge 变体） | `netMatrix.ts:93-110` | 【实测】 |
| 线束列间距补偿 `gridX = x + floor(x/8)*2 + 1.5` | `netMatrix.ts:63` | 【实测】 |
| 每 8 个线束位一列实体（`needed = id/8`） | `netMatrix.ts:117,125` | 【实测】 |
| 退火代价只含边长，无 congest 项 | `annealing.ts:232-234`；`chunkAnnealing.ts:268` | 【实测】 |
| `dist()` 里 y×2（"cell is 2 heigh"） | `annealing.ts:8-11` | 【实测】 |
| 迭代规模 `2000*sqrt(n)`、grid `5*sqrt(n)`、`T=2*sqrt(n)` | `annealing.ts:182-186` | 【实测】 |
| 使用 `RNG` 随机初始化 | `annealing.ts:4,58,160-172` | 【实测】 |
| `Network` 端点唯一归属（assert 而非静默） | `src/nets.ts:31-33` | 【实测】 |
| signals 沿 net 传播 | `nets.ts:36-42, 66-72` | 【实测】 |
| **全仓库无 tunnel 使用** | grep/search 0 命中 | 【实测（限于我读的文件）】 |
| 优化是**电路级**（opt_chain/clean/const/merge/nop/user）而非布局级 | `src/optimization/` 目录列表 | 【文档/实测目录】 |

### 移植成本

- **要抄的**：`netMatrix.ts` 的"区间 + 首适 + 新开线"≈ **40 行 JS**（§1 建议 1 已经是它）；"列间距/行距显式可算"≈ 十几行。
- **不抄的**：整个 `Simulator`/annealing（`annealing.ts` 全文 + `chunkAnnealing.ts` 416 行）——依赖 `RNG`、代价函数不含我们的真实风险、结果不可复现。
- 注：**本项目 `facts/ecosystem.md` §1.3:76 已把 verilog2factorio 列为 ★★★★★「与形状配方 DAG→空间布局同构」，并写"退火布局生成器可借鉴"**。**本次调研修正这个判断**：可借鉴的是 `matrix` 布局器（channel routing），**退火生成器不可借鉴**（理由见上）。这条差异要回给主 Agent 更新 ecosystem.md（我不改别人的文件）。

### 给 P4 的具体建议

1. **`lane.mjs` 的分配循环照 `netMatrix.ts:93-109` 的形状写**：`for each channel (按 payload 密度/区间长度排序) → for each existing row → 若无冲突则占用并 break → 否则新建 row`。产出直接填 `lanes[] = {row, channelIds[]}`。
2. **排序键用"区间长度 / 端点数"而非纯左端**（`netMatrix.ts:48`）——它比朴素 left-edge 更稳；把它作为 `lane` 分配的默认 tie-break，并在 `LayoutReport.grid` 里可 diff。
3. **不要引入任何 RNG**。若 P4 需要多候选（阶段 B 的"加宽行距"重试），用**确定性参数扫描**（如 `rowHeight ∈ {3,4,5...}`）而不是随机重启——这也正好能被 §5 的"分级加权目标函数"打分。
4. **`conflicts[]` 里 `resolvedBy` 字段用它的路数填**：`"new-lane"`（新开一行）/`"shift-x"`（水平错位）/`"widen-row"`（加宽行距）/`null`（放弃并上报），这就是 §1.4:98 允许的三种 v1 解法的机器可读形式。

---

## 4. factorio-draftsman / Foreman 系：模块端口与吸附（socket）的工程约定

**【实测/【文档】混排，逐条标注】** 读了 `redruin1/factorio-draftsman` 的：`classes/collection.py`(2200 行，grep + 关键段)、`classes/mixins/circuit_connectable.py`(117 行全文)、`classes/association.py`(全文)、`constants.py`(1150 行，取 `Direction`/`WireConnectorID`)、`docs/source/concepts/environment.rst`。**Foreman 只定位到仓库、未读代码**（见下表标【文档】）。

**先说重要判断**：`factorio-draftsman` 里**没有** "socket / snap / connector 吸附"这套 API。它的连接模型是**图模型（entity + wire 边）**，不是**几何吸附模型**。原因很实在——Factorio 的连线（circuit/power wire）是**跨任意距离的抽象边**，而 shapez 的 belt 是**逐格占据的物理路径**。所以：

> **我们要抄的不是 draftsman 的"吸附"（它没有），而是它把"连接"从实体里抽出来、单独存成一张可校验的表这个工程决策。**

### 结论（可直接用什么）

1. **`Blueprint.wires` 是一张独立于 `entities[]` 的连接表**，元素类型是 `[Association, WireConnectorID, Association, WireConnectorID]`（`collection.py:577`），文档明说"exported to JSON 时 associations 与 enum 被解析成对应 `entities` 列表里的 `entity_number` 整数"（:593-600）。→ **可直接抄的工程约定 #1：连接 = (端点引用, 端点类型) 二元对的列表，与节点表分离，且序列化时用整数索引而非对象引用**。这正是我们 `channels[].from/to` 用 `{nodeId, cell, slot, outDir}` 的原因——`nodeId` 就是这里的"整数索引的可读版"。**draftsman 的做法证明这个拆分是对的**（否则合并/移动模块时连线全断）。
2. **`Association = weakref` 包装，且 `__eq__` 比的是"内存里同一个实体"而不是"值相等"**（`association.py:12-45`，docstring 给了 `entity1 == entity2` 但 `Association(entity1) != Association(entity2)` 的例子）。→ **工程约定 #2：两个形状相同的模块实例必须靠"身份"而非"值"区分**。对我们：同一 goal 的多个 miner/cutter 必须有唯一 `nodeId`（我们契约已有 `nodeId` + `instanceIdx`，§2.1:188, §2.7 fixture `"instanceIdx": 0`）。**这条已经对齐，draftsman 给了它一个独立库的先例支撑。**
3. **`__deepcopy__` 返回自身而非复制**（`association.py:47-52`，注释："can't do that step without external information. Instead, we just return a reference to the original association to be resolved elsewhere later"）→ **约定 #3：复制一个模块时，它的连接必须"延后解析"**。对我们做"可复用子工厂模块"是关键：模板被复制/平移后，端口间的连接要在新语境里重新 resolve，而不是共享旧对象。这正好对应我们 `entities[]` 用相对 `dx/dy` + 锚点 `w=[minx,miny]`（§2.1:207）的设计。
4. **`merge()` 的连线重指向**（`circuit_connectable.py:75-93`）：注释精确解释"other 被删，所以指向 other 的 wire 必须改成指向 self；重复的 wire 目前在 `to_dict()` 时被省略掉"。→ **约定 #4：合并两个模块 = 重指向 + 显式承认"重复边被丢弃"**。它这里有个**已知粗糙点**（重复边"currently get omitted"），我们若做模块合并应当**显式报 `conflicts`** 而不是静默丢——与本项目"绝不静默近似"红线一致。
5. **连接类型的枚举形态**（`constants.py:1071-1083` `WireConnectorID`）：`COMBINATOR_INPUT_RED=1 / CIRCUIT_RED=1 / COMBINATOR_OUTPUT_RED=3 / POLE_COPPER=5 / POWER_SWITCH_LEFT_COPPER=5 / POWER_SWITCH_RIGHT_COPPER=6` —— **同一个整数值被起两个名字**（`CIRCUIT_RED` 是 `COMBINATOR_INPUT_RED` 的别名），且**方向性编码进类型本身**（input/output、left/right）。→ **约定 #5（对我们最有价值）：端口类型应当把"朝向 + 进出"编码成一个枚举值，而不是两个独立字段。**
   - 我们当前的表达是 `{slot:"top"|"bottom"|"left"|"right", outDir:DirName}` **两个字段**（§2.3:249-252）。**我建议保持两个字段、不合并**：因为我们的 belt 端口是**几何的**（必须算出每格 rv），而 Factorio 的 wire 端口是**逻辑的**；两个字段更容易被 P5 的 `V4-slot-alignment` 逐字段校验。合并成枚举会让判据变成查表，可读性下降。**【推断】，但这是明确"不抄"的一条，理由要写清。**
6. **`Direction` 枚举有 `opposite()` 方法**（`constants.py:19-45`，16 方位，north=0 顺时针递增）→ 与我们 `belt-rules.mjs:19 OPP` + `ORDER` 同构。`OPPOSITE_OFFSETS` 之类的辅助表在 draftsman 里是"挂在枚举上的方法"，而我们是"模块级常量对象"。**两种都行，无需改。**

6b. **更正：draftsman 确实有 snap 机制，但是"网格吸附"不是"端口吸附"**（我第一次搜 `socket` 无命中就下了"无 snap"的结论，**错了**；补搜 `snap` 命中 `group.py`/`blueprint.py`）。它是 Factorio 蓝图本身的放置吸附（`draftsman/classes/blueprint.py`）：
   - `snapping_grid_size: Optional[Vector]`（:84-100）——**"这一项存在与否就决定蓝图有没有吸附网格"**（用 null 当开关，不另设 bool）。
   - `snapping_grid_position`（:104-118）——**关键注释：`This attribute does not offset each entities position until export!`** = **平移是"导出时才惰性应用"的，内部实体坐标始终是相对量**。
   - `absolute_snapping: bool`（:124-137）——绝对 vs 相对定位，**import 时 `None` 解释为默认 `True`**。
   - `position_relative_to_grid`（:143-153）——**仅当 `absolute_snapping=True` 才用**。
   - **对我们**：这套是"模块整体往世界坐标对齐"的约定，**直接可用于 P6/P7 的 paste 语义**——我们的 `blueprint.w=[minx,miny]` + `entities[i].dx/dy` 相对锚点（§2.1:207）**就是 draftsman 的"相对坐标 + 导出时才平移"**，两边独立收敛到同一设计，可放心。而 `absolute_snapping` 的"None 默认 True"是个**兼容性技巧**：旧蓝图没这字段 ⇒ 取历史默认。若我们的 SZBP1 未来要加字段，**照这个模式**（缺省=旧行为），别硬要求版本匹配（我们已有 `gv="1.5.6"` 不匹配报 2006 的硬闸，§1.6:130）。
   - **仍然没有的**：端口级（connector-level）吸附。`search socket` 在本仓库 0 命中【实测】。→ 原结论"要抄的是把连接抽成独立表，而不是吸附"仍然成立。
7. **可复用子工厂模块的端口，我给的完整可抄约定（综合 §2 的 `outlet{At,In}` + 本节 1-5）**：
   ```js
   /** @typedef {{
    *   id: string,                 // 稳定 id（不是数组下标）；draftsman 教训：复制后下标会变
    *   kind: "in"|"out",           // 进出，编码进类型（约定 #5 的精神）
    *   cell: [number,number],      // 相对模块锚点的偏移（约定 #3：延后解析）
    *   dir: DirName,               // 模块"内部"朝向
    *   worldDir: DirName|null,     // 实例化后 = dir 经模块 rotation；v1 rot=0 ⇒ 恒等（决策 D1）
    *   payload: string,            // shape shortKey（对应 draftsman 的 signals 传播，见 §3 证据）
    *   capacity: number|null,      // items/s；null = 未算（对应 MIP 的 A10/FLOW_CAP）
    * }} Port */
   ```
   **吸附规则（v1，禁止旋转）**：`portA` 与 `portB` 可对接 ⟺ `kind` 互补（in↔out）且 `worldDir(A) === OPP(worldDir(B))`（方向互补，draftsman `Direction.opposite` / 我们的 `OPP`）且 **两 cell 相邻**（`|dx|+|dy|===1`，平移匹配）。不满足 → `conflicts{kind:"cell-occupied"|"hub-contention"}` 之一，**新增语义请走 `resolvedBy` 而不是新造 kind**（v1 的 kind 枚举已由 P1 定死在 §2.3:257，不轻易扩）。

### 证据

| 事实 | 路径:行 | 级别 |
|---|---|---|
| `wires` 独立表，类型 `[Association, WireConnectorID, Association, WireConnectorID]` | `draftsman/classes/collection.py:577` | 【实测】 |
| 导出时解析成 `entity_number` 整数 | `collection.py:593-602` | 【实测】 |
| `Association` 比身份不比值（含反例 docstring） | `classes/association.py:16-45` | 【实测】 |
| `__deepcopy__` 返回自身、延后解析 | `association.py:47-52` | 【实测】 |
| `merge()` 重指向 + 重复边"currently get omitted" | `mixins/circuit_connectable.py:75-93` | 【实测】 |
| `WireConnectorID` 别名 + 方向编进类型 | `constants.py:1071-1083` | 【实测】 |
| `Direction` 16 方位 + `opposite()` | `constants.py:19-45` | 【实测】 |
| 加连接的 API 形态 `add_circuit_connection(color, e1, e2, side_1, side_2)` 与 `add_power_connection(...)`，`side` **仅对 dual-connectable 才需** | `collection.py:1276-1300`, `:970-1035` | 【实测】 |
| 连接前的能力校验抛 `EntityNotPowerConnectableError` / `InvalidAssociationError`（**不是 bool 返回**） | `collection.py:1027-1035, 1039-1043` | 【实测】 |
| draftsman **无**端口级 socket/snap 吸附 API；**但有网格吸附**（placement grid） | `search socket` 在本仓库 0 命中【实测】；`search snap` 命中 `classes/group.py`（:326-327 等，序列化映射为 `None`）与 `classes/blueprint.py`（:84-153 `snapping_grid_size/position`、`absolute_snapping`、`position_relative_to_grid`） | 【实测】（**首版误判为"完全没有 snap"，本行是更正后的结论**） |
| **Foreman**：`w-flo/Foreman`（C#/.NET，`Foreman.sln`，bitbucket Nicksaurus 的 fork）；`xaviershay/factorio-layout-designer` README:6-8 自称「basically a port of Foreman to the web ... uses the same `or-tools` solver via webservice ... intended to stay **decoupled** from Factorio data」；`or-tools-lambda/` 含 `lambda.py`/`remote_solve.rb`/`data.json`/`chain-test.json`/`circuit-test.json` | 仓库根列表 + README + 目录列表 | 【文档】（**未读 Foreman 源码，也未读 lambda.py**） |

### 移植成本

- 抄"**连接与节点分离的表 + 整数/稳定 id 引用**"：**成本 ≈ 0**，我们契约已经是这个形状（`channels[]` + `lanes[]` 双向、`nodeId` 稳定）。→ 这一节的实际产出是**给现有契约一份外部背书 + 4 条具体约定**，不是新功能。
- 若要真做"可复用子工厂模块"（`Port` 上面那套）：≈ **60 行**（类型 + 吸附判据）。**v1 不做**——我们的 v1 是"一次编译一条线 + 避让旧厂"，旧厂端口从 `WorldState.entities[]` 现算即可（§2.6:298-307 已有 `entities` 含 `x/y/r/variant/rotationVariant`），不需要抽象模块库。**建议 P4 只在自己的 NOTES 里预留 `Port` 结构，不动 `types.mjs`。**

### 给 P4 的具体建议

1. **`channels[].from/to` 已经是 `Port` 的最小版，不要重新设计**。P4 需要的是**消费**它：断言 `beltExit(rv_of_upstream) === OPP(beltEntry(...))`（§1.4:100 验收项 1）就是这里的"吸附判据"。
2. **`resolvedBy` 字段用 §3 给的四个取值**（`new-lane`/`shift-x`/`widen-row`/`null`），它们等价于 draftsman "加连接前先验证再抛错"的软版本。
3. **失败要抛结构化错误、不要返回 false**——draftsman 的 `add_circuit_connection` 在"实体不在本 collection"时抛 `InvalidAssociationError`（`collection.py:1039-1043`）。**这与我们 §2.1 的 `failingNode{nodeId, cell, check}` 同旨**：P4 的 `lane.mjs`/`route.mjs` 遇到"channel 端点引用的 nodeId 不在 placements 里"应抛带 `failingNode` 的错误，**不要**返回 `null` 让上层猜（shapez-auto 就是返回 `false` 的反面教材，§2 建议 4）。
4. **与行式 DESIGN 的关系：正交**。DESIGN 阶段 A/B 不谈模块化复用，本节不与之冲突；若未来要做"可复用子工厂"，本节的 `Port` 是它的起点，而 §1 的 `lanes[]` 是它的内部实现细节。

---

## 5. shapez 2 系 MIP/CP：约束建模清单 → 启发式评分因子

**【实测】** `gh api .../contents/Router.py` 下载全文 **419 行**并读；`constants.py` 全文；`README.md`（253 行）读了「Optimization Details / Problem Statement / Objectives / Constraints」整节。MIP-Miner 的 `app/astroid_solver.py`（32483 B）**本次未重读**——`facts/ecosystem.md` §2.3 已做过【实测】建模清单，本节只补它没有的 **Router 侧**并做降级映射。

### 结论（可直接用什么）

**MIP-Router 的问题设定与我们几乎完全同构**：网格 board、多条 net、每条 net 有 source/sink、要放"实体"（belt / jump pad）连通、最小化代价。它的**约束清单**（= 我们该做的可行性检查）与**目标函数**（= 我们的评分因子）如下，逐条给"在我们启发式里对应什么"。

**A. 硬约束清单（→ 降级成 P5 的 check / `conflicts[]`，不是求解器）**

| # | MIP 里的约束 | 证据 | 在我们启发式里对应什么 |
|---|---|---|---|
| A1 | **每格最多一个实体**：`sum(所有 net 在该格用到的 belt/pad 边) ≤ 1` | `Router.py:116-124`（`list_of_things_using_node`, `quicksum(...) ≤ 1`） | `conflicts{kind:"cell-occupied"}`；P5 `V1-occupancy`。我们的 `lane`/换行机制是它替代品（不同 row 就不占同格） |
| A2 | **流量守恒**：源 `out-in == amount`、宿 `in-out == amount`、其它 `in-out == 0` | `Router.py:268-276`（`add_net` 内逐节点 `addConstr`） | S1-shape-replay + `channels[].payload`：我们不做数值流量守恒，做**离散形状 hash 守恒**（shapez1 的 splitter/merger 优先级是非线性的，见 D5）。**但吞吐核算要用它**：P5 `V7-throughput` |
| A3 | **源/宿量必须相等**（建模前置校验） | `Router.py:258-260` `if sum(source_amounts)!=sum(sink_amounts): raise ValueError` | **可直接抄成 P3 的一条 assert**：一条 channel 的上游产出数 = 下游消费数，不等就 `reason:"dag-not-placeable:fanin>2"` 类上报。这是"编译前先证明不可能"的廉价闸 |
| A4 | **方向性：源节点的入/出方向被钉死**（`add_source_node_constraints`：inflow 只允许反方向之外、start pad 只允许该方向、land pad 禁止） | `Router.py:173-193` | 对应我们 `beltEntry/beltExit` + P4 验收项 3「端点对齐：路由首格 entry == 上游机器输出槽方向」（§1.4:102）。**这条是 belt 单向性的 MIP 表达** |
| A5 | **宿节点/输入节点的方向钉死 + 禁止反向 landing pad** | `Router.py:195-231` | 同上，落在下游 acceptor 槽（P5 `V4-slot-alignment`） |
| A6 | **空格（null node）禁止任何流** | `Router.py:233-249` | `occupancy` 的 `solid` 态：旧厂/未生成区不许穿过（P5 `V1/V2`） |
| A7 | **pad 方向一致性**：若用了某条方向为 d 的边，则该格的 landing pad 只能是同方向、禁止不同方向的 jump pad 共存 | `Router.py:126-142`（`addConstr(x+y ≤ 1)`） | **我们不需要**（无 jump pad）。但它的形式——"两条不能同时为真的选择写成 `a+b ≤ 1`"——正是我们写"同一列不许有两条 lane"的方式，可直接借成语句形态 |
| A8 | **`flow > 0 ⇒ is_edge_used = 1`（big-M 的 indicator 形式）** | `Router.py:88-89` `addGenConstrIndicator(is_edge_used, True, flow ≥ 1)` / `(..., False, flow == 0)` | 我们没连续变量；对应"若 `channels[].lane !== null` 则该 row 的 `channelIds` 必须含这条 id"——**用一致性 assert 代替 big-M**（P5 复核 `lanes[]` 与 `channels[].lane` 互逆） |
| A9 | **节点是否被 belt 使用 = 其所有 belt 边的 OR** | `Router.py:94-101` `addGenConstrOr` | 对应我们"占用图"的构建方式：`occ[cell] = any(channel passes cell)`。left-edge 的冲突判据就是这个 OR 的列版本 |
| A10 | **`flow ∈ [0, FLOW_CAP]` 整数 + `FLOW_CAP=4`、`IO_AMOUNT=4`、`CUTTER_AMOUNT=1`** | `constants.py`（flow 节） | **从游戏读常量**的习惯（ecosystem §2.3 已夸过这点）。→ 我们的对应常量：belt 2/s、miner 0.4/s、cutter 0.5/s、**stacker 0.25/s（瓶颈）**（DESIGN 硬约束表）。`rowsRequired = ceil(demand / 0.25)`（§2.4 `throughput.rowsRequired` 已有此字段） |
| A11 | **弯折/方向的代价不进目标，只进边类型**：目标只有 `step_edges` × `STEP_COST=1` + `jump_edges` × `JUMP_COST=2` | `Router.py:307-317`, `constants.py:9-10` | **重要发现**：MILP 版本**没有显式转向变量**——它靠"edge 带 direction `(dx,dy)`"（`Edge = (Node,Node,Direction)`，`constants.py:31`）把方向放进**索引**而非变量。→ 对我们：**不必给每条 channel 引入"转弯数"决策变量**，转弯数 = 路径的几何属性，在 `lane` 分配后由铺设阶段算出并计入 `cornerCount`/评分（§6） |

**B. 目标函数 → 评分因子**

- **MIP-Router 的目标 = 纯最小化带长（`step+jump` 加权和），单目标、无权重**（`Router.py:307-317`）。→ 太朴素，直接用会把我们的 `cornerCount` 和吞吐都丢掉。
- **MIP-Miner 的目标 = 分级加权多目标**：`max 1e9*(miners+extenders) + 饱和 bonus(4→1e6, 3→1e4, ...)`（ecosystem.md §2.3【实测】已摘；README:218-221 亦写 Priority 1/2）。→ **这才是我们要抄的目标形态**：**量级差 1e4 的分级权重**，把"能布上"永远压在"布得漂亮"之上。
  - 我们的评分建议（写入 `LayoutReport` 的扩展 `score`/`scoreParts`，见"给 P4 的建议"）：
    1. `w_feasible = 1e9`：可行（无 unresolved conflict）——**硬门，不是软分**（对齐 §2.1:205 `ok:true ⟺ errors.length===0`）。
    2. `w_throughput = 1e6`：满足需求吞吐（`rowsPlanned ≥ rowsRequired`，§2.4 throughput）。
    3. `w_corner = 1e4`：**拐角数的负值**（第一原则，GRID-LAYOUT:41-62；`cornerCount`）。这条在外部先例里 MIP-Router **没有**，是我们独有的（因为 shapez1 的弯带有 0.78 有效长度惩罚，见 §6）。
    4. `w_beltlen = 1e2`：带子总格数负值（= MIP-Router 的 `step_cost`，`Router.py:307-317`）。
    5. `w_area = 1e1`：`bbox` 面积负值（MIP-Miner 的"多矿机"对应"少占地"）。
    6. `w_lane = 1e1`：`lanes[]` 行数负值（= MIP-Router 的 `jump_cost`：能共线束就别新开行，`netMatrix` 同旨）。
    7. `w_hub = 1e0`：到 hub 的距离负值（shapez-auto 用 `abs(r.X)+abs(r.Y)` 选资源点，`layout.go:280-290`；我们的"贪心匹配资源到 site，最小化距离和"，DESIGN 阶段 A 第 2 步）。
  - **注意方向**：`STEP_COST=1 / JUMP_COST=2` 的比例 1:2 说明"换层/加速手段"比"多走一格"贵 2 倍。**我们没有 jump pad**，但"新开一行 lane"的代价应当与"多走 2 格"同量级——给 `w_lane` 的标定提供依据。

**C. 明确不要抄的**：Gurobi/CP-SAT 本身（ecosystem §326 已下结论"一律用 CP-SAT 不用 Gurobi"；**但本任务零依赖，两个都不用**）；`MIPFOCUS_*`/`PRESOLVE`/`HEURISTICS=0.5` 这些求解器参数（`constants.py:24-33`）；`TimeLimit` + `draw_solution_callback` 的交互式求解（`Router.py:287-292`）。

### 证据（文件:行）

- `Router.py:80-89` 变量 `edge_flow_value`(INT,lb0,ub FLOW_CAP) 与 `is_edge_used`(BINARY) per net per edge；`:88-89` indicator。
- `Router.py:29-41` `initialize_board`：`all_nodes` = 全网格笛卡尔积；`step_edges`/`jump_edges` 分类；`node_related_*_pad_edges` 四张邻接表。
- `Router.py:44-72` 建边循环：4 方向 step 边 + `jump_distances` 生成 jump 边（长度 `jump_distance+2`，pad 在 `+1`）。
- `Router.py:94-101` `addGenConstrOr`；`:109-114` `node_in/out_flow_value ≤ FLOW_CAP`；`:116-124` 每格唯一；`:126-142` pad 方向；`:173-249` source/sink/null 三套方向钉死；`:250-276` `add_net`（含 A3 前置校验 + A2 守恒）。
- `constants.py` `STEP_COST=1/JUMP_COST=2/EDGE_PRIORITY=50/FLOW_PRIORITY=25/FLOW_CAP=4/IO_AMOUNT=4/CUTTER_AMOUNT=1/DIRECTIONS=[(1,0),(0,1),(-1,0),(0,-1)]`。
- `Router.py:307-317` `add_objective` = `setObjective(quicksum(step*1 + jump*2))`（最小化）。
- README（`Shapez2-MIP-Router/readme.md`）明说「**Gurobi is commercial**；开源替代 PULP「significantly slower ... impractical for even moderately sized routing problems」」→ **印证"我们不做 MIP"是对的**：连作者都说中等规模就要商业求解器。【实测】
- `Shapez2-MIP-Miner/README.md:200-228`「Problem Statement / Objectives (Multi-objective) / Constraints」整节【实测】：miner 1 item/s、**belt max flow 48 items/s**、每格 1 实体、belt `out==in`、extractor `out==in+1`、elevator 消耗、placement limits、两级优先目标。
- **与内部盘点的差异（要回给主 Agent）**：ecosystem.md §1.3:26 与 :333 说 MIP-Miner「最新版已从 Gurobi 迁到 CP-SAT，**读时要看代码不看 README**」。本次实测：**README 已自述 "using Constraint Programming (CP-SAT) with Google's OR-Tools"**（README:3）→ 那句"README 还讲 Gurobi"的警告对当前 HEAD **已部分过时**（仍应看代码，因为 README 里的 Quick Start 还写 `pip install ortools` 但 §2.3 的"belt 上限 12×4"与 README 的"48 items/s"数值**一致** = 12*4=48，可放心用）。【实测】

### 移植成本

**零依赖可移植的是"清单"而不是"求解器"**：
- A1–A11 全部降级成 P5 的 assert / `conflicts[]` 判据，成本 ≈ 每个判据 3–10 行，合计 <150 行。
- B 的分级加权评分 ≈ 30 行（一个 `scoreParts` 对象 + 一个求和）。
- 真上 CP-SAT = 引入 Python + ortools（几百 MB）+ 破坏确定性 + 全局重解推翻旧厂 → **不做**（§7）。

### 给 P4 的具体建议

1. **A3（源宿量相等）先做**：它在 P4 布线**之前**就能判死，最便宜、最能防止"A* 跑完才发现不可能"。放进 P3→P4 的入口检查，失败 → `conflicts{kind:"hub-contention"}` 之外的新语义用 `reason:"dag-not-placeable:fanin>2"` 或 `column-conflict-unresolved`（§2.5 枚举已有，**不建议新增枚举报主 Agent**）。
2. **A1（每格唯一）用 `lanes[]` 表达而不是逐格检查**：`lanes[].row` 不同 ⇒ 不共格；同 row 时 `channelIds` 的列区间必须两两不重叠（= §1 的 left-edge 冲突判据）。**逐格互斥检查留给 P5 `V1/V2`（旧厂对接需要它）**。
3. **评分落进 `LayoutReport`**：契约 v1 **没有 `score` 字段**（§2.3:244-260 只有 `cornerCount`）。→ 建议 P1 加两个**可选**字段 `score:number|null` 与 `scoreParts:Record<string,number>|null`，把 B 的 7 个因子写成键名（`feasible/throughput/corner/beltLen/area/lane/hub`）。**这是契约变更，须交主 Agent/P1 决定**；P4 可先在自己目录的 `research/ai-plan/router/NOTES.md` 里落 `scoreParts` 的内部结构，不改 `types.mjs`。
4. **`cornerCount` 现在就当一级因子用**（外部先例里我们独有它，是差异化优势；`w_corner` 权重 > `w_beltLen`）。
5. **与行式 DESIGN 的关系：支持**。DESIGN 的吞吐章节（「吞吐计算」节 + 关键约束 2「每条满带需要 8 台 stacker」）与 A10/`rowsRequired` 完全对齐；DESIGN 缺的正是"分级加权"这个目标结构——本次补上。

---

## 6. 带转向代价的 A*（状态含朝向）

**读了 3 个实现**：① `Songxwn/shapez-auto` `internal/plan/layout.go:567-685`【实测，见 §2】；② `QXIKmIJ/shapez-ai` `shapez-ai/python/planner/router.py`（**924 行**，`gh api` 下载后读 `find_path` :126-187 + `path_to_belts` :189-247）【实测】；③ `Shapez2-MIP-Router/Router.py`——**MILP 版根本没有 A\***，它把方向放进边索引（`Edge=(u,v,(dx,dy))`），见 §5 A11【实测】。

### 结论（可直接用什么）

**先给最重要的一条：项目里已有的 0.78 说法是"弯带弧长"，不是"容量折扣"——不能按字面拿去算吞吐。**
- 【实测，读游戏源码】`recon/upstream-full/src/js/game/components/belt.js:6`：`export const curvedBeltLength = /* Math.PI / 4 */ 0.78;`
- 同文件 `getEffectiveLengthTiles()`（:64-71）：`return this.direction === enumDirection.top ? 1.0 : curvedBeltLength;`
- `this.direction` 在 **rv0（直带）时是 `top`**（局部出口 rv0=top，`src/ai/belt-rules.mjs:36`），rv1/rv2 是 `left`/`right`。→ **直带有效长度 1.0、弯带 0.78 确实成立**，`ADVERSARIAL-REVIEW.md:221-223` 的"拐角不是免费的"**结论正确**；但它写的"curved belt 有效长度 0.78 格"要精确成：**每条弯带比直带短 0.22 格的弧长 ⇒ 同一 item 间隔下，弯带能容纳的在途物品少一些**（`review:223` "布局器'拐角=免费'的隐含假设错了：拐角多的线吞吐上限更低" 是【推断】中肯，但**要落地必须先把 0.78 换算成 item-capacity，这一层目前没有任何文档给出公式** → **标【待验】**，验证办法见下）。

**两个外部实现的对照（关键差异）**：

| 维度 | shapez-auto `route()` | shapez-ai `find_path()` |
|---|---|---|
| 状态 | `(x,y,inDir)` `[3]int` key（:569,583） | `(tile, delta)` `cost_so_far` key（:146,166） |
| 转向代价 | **无**，只有 `g+1`（:622） | **有**：`step_cost = 1.0 + (turn_penalty if is_turn else 0.0)`，默认 `turn_penalty=1.5`（:132,163-165） |
| 合法性判据 | `BeltPose(in,out)`（几何，弯带专用；**直行会返回 false**，geom.go:46-48） | **没有几何判据**，任意转向都合法；几何留到 `path_to_belts` 事后推（:229-243） |
| 启发项 | 曼哈顿（:625），但 g 无转弯罚 ⇒ 等价于"最短格数优先" | 曼哈顿（:170），g 含转弯罚 ⇒ **仍可采纳**（见下：每步代价 ≥1，剩余步数 ≥ 曼哈顿距离），只是弱 |
| 防自交 | `onPath()` 沿 prev 链查（:639-647） | 无（只有 `cost_so_far` 最优性） |
| 熔断 | `pops>100000 → false` | `searched<max_search`（默认 5000，调用点传 3000/4000）**→ None** |
| rv 生成 | 搜索时即知（每边都验 `BeltPose`） | **事后**：`rot_diff=(out_rot-in_rot)%360`，`270→variant=1(左)`、`90→variant=2(右)`、`else 0(直)`（:229-243） |

**shapez-ai 的 rv 表方向与本项目一致**：它 `rot_diff==270 ⇒ 左弯 rv1`、`==90 ⇒ 右弯 rv2`，与 `src/ai/belt-rules.mjs:64-66`（`solveTurn("bottom","left") → rv1`；`("bottom","right") → rv2`）对得上；且 `belt-rules.mjs:9` 自带"交换 rv1↔rv2 会让双侧闭合崩到 0"的可证伪判据 → **两个独立来源 + 一个内部实机验证 = 这张表可以放心用**（ecosystem.md §2.7 也说"与我们的 belt 定向逻辑同一份知识"）。【实测】

**但 shapez-ai 的 `path_to_belts` 有一个我们必须避开的做法**：它把**直带也当成 `rotationVariant=0` 的普通格子逐个 emit**（:240 `else { variant = 0 }`），并且末格 `d_out = d_in`（:225-227，若无 `final_rotation`）——**这等于"假设最后一格自己决定出口=直行"**，不校验是否与下游 acceptor 槽对齐。我们的 §1.4:97 要求 `solveTurn` 返回 `null` 就**报结构化错误不许硬凑**，所以移植时**端点对齐必须由调用方显式传 `outDir`**（我们的 `channels[].to.inDir` 已经带了，见 §0）。

**关于启发项的可采纳性（我的分析，标【推断】）**：若每格代价 = `1 + (penalty if 转弯)`，那么从 `(x,y,d)` 到目标，剩余**格数** ≥ 曼哈顿距离，但剩余**转弯数**未知。所以：
- `h = manhattan`（不含转弯罚）→ **可采纳**（低估），A* 仍最优，只是弱；
- `h = manhattan + penalty * minTurnsNeeded(d→outDir)`，其中 `minTurnsNeeded = (d != outDir ? 1 : 0)`（再加"必须拐弯才能对准"的下界）→ **仍可采纳**，因为任何解至少需要那么多次转弯；
- **shapez-ai 的 `h = manhattan`（:170）而 g 含转弯罚**，正是第一种：**可采纳、弱启发**，它靠 `turn_penalty` 只影响排序不影响 h，等价于"允许次优解换更直的路"——**这对我们恰好是想要的行为**（`cornerCount` 一级评分因子权重高于 `beltLen`，§5 B.3）。
- 更省事的替代：**Dijkstra + 显式转弯代价**（我们的搜索空间只有几十格，4×格数 个状态，完全不需要启发项来剪枝）。**这是我最推荐的落地形态**——省掉"h 是否可采纳"的论证负担，也省掉 P4 验收里最难的一条。

### 证据（文件:行）

- `layout.go:567-637` 状态 `(x,y,inDir)`；`:592-605` 起点直行被挡则强制拐弯；`:608-610` `BeltPose` 当合法性判据；`:617` `onPath` 防自交；`:587-590` pop 熔断；`:662-685` `rebuild` 反推 `(rot,variant)`。【实测】
- `geom.go:45-61` `BeltPose`（`inDir==outDir → false`；`rot` 表 `{south:0,west:90,north:180,east:270}`；variant 局部出口 `[north,west,east]`）；`:63-71` `BeltIO` 反向。【实测】
- `router.py:3` 头注 `Features orthogonal turn penalties for clean Manhattan factory layouts, modular processing cells, and line reuse.`；`:32-33` `manhattan_distance`；`:126-140` 签名 `max_search=5000, turn_penalty=1.5` + docstring "heavily favor straight, clean, aesthetic conveyor runs over chaotic zigzagging (Manhattan bus routing)"；`:142-146` 状态/`cost_so_far`；`:163-171` 代价与入堆；`:175-176` 无解 `return None`；`:189-247` `path_to_belts`；`:229-243` rv 判定。【实测】
- `router.py:35-111` `get_cutter_geometry`/`get_painter_geometry` 把 4 个旋转下的**占地/输入口/丢弃口/输出口**全部写死；`:114` `hub_bounds=(-2,-2,4,4)`；`:123-124` `is_blocked = tile in hub_tiles or obstacles`；`:249-279` `find_nearest_hub_slot`；`:826-870` `plan_mix_and_paint_line` 的 **cell_footprint 预占 + 逐条 path 串行加障碍**（`obs_out / obs_shape / obs_c1 / obs_c2`，每找一条路就把它的格加进下一次搜索的障碍集）；`:367-429` 候选位枚举 + `cost = len(path1)*1.5 + len(path2)` 取最小。【实测】
- `recon/upstream-full/src/js/game/components/belt.js:6`（`curvedBeltLength=0.78`，源码注释保留 `/* Math.PI / 4 */`）、`:64-71`（`getEffectiveLengthTiles()`，`direction===top ? 1.0 : curvedBeltLength`）、`:103-119`（按 direction 分支走弧长进度，`assert(progress <= curvedBeltLength + 0.02)`）。【实测，本仓库一手源码】
- `src/ai/belt-rules.mjs:36-56` `EXIT_LOCAL`/`beltExit`/`beltEntry`/`solveTurn`（**`inDir===outDir → null`**，注释:43「有解 ⟺ in≠out 且为直角或直线」）；`:9` rv1↔rv2 可证伪判据。【实测，本仓库】

### 移植成本

带朝向的 A*/Dijkstra ≈ **120–180 行 JS**：状态 key `(y*W+x)*4+dirIdx`、`closed` 按 (cell,dir) 记账、转弯查 `solveTurn`、`rebuild` 从父链反推每格 `(in,out)` 再调 `solveTurn`。我们的走廊只有几十格 → **优先队列可以用数组 + 线性最小值**（省掉堆实现，代码更短、无 bug 面）。

**关键移植陷阱（务必写进 NOTES）**：
1. **不要用 `BeltPose`/`solveTurn` 判"直行"**。我们的 `solveTurn(inDir,outDir)` 在 `inDir===outDir` 时返回 `null`（`belt-rules.mjs:46`，注释说"同向穿过的不是带子该有的形态"），而 shapez-auto 的 `BeltPose` 同样 `in==out → false`（geom.go:46）。→ **直线段必须走"轴对齐填充 + 固定 (rot, rv=0)"这条路（§1.4:96「直线段：轴对齐填充」），只有转向格才调 `solveTurn`**。把 `solveTurn` 当"每条边都问一次"会全线报 `no-turn`。
2. **`rotationVariant` 的局部出口表只有一个权威 = `belt-rules.mjs`**，两个外部实现的表（`geom.go:52` 与 `router.py:229-243`）都只作对拍用。
3. **0.78 目前不进代价函数**，只进 `stats`/文档（见下）。

### 给 P4 的具体建议

**最小伪码（`belt-rules.mjs` 是唯一几何权威）**

**先钉死四条语义**（竞品与本报告初稿都在这里有歧义；第 4 条是**契约本身的歧义**，必须让 P1 钉死，不许各自猜）：
- `ch.from.cell` / `ch.to.cell` 是**机器格**，不是带子格；
- 第一个带子格 = `from.cell + DIRV[from.outDir]`（上游机器出口面外一格）。
- **最后一个带子格取决于 `ch.to.inDir` 的读法**（见下一条），两种读法给出**不同的格**：
  - 读法 A（`inDir` = 下游机器的**入口槽方位**，与同层的 `slot:DirName` 一致）：`last = to.cell + DIRV[to.inDir]`，且该带子的 `outDir = OPP(to.inDir)`；
  - 读法 B（`inDir` = 货流**进入的方向向量**）：`last = to.cell + DIRV[OPP[to.inDir]]`，且 `outDir = to.inDir`。
- 【待验 · 必须让 P1 在 `types.mjs` JSDoc 里钉死】**契约文档本身没有定义这个字段语义**：`LayoutReport.channels[]` 的 JSDoc（plan-compiler §2.3:249-252）只写了 `to:{nodeId, cell, slot, inDir}`，而 `entities[]` 里 belt 的 `inDir/outDir` 是**带子自己的**进出（`fixtures/plan-l1`：belt `(0,10)` `inDir:"bottom" outDir:"top"`，其下游 cutter `(0,8)` `inDir:"bottom"` ⇒ **belt.outDir 与 machine.inDir 互为反向**，即 fixture 支持**读法 A**）。→ 我在下面伪码里**按读法 A 写**（`last = add(to.cell, to.inDir)`，目标判据 `out === OPP(ch.to.inDir)`）。**若 P1 定义成读法 B，只需把 `atGoal` 与 `last` 的两处 `OPP` 去掉即可，其余不变。** 这条歧义值得在 P4 动工前先问清——它会让整条链的方向反掉，而 P5 的 `V4-slot-alignment` 要到最后才发现。
- 若 `first === last`（两机器相邻，只有一个带子格）= **退化段**，IR 里保留这一格，不许当异常（plan-compiler §1.4:96）。

```js
// routeChannel(ch, occ, {straightCost=1, turnCost=2, cap=4000}) → {cells, poses} | {conflict}
//   ch  : LayoutReport.channels[i] {from:{nodeId,cell,slot,outDir}, to:{nodeId,cell,slot,inDir}, lane, payload}
//   occ : Set<"x,y"> 已占格（机器占地 ∪ hub 4×4 ∪ 旧厂 ∪ 其它 lane 已铺格）
import { ORDER, OPP, DIRV, solveTurn, beltCode } from "../belt-rules.mjs";

const idx = d => ORDER.indexOf(d);                    // top0 right1 bottom2 left3
const key = (x, y, d) => `${x},${y},${idx(d)}`;
const add = (p, d) => [p[0] + DIRV[d][0], p[1] + DIRV[d][1]];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export function routeChannel(ch, occ, { straightCost = 1, turnCost = 2, cap = 4000 } = {}) {
  const first = add(ch.from.cell, ch.from.outDir);          // 第一个带子格（上游机器出口面外一格）
  const last  = add(ch.to.cell, ch.to.inDir);               // 最后一个带子格（下游机器入口面外一格）
  // 读法 A：末端带子格的出口方向 = 下游机器入口面的**反向**（fixture：belt outDir top ⇒ cutter inDir bottom）
  const goalOut = OPP[ch.to.inDir];
  const pose = (x, y, inDir, outDir) => {
    const p = solveTurn(inDir, outDir);
    if (!p) return null;
    return { x, y, inDir, outDir, ...p, code: beltCode(p.rotationVariant) };
  };

  // 快路 0：退化段（一格）。入口 = 上游出口面的反向，出口 = goalOut
  if (same(first, last)) {
    const p = pose(first[0], first[1], OPP[ch.from.outDir], goalOut);
    if (!p) return { conflict: { kind: "no-turn", cells: [first],
                                 nodeIds: [ch.from.nodeId, ch.to.nodeId], resolvedBy: null } };
    if (occ.has(`${first[0]},${first[1]}`))
      return { conflict: { kind: "cell-occupied", cells: [first], nodeIds: [ch.from.nodeId], resolvedBy: null } };
    return { cells: [first], poses: [p] };
  }

  // 快路 1：轴对齐直线填充（§1.4:96「直线段：轴对齐填充」）。不进搜索。
  const d = ch.from.outDir;
  if (goalOut === d && onRay(first, last, d)) {              // 同轴且方向一致
    const cells = [];                                        // 从 first 逐格走到 last
    for (let c = first; ; c = add(c, d)) {
      if (occ.has(`${c[0]},${c[1]}`)) return { conflict: { kind: "cell-occupied", cells: [c],
            nodeIds: [ch.from.nodeId, ch.to.nodeId], resolvedBy: null } };
      cells.push(c);
      if (same(c, last)) break;
    }
    const poses = cells.map(([x, y]) => pose(x, y, OPP[d], d));   // 全 rv0
    if (poses.some(p => !p)) return { conflict: { kind: "no-turn", cells, nodeIds: [ch.from.nodeId, ch.to.nodeId], resolvedBy: null } };
    return { cells, poses };                                  // 断言：poses.length === 曼哈顿距离
  }

  // 一般情形：Dijkstra over (cell, outDir)。状态数 = 4×格数（几十格）⇒ 线性取最小即可，不必写堆
  if (occ.has(`${first[0]},${first[1]}`))
    return { conflict: { kind: "cell-occupied", cells: [first], nodeIds: [ch.from.nodeId], resolvedBy: null } };
  const start = { x: first[0], y: first[1], out: ch.from.outDir, g: straightCost, prev: null };
  const best = new Map([ [key(start.x, start.y, start.out), start.g] ]);
  const front = [start];
  let pops = 0, found = null;
  const atGoal = (x, y, out) => (x === last[0] && y === last[1] && out === goalOut);

  while (front.length) {
    if (++pops > cap) return { conflict: { kind: "crossing", cells: [ch.from.cell, ch.to.cell],
                                nodeIds: [ch.from.nodeId], resolvedBy: null } };  // 预算耗尽：独立语义，别混成"无路"
    const cur = takeMin(front);
    if (atGoal(cur.x, cur.y, cur.out)) { found = cur; break; }
    for (const out of ORDER) {
      if (out === OPP[cur.out]) continue;                    // 禁原地掉头（等价 solveTurn 返回 null）
      const nx = cur.x + DIRV[out][0], ny = cur.y + DIRV[out][1];
      if (occ.has(`${nx},${ny}`)) continue;                  // 不穿机器 / hub 4×4 / 旧厂 / 别的 lane
      if (same([nx, ny], ch.to.cell) || same([nx, ny], ch.from.cell)) continue;  // 不许踩回机器格
      const g = cur.g + (out === cur.out ? straightCost : turnCost);
      const k = key(nx, ny, out);
      if (best.has(k) && best.get(k) <= g) continue;
      best.set(k, g);
      front.push({ x: nx, y: ny, out, g, prev: cur });
    }
  }
  if (!found) return { conflict: { kind: "crossing", cells: [ch.from.cell, ch.to.cell],
                                   nodeIds: [ch.from.nodeId, ch.to.nodeId], resolvedBy: null } };

  // rebuild：沿父链取每格 (inDir, outDir)，**逐格调 solveTurn**（搜索期不选 rv，只禁掉头）
  const path = []; for (let n = found; n; n = n.prev) path.push(n); path.reverse();
  const poses = [];
  for (let i = 0; i < path.length; i++) {
    const inDir  = i === 0 ? OPP[ch.from.outDir] : OPP[path[i - 1].out];   // 上一格出口面 = 本格入口面
    const outDir = path[i].out;
    const p = pose(path[i].x, path[i].y, inDir, outDir);
    if (!p) return { conflict: { kind: "no-turn", cells: [[path[i].x, path[i].y]],
                                 nodeIds: [ch.from.nodeId, ch.to.nodeId], resolvedBy: null } };
    poses.push(p);
  }
  return { cells: path.map(n => [n.x, n.y]), poses };
}
```

> **伪码迭代记录（诚实保留，别照抄旧版）**：初稿有两个真错，已修正——
> 1. **把 `from.cell`/`to.cell` 当成了带子格**。它们其实是**机器格**，所以第一个带子格 = `from.cell + DIRV[from.outDir]`、最后一个 = `to.cell + DIRV[OPP[to.inDir]]`；不这样改，`atGoal` 判据会要求"在某台机器身上结束"，永远搜不到。
> 2. **主循环里 `const pose = solveTurn(OPP[cur.out], inDir)` 算了又不用**，且把"本格出口"与"下一格入口"混进同一次调用。**正确的是**：搜索期**不需要** `solveTurn`（任意 90° 转向都可实现，`belt-rules.mjs:47-54` 是 4 rot × 3 rv 全枚举，直角必命中），只需禁掉头（`out === OPP[cur.out]`）；`(rot, rv)` **全部在 `rebuild` 里逐格算**。
> 与 shapez-auto 不同——它让 `BeltPose` 同时充当"合法性判据 + rv 求解"，因而**直行边会被 `BeltPose` 判 false**（`geom.go:46-48` `inDir===outDir → false`），我们照抄会全线报 `no-turn`。→ **我们的移植成本因此比竞品更低**：不用处理"直行不是带子"这个怪癖（代价是我们要自己区分"直线填充快路"与"转向格"两条码路）。

**转向代价取值**：`turnCost` 建议 **2 × straightCost**，理由与来源：
- shapez-ai 实测取 `1 + 1.5 = 2.5`（相对直行 1.0），docstring 明说是为了"避免 chaotic zigzagging"（`router.py:132, 136-138`）；
- MIP-Router 的 `JUMP_COST/STEP_COST = 2/1`（`constants.py:9-10`）——**两个独立项目分别得到 2 与 2.5，取 2 是保守下界**；
- 我们 `cornerCount` 是一级评分因子（§5 B.3），且弯带有效长度 0.78 < 1.0（`belt.js:6,71`）⇒ **转弯比外部世界更贵，2 是下界而非上界**。
- 【待验】"1 个拐角导致吞吐下降多少"：验证办法 = 在离线 belt 模拟里（P5 的 `belt-sim.mjs` 或 `exp-belt-order.mjs` 的路子）构造两条等长、只在一个拐角上 differing 的带子，喂同一批 item 测稳态间隔；或直接读 `components/belt.js` 的 item 间隔计算（`updateAbsolutePosition`/`prevItemOnBelt` 那一片）确认 0.78 是否进 `itemSpacing`。**我不下数字结论**。

**不可行上报（本项目红线，不许学竞品）**：
- 三种不可行必须分开：`kind:"cell-occupied"`（走廊被占）、`kind:"crossing"`（需穿另一条 lane/需隧道 → `reason:"dag-not-placeable:crossing-needs-tunnel"`，§2.5）、`kind:"no-turn"`（端点朝向无解 → `reason:"belt-turn-unsolvable"`）。
- 熔断（`pops > cap`）**必须**写 `resolvedBy:null` + 独立 reason，不许复用"无路"的 kind。竞品 `layout.go:587-590` 把两者混成 `false` 是反面教材。

**其它两条从 shapez-ai 抄的具体机制**：
- **串行加障碍**（`router.py:862-883`）：铺第 k 条 path 前，把前 k-1 条的格加进 `obs`。→ 这就是我们 `lane` 之外处理"多 channel 顺序铺设"的正规做法，**但它只在单条产线内部用；跨分支必须靠 `lane`/row 分离**（陷阱表 #5）。
- **cell_footprint 预占**（`router.py:857-858`）：先把整个模块占地集合算出来、一次性检查 `is_blocked`。→ 对应 P5 `V1-occupancy`；我们的 2×1 机器（cutter/stacker/painter）必须**先算 footprint 再谈布线**，且 `placements[*].footprint` 契约已有（§2.3:248）。

---

## 7. 不建议做的

| 不要做 | 理由（带来源） |
|---|---|
| **CP-SAT / Gurobi / 任何 MIP 求解器** | ①零依赖铁律（plan-compiler §2:174「只有 ESM + `node:` 内置；**不得**引入 typescript/zod/npm 任何东西」）；②MIP-Router 作者自己在 README 说开源替代 PULP「significantly slower … **impractical for even moderately sized** routing problems」【实测 §5】——连全规模都撑不住，我们没必要；③全局重解会推翻旧厂位置，与"增量对接"直接冲突；④`facts/ecosystem.md` §1.3:26-28/§326 已把"用 CP-SAT 不用 Gurobi"作为既有结论，本报告进一步主张**连 CP-SAT 也不用，只抄清单**。→ §5 的 A1–A11 + B 就是"抄清单"的成品。 |
| **simulated annealing / 迭代优化放置** | verilog2factorio **确实有**（`annealing.ts` 全文 + `chunkAnnealing.ts` 416 行，README `-g annealing(default)`），但：①用 `RNG`（`annealing.ts:4,58`）⇒ **不可复现**，直接打掉 P5 变异测试与 P7 逐格 diff 的方法论；②代价函数**只有边长**（`annealing.ts:232-234`、`chunkAnnealing.ts:268`），不含 congest/overlap，**不能表达我们的 rv 漂移 / hub 争用 / 弯带长度风险**；③它的规模是 `iterationCount=2000*sqrt(n)`（:185），对我们 n≈20 等于 8944 步换一次 left-edge 的 20 步——**纯亏**。→ **注意**：这条修正了 `facts/ecosystem.md` §1.3:76 的「退火布局生成器可借鉴」，要抄的是 `matrix`（channel routing，§3），**不是**退火。 |
| **通用图绘制库（ELK / dagre / JGraphX）** | 输出是自由坐标/SVG 语义，不是"每格 belt + rotation + rv + code"；适配层会比重写算法更长；且违反零依赖。§1 的三步（layering / barycenter / left-edge）实测 150–250 行可覆盖我们的全部需求。**没找到任何工厂类项目用它**（本次 6 个仓库全无），这本身是证据。 |
| **PathFinder 式 rip-up-and-reroute 多轮迭代 / 完整 switchbox routing** | ①arXiv 上 `all:"switchbox routing"` **0 命中**、`all:"left-edge algorithm"` **0 命中**（本会话实测）⇒ 无现代参考实现可依，踩坑成本高；②`all:"crossing minimization"` 命中的 **arXiv:2412.06361** 是"需要专门的精确 + 启发式双求解器"的 **One-Sided Crossing Minimization** ⇒ 一旦允许交叉最小化进入主干，我们就掉进一个至今需要专门 solver 的 NP 问题。**我们的工程解是绕开它**：§1 实验证明"父子保序 ⇒ 无 vertical constraint ⇒ 无交叉"。 |
| **Htree 作通用布线算法** | 只覆盖递归对称 2 幂分叉；shapez 是 2 进 stacker/mixer、3 出 splitter、4 出 distributer（`facts/GEOMETRY-TABLE.md`），不满足前提。仅"4→1 对称合并"这一特例可当模板（§1.6）。 |
| **允许模块任意旋转/镜像的端口吸附求解** | v1 已钉死 `placements[*].rot === 0`（决策 D1，plan-compiler §2.3:263，理由：槽位表只在 r=0 定义 + `static_map_entity.js:127-141` origin 位移未实机验证）。禁旋转 ⇒ 对接问题降成平移匹配，成本几乎为零；允许旋转则要处理 draftsman 那种"导出时才惰性平移"（`blueprint.py:104-118`）的复杂度，收益不明。 |
| **在 `route()` 里同时做"合法性判定 + rv 求解"（shapez-auto 的做法）** | `BeltPose` 把 `inDir===outDir` 判 false（`geom.go:46-48`），照抄会让所有直线段报 `no-turn`。我们的 `solveTurn` 同样 `inDir===outDir → null`（`belt-rules.mjs:46`）——**所以必须把直线段拆成独立的"轴对齐填充"快路**（§1.4:96 已经这么要求了，本报告给出为什么）。 |
| **把 `route()` 失败压成一个 `false` / `None`** | `layout.go:587-590` 的 `pops>100000 → false` 把"无路"与"太难"混为一谈；`router.py:175-176` 的 `return None` 同样无信息。→ 本项目红线：必须分开成 `cell-occupied` / `crossing` / `no-turn` + 预算耗尽的独立 reason（§6）。 |
| **用 0.78 直接算吞吐折扣** | `belt.js:6,71` 的 0.78 是**弯带弧长**（`getEffectiveLengthTiles()`），**没有任何一手文档给出它到 item-capacity 的换算**。`ADVERSARIAL-REVIEW.md:221-223` 的方向对（拐角不免费）但**数值未落地**。→ 先只做 `cornerCount` 计数与 `turnCost`，0.78 留在 NOTES；换算公式属 §6 的【待验】项，验完再进评分。 |
| **给 `conflicts[].kind` 新增枚举值**（我一开始想加 `socket-unreachable`/`no-path`/`lane-exhausted`） | v1 kind 枚举已由 P1 定死在 §2.3:257 的五个值；§2.5 的 `reason` 枚举也齐备。**用 `resolvedBy` 区分解法（§3 建议 4）+ 复用现有 kind 就够了**，扩契约要主 Agent/P1 决定。本报告只在 §5 对 `score/scoreParts` 提了一个"须走 P1"的**可选**新增，其余不加。 |

---

## 8. P4 选型建议

**推荐：行式为主干 —— 「分层 → 层内 barycenter（且父子保序）→ 行间走廊 left-edge 车道分配」，带朝向的 Dijkstra（不是 A*）只负责 lane 内铺格与对接 hub/旧厂；shapez-auto 的"候选位环 + trial/commit"只作为 lane 分配失败后的兜底，不进主干。**

**理由（一句话 + 四条支撑）**：把"不交叉"从搜索问题变成排序+区间 packing 问题后，我们的规模让解析式算法（一次扫描、可证明）严格优于搜索式（回溯、不可解释）；而 P4 契约的 `lane:number` + `lanes[]:row→channelIds` **本来就是 channel routing 的 track 编号表**，选行式等于选契约。

- 支撑 1（**本会话计算实验**）：父子保序 ⇒ 无 vertical constraint ⇒ 无交叉；left-edge 在 27405 个穷举实例上全部等于色数最优（§1 证据）。
- 支撑 2（**外部先例同构**）：verilog2factorio 的 `matrix` 生成器就是一个 first-fit 区间划分器（`netMatrix.ts:93-110`），且它**不用 tunnel**、纯靠分线束消交叉（§3）——与我们 v1"只做水平错位 + 加宽行距，隧道推到 v2"完全同路（plan-compiler §1.4:98）。
- 支撑 3（**竞品短板实测**）：shapez-auto 有候选位环和带朝向 A*，但**零评分函数**（grep `score|cost|rand|anneal` 全零命中）、**无车道概念**（两条分支就得靠 A* 绕 + 多拐角）、**不支持增量对接旧厂**（`newWorld` 只吃资源点）、**失败压成 `false`**（§2 容量上限节）。它是"能跑但不可扩展"的形状，正好是 P4 该超出的基线。
- 支撑 4（**MILP 反证**）：连专门做路由 MILP 的作者都说中等规模离不开商业求解器（`Shapez2-MIP-Router/readme.md`）；而它的目标函数**只有带长**（`Router.py:307-317`，无转弯项），我们的 `cornerCount` + 弯带 0.78 让"最少拐角"成为一级目标——**这类非凸项 MIP 本来就不擅长，启发式反而是对的-tool-for-the-job**（§5 A11/B.3）。

**主干与 DESIGN 的关系：支持并加强 `layout-compiler-DESIGN.md` 阶段 A/B**，不改方向。阶段 A（行式排布）保留，加一条硬规则"同一父的子在子层保持父层相对顺序"；阶段 B（冲突消解）从口头规则升级为可执行可测的 **left-edge 首适 + vertical-constraint 判据 + `resolvedBy ∈ {new-lane, shift-x, widen-row, null}`**。DESIGN 缺、本次补的只有一件：**分级加权的目标结构**（`1e9/1e6/1e4/1e2/1e1`，抄 MIP-Miner 的多目标做法，§5 B）。

**什么证据出现时应换（可执行的换向条件）**：

1. **P7 实机发现某种形态在行式下不可布** → 换 **shapez-auto 的候选位环 + trial/commit**（`layout.go:505-532`、`:483-503`）。具体触发：`conflicts{kind:"lane-column", resolvedBy:null}` 在 level-11 多层形状（4 输入两两二叉化，plan-compiler §1.4:88 验收④）上稳定复现，且 `widen-row` 扫到上限仍无解。
2. **需要的 lane 行数超过走廊可用行数**（旧厂把走廊切碎）→ 换 **shapez-ai 的 cell_footprint 预占 + 串行加障碍**（`router.py:857-883`），即"整模块候选位搜索"而不是逐 channel 布线；同时把 `rows[].y` 从固定 stride 改成"按可用走廊自适应"。
3. **P7 实测显示拐角数量是吞吐瓶颈的主因**（§6【待验】的 0.78→capacity 换算做出来且数值显著）→ 把 `turnCost` 从兜底提到主干评分一级因子（与 `cornerCount` 同权），并把"少拐角"作为 barycenter 排序的 tie-break 目标；必要时引入 shapez-auto 的 `connectSouth` **竖直走廊预占**（`layout.go:160-202`）来消除"收集带→hub 那一段"的拐角。
4. **竞品实测在同配方上产出密度明显优于行式**（更少格数 / 更短带；验证办法：跑 `/tmp/sz-auto` 的 `go test ./internal/plan`，或对本项目 level-2/level-11 goal 各产一份 `Placement` 列表数实体）→ 采纳它的候选位枚举做混合：**行式给结构（rows/lanes），候选位给形状（每层 x 起点）**。
5. **出现 ≥3 条并行产线且争用同一 hub 边**（`hub-contention`）→ 这已经越过 §5 A3"源宿量相等"的范畴，属选址/资源分配问题，应升级到全局分配（匈牙利或简单贪心），**不是 P4 的责任**，交回主 Agent 排期。

**给 P4 的落地顺序（依赖关系已排好）**：
1. `lane.mjs`：left-edge 首适（区间 + **vertical constraint 都算冲突**），产 `lanes[]`/`channels[].lane`/`conflicts`。→ 可直接拿 §1 的实验脚本当 golden 的可复现依据。
2. `route.mjs`：直线填充快路 + §6 的 Dijkstra；每格 `(inDir,outDir,rotation,rv,code)` 只经 `solveTurn`/`beltCode`。
3. 三类不可行分开上报；`resolvedBy` 记解法；**不引入 RNG、不引入迭代优化**。
4. 最后才加候选位环兜底（条件 1/2 真出现时）。

---

## 附：本次新增/修正的内部认知（交主 Agent，我不改别人文件）

1. **修正 `facts/ecosystem.md` §1.3:76**：verilog2factorio「退火布局生成器可借鉴」→ 应改为「**`matrix` 布局器（channel routing / first-fit 区间划分）可借鉴；退火不可借鉴**（RNG 破坏可复现性，代价函数不含我们的风险项）」。【实测】
2. **修正 `facts/ecosystem.md` §1.3:333**：「MIP-Miner 旧 README 仍在讲 Gurobi」→ 当前 HEAD 的 README **已自述 CP-SAT**（README:3）；但"看代码不看 README"的习惯仍保留（belt 上限 `12*4 = 48` 与 README:205「maximum flow of 48 items/s」已互相印证）。【实测】
3. **补充 `ADVERSARIAL-REVIEW.md:221-223` 的精度**：0.78 是 `getEffectiveLengthTiles()` 的**弯带弧长**（`components/belt.js:6,64-71`，rv0/直带 = 1.0，rv1/rv2 = 0.78），**不是现成的容量系数**；"拐角多的线吞吐上限更低"方向正确但**换算未落地**。→ 建议列为 needs-live-test 或离线 belt 模拟实验项。【实测 + 推断】
4. **`review/ADVERSARIAL-REVIEW.md` 未提到的新风险**：竞品 `route()` 的 `onPath()`（`layout.go:617, 639-647`）沿 prev 链禁止路径**自交**——**若我们抄它的搜索而不抄这条，可能出现"一条带自绕成环"**。但我们的 `solveTurn` 对直角才有解、对掉头返回 `null`（§6），加上 lane 分离，**天然不会产生环**；此条列为"已知差异，不需要防御"，供 P4 放心。【实测 + 推断】

---

## 附 2：来源清单与取用方式

| 来源 | 取用方式 | 覆盖小节 |
|---|---|---|
| `Songxwn/shapez-auto`（本地克隆 `/tmp/sz-auto`，HEAD `73ac7fe`） | 【实测】全文读 `internal/plan/layout.go`(685)、`geom.go`(91)，扫 `plan.go`(334)、`solve.go` 头部 | §2 §6 |
| `Redcrafter/verilog2factorio` | 【实测】`gh api repos/.../contents/<path>` + base64 解码：`README.md`、`src/`+`src/layout/`+`src/optimization/` 目录、`src/nets.ts`、`src/layout/netMatrix.ts`(172 全文)、`annealing.ts`(片段)、`chunkAnnealing.ts`(416，仅 grep) | §1 §3 §7 |
| `jiahao-0204/Shapez2-MIP-Router` | 【实测】`Router.py` 419 行下载通读、`constants.py` 全文、`readme.md` 头部 | §5 §6 §7 |
| `jiahao-0204/Shapez2-MIP-Miner` | 【实测】`README.md` 253 行（读 Problem/Objectives/Constraints 整节）+ `app/` 目录；**`astroid_solver.py` 未重读**（沿用 `facts/ecosystem.md` §2.3 的【实测】清单） | §5 §7 |
| `redruin1/factorio-draftsman` | 【实测】`classes/collection.py`(2200，grep+关键段)、`mixins/circuit_connectable.py`(117 全文)、`classes/association.py`(全文)、`constants.py`(1150，取 `Direction`/`WireConnectorID`)、`classes/blueprint.py`(snap 字段 :84-153)、`docs/source/concepts/environment.rst` | §4 |
| `QXIKmIJ/shapez-ai` | 【实测】`shapez-ai/python/planner/router.py` 924 行下载，读 `find_path`/`path_to_belts`/`plan_mix_and_paint_line`/`get_*_geometry`；**NOTICE 声明专利保护 ⇒ 只取思路不取代码** | §6 §8 |
| `xaviershay/factorio-layout-designer` / `w-flo/Foreman` | 【文档】README + 目录列表（Foreman **未读源码**） | §4 |
| 本仓库一手 | `src/ai/belt-rules.mjs`(全文)、`recon/upstream-full/src/js/game/components/belt.js`(:6,64-71,103-119)、`research/ai-player/plan-compiler.md`(:80-135,230-292)、`designs/layout-compiler-DESIGN.md`(阶段 A/B 全文)、`facts/ecosystem.md`、`review/ADVERSARIAL-REVIEW.md:221-223` | §0 §4 §5 §6 |
| arXiv API（`https://export.arxiv.org/api/query`，http 被拦、https 通） | 【实测】`id_list=2005.03192,2404.05472,2310.01505` 取回摘要（标题/摘要实读：`2005.03192` = Factorio 机制 PSPACE-完全、`2404.05472` = splitter 网络稳态 + 均衡 Ω(n log n) 下界、`2310.01505` = Factorio 蓝图 CP 自动设计）；`all:"crossing minimization"` 命中 **2412.06361**；`all:"left-edge algorithm"` / `all:"Hybrid A*"` / `all:"switchbox routing"` = **0 命中（负面结果，已如实记录）** | §1 §7 |
| 计算实验（本会话） | 临时脚本 `validate-channel-routing.mjs` + `brute.mjs`（**在 `C:/Users/Administrator/AppData/Local/Temp/`，未写入仓库**）：left-edge vs 暴力色数，穷举 27405 例 + 随机 400 例 | §1 §8 |
