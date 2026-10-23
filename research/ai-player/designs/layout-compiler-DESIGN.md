# 设计：布局编译器（配方 DAG → 空间布局 → 蓝图）

> 这是路线图里"如果只能做一件事"的那件事。本文给出**可实现的算法**，不是思路。
> 依据：`facts/ops-semantics-VERIFIED.md`（机器几何，已核证）、`facts/human-strategies.md`（官方策略）、
> `facts/ecosystem.md`（生态先例：MIP-Router / verilog2factorio / verifactory）。

## 问题陈述

给定：
- 一个**配方 DAG**（来自求解器）：叶子 = 矿机（在资源格上），内部节点 = cutter/rotater/stacker/painter/mixer
- 一个**建址**（或"选一个址"的任务）
- 机器的**硬几何约束**（已核证，见下表）

求：一组 `place` / `place_path` 动作（或一个可直接 `paste_blueprint` 的 SZBP1 字符串），使得
**物流连通、不交叉、不堵塞、能运转**。

## 硬约束（来自已核证的事实，这是编译器的"语法"）

| 机器 | 占地 | 输入边 | 输出边 | 速率 |
|---|---|---|---|---|
| miner | 1×1 | 资源格 | top | 0.4/s |
| belt | 1×1 | 任意 | 自身朝向 | 2/s |
| cutter | 2×1 | bottom×1 | top×2（左格=左列、右格=右列） | 0.5/s |
| rotater | 1×1 | bottom | top | 2/s |
| stacker | 2×1 | bottom×2 | top×1 | **0.25/s** |
| painter | 2×1 | shape←left / color←top | right | 0.33/s |
| mixer | 2×1 | color←bottom×2 | top | 0.4/s |
| hub | 4×4 | 四边共 16 格 | — | — |

**由此导出的三条布局铁律**：
1. **"下进上出"类机器**（cutter/stacker/rotater/mixer）天然沿 **+y 方向**流动；
   **painter 是"左进右出"**，沿 **+x 方向**流动。→ **两类机器不能简单串在一条线上。**
2. **stacker 是瓶颈**（0.25/s = 带的 1/8）→ **每条满带需要 8 台 stacker**。
3. **painter 需要一条独立的垂直颜料通道**（颜料从 top 进）。

## 推荐算法：三阶段（每阶段都是确定性的、可单独验证）

### 阶段 A：**行式布局（row-based layout）** —— 主结构

**观察**：shapez 的机器绝大多数是"下进上出"，且 hub 四边都能进料。
所以最自然的布局是**多条竖直的"产线行"，底部接一个水平收集带，收集带送进 hub 的某一边**。

```
        y 减小 ↑
  [矿机]        [矿机]        [矿机]         ← 每个资源簇一台
    ↓            ↓            ↓
  [cutter]     [rotater]    [painter]←[颜料线]
    ↓            ↓            ↓
  [stacker]    ...          ...
    ↓            ↓            ↓
 ══════════════════════════════════════    ← 水平收集带（朝左或朝右）
                    ↓
                 [ HUB ]                    ← 4×4，从顶排 4 格进料
```

**算法**（伪码）：
```
rowLayout(dag, site):
  1. 拓扑排序 DAG → 得到节点的"层级"（层级 = 最长路径深度）
     —— 同层节点可以并排（互相独立）
  2. 为每个叶子（矿机）分配资源格：用 world.mjs 找 site 附近的资源，
     贪心匹配（每个矿机一个资源格，最小化到 site 的距离和）
  3. 为每层分配一条"水平轨道"（row），y 递减；层级 i 的机器放在 y = y0 - i*rowHeight
     rowHeight 由该层机器中最高者决定（stacker/cutter/painter 占 1 行，但需要上下留带）
  4. 每个节点在其行内分配 x 位置：按 DAG 的父子关系，让子节点尽量在父节点正下方
     —— 用"重心法"（barycenter）排序减少交叉，这是图绘制的经典做法
  5. 竖直连接：父 → 子之间用 place_path 竖直铺带（注意方向：从父的 top 出发）
  6. 颜料支线：painter 的 color 输入从 top 进 —— 需要一个"颜料分配轨"在 painter 上方
     （可以用 tunnel 穿过上面的行）
  7. 行末汇入收集带 → 收集带 → hub 最近的一边
```

**为什么这样可行**：它把 2D 布线问题**降维成 1D 排序问题**（每层只排 x 顺序），
这正好落在"确定性算法能做好"的范围内。

### 阶段 B：**冲突消解（crossing resolution）**

当两个节点需要的竖直通道冲突（同一 x 被占用）时，按优先级处理：

| 手段 | 何时用 | 代价 |
|---|---|---|
| **水平错位** | 同层节点挤在一起 | 免费（只是 x 偏移） |
| **隧道（tunnel）** | 一条带需要跨过另一条带 | 需 level 4 解锁；占 1 格 + 出口 1 格 |
| **多层绕行**（把某条通道挪到远处再回来） | 无法错位时 | 带长增加，延迟增加 |
| **balancer 分流** | 两条线汇入 | 需 level 3 解锁 |

**实现建议**：先用最简版——**只做水平错位，遇到冲突就加宽行距**（用现成空间，shapez 地图无限大，
官方 tips 第 46 条明说"别挤，扩展"）。**隧道/立体绕行是 v2 的事。**

### 阶段 C：**验证（三级，全确定性）**

```
Level 1 形状验证：对每个节点算 hash(输出) == hash(期望)   ← 免费，纯离线
Level 2 几何验证：所有机器占地不重叠、每条带的两端都有合法邻居（用 slot 表检查）
Level 3 实机验证：paste_blueprint → await hub_delivered_increased(timeout) → 看 delivered 是否增加
```

**Level 3 是最终真值**，且成本很低（一次粘贴 + 一次 await）。
**Level 1/2 用来在实机之前过滤掉大部分错误**，节省往返。

## 关键接口（可直接实现）

```js
// src/ai/layout.mjs
export function compileLayout(dag, opts) {
  // opts: { site: [x,y], resources: [[x,y,shape]...], useTunnel: bool, seed: int }
  // 返回: {
  //   ok: true,
  //   blueprint: "SZBP1....",            // 可直接 paste_blueprint
  //   origin: [x, y],                    // 蓝图锚点 = 建议的粘贴点
  //   stats: { machines: {...}, beltTiles: n, bbox: [w,h], estThroughput: r },
  //   warnings: [...],                   // 如"颜料线路较长，建议就近选资源"
  // }
  // 失败时: { ok:false, reason, failingNode, hint }  ← 结构化，供 LLM 修复
}
```

**为什么输出蓝图而不是动作列表**：实测（`facts/offline-map-EXPERIMENTS.md` H6）
**蓝图可在任意位置（含未生成区域）一次性粘贴 49 个实体**——这是最高效的落地方式。
动作列表只在"微调"时才用。

## 吞吐计算（编译器必须内建，用于选型）

```
throughput(node):
  miner   = 0.4 × minerMult
  cutter  = 0.5 × procMult          (但受输入限制：min(输入速率, 0.5×procMult))
  rotater = 2.0 × procMult
  stacker = 0.25 × procMult
  painter = 0.33 × paintMult        (需颜料速率 ≥ 该值)
  mixer   = 0.4 × paintMult
  belt    = 2.0 × beltMult

整个 DAG 的吞吐 = min(沿途所有节点)   ← 瓶颈决定
```

**编译器的第一个决策**：若 `目标要求的吞吐` > `某节点能力`，则**复制该节点**（并行走多条）。
官方 tips 第 7 条"所有设施等级一致则比例不变"是这条的直接依据。

## 里程碑（每个独立可验证）

1. **M1：单切割线**。目标 `----CuCu`：2 矿机 + 1 cutter + 3 带 + hub 连接。
   验收：实机 paste → await 到 delivered 增加。
2. **M2：带上色与堆叠**。目标 `CgScScCg`（7 步链）。
   验收：同上，且 `hub.stored_shapes["CgScScCg"]` 增加。
3. **M3：多行 + 收集带**。目标是一个需要 ≥4 台机器的形状，布局必须用两条行。
   验收：同上 + 无几何冲突（Level 2 验证通过）。
4. **M4：颜料支线**。painter 的 color 输入从 top 进 —— 验证颜料真的送达。
   验收：`await` 到交付（若颜料断了会 timeout）。

## 风险与诚实说明

| 风险 | 说明 | 缓解 |
|---|---|---|
| **交叉消解做得不够好** | M1–M3 用"加宽行距"能过；复杂 DAG 可能需要隧道，而隧道**未验证过**（见 `04-ai-planning-research.md` 与本次未测） | 先做无隧道版，把"需要隧道"作为失败信号上报（L3 处理） |
| **多层形状（`: ` 分隔）** | `stack` 支持多层，但**未与公开表交叉验证**，且多层布局的立体物流更复杂 | M1–M4 先只做单层；多层单独立项 |
| **最优性** | 本方案不追求最优（追求"能跑通且不浪费"） | 若要优化，见生态先例（CP-SAT / 退火），但那要引入依赖 |
| **未生成区域的复杂机器** | H6 证明了能建，但没证明**cutter/painter 在未生成区域能正常工作** | M1 就在未生成区域做，顺便验证这一点 |
| **传送带方向易错** | 开发期踩过（拐角、cutter 输出必须朝上） | 编译器的 Level 2 几何验证必须检查每条带的方向是否与它连接的槽位匹配 |

## 与生态先例的关系（可借鉴，不必重造）

| 先例 | 借鉴什么 |
|---|---|
| `jiahao-0204/Shapez2-MIP-Router` | 把路由建成 MILP——**建模思路**（我们的行式布局是它的启发式近似） |
| `Redcrafter/verilog2factorio` | **"逻辑网表 → 空间布局"的完整管线**（含退火布局生成器）——与我们同构，最值得细读 |
| `alegnani/verifactory` | **用 SAT 证明蓝图性质**（不模拟）——我们的 Level 2 验证器可升级为此 |
| `Songxwn/shapez-auto` | 它的 `layout.go`/`geom.go` 做了简化版布局（每关重建）——**看它怎么处理几何，但不要学"清空重建"** |
