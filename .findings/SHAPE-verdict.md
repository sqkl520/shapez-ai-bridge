# 死锁链修通后的产出形状

数据来源：2026-11-21 真机只读观测（`obs` region [-120..120] + `debug_items` 全图），
game_version 1.5.6，tick 958116，`paused=false`，`goal.level=12`、
`requirement.shape=CbCbCbRb:CwCwCwCw`，`delivered=0/1000`。
全程未发 `tx`/`act`/`step`/`load_save`/`place`/`delete`/`save`，未改 `src/`。
脚本在 `.tmp-shape/`。形状代数一律调用 `research/ai-player/proto/shape-ops.mjs`（游戏源码的离线复刻），不手推。

---

## 一句话结论

修通后产出的是 **`CbScScCb`**（一层，圆-蓝+星-青混排），目标要的是 **`CbCbCbRb:CwCwCwCw`**（两层，下层 3 圆-蓝 + 1 方-蓝，上层 4 圆-白），**不一致**。

而且更糟的一条：**这条链根本就是上一关（L11 `CgScScCg`）的遗留产线**，只是 painter 的颜色断了。
接上**绿色**它立刻就会吐出 `CgScScCg` —— hub 里正躺着 **2071 件** `CgScScCg`，可以把这一条当作实机证据：
这条链的"正确"颜色是 green，不是目标要的任何一个色。接蓝色只会得到 `CbScScCb`（同样是废品）。

---

## 1. stacker 两路的实际来料

### 1.1 机器槽位（`slotsOf` 实测，非推断）

```
stacker#14684@(-2,5) r=0  footprint 2×1
  inputs  lower  slot=(-2,5)  approach cell=(-2,6)   ← 下游带上来的
  inputs  upper  slot=(-1,5)  approach cell=(-1,6)
  outputs out    slot=(-2,5)  dir=top  cell=(-2,4)
```

### 1.2 lower 路 `(-2,6)`：16 格竖列 → painter#13552

逐跳（`topology.sourceEntityOf` + 机器槽位本体回退）：

```
belt#14992 (-2,6) → 14991 (-2,7) → 14990 (-2,8) → 14989 (-2,9)
 → 14988 (-2,10) → 14987 (-2,11) → 14986 (-2,12) → 14985 (-2,13)
 → 14984 (-2,14) → 14983 (-2,15) → 14982 (-2,16)
 → 14981 (-2,17) r=90 rv=1 → 14980 (-3,17) → 14979 (-4,17)
 → 14978 (-5,17) r=180 rv=1 → 14977 (-5,16) r=180
 → 进入 painter#13552@(-5,14) 的输出槽 (-5,15)/dir=bottom
```

整条这一列就是 `debug_items.paths[14]`：`cells=16`，`first=(-5,16)`、`last=(-2,6)`，
`boundAcceptor="yes"`（=stacker 的 lower 槽），`itemsOnPath=0`、`spacingToFirstItem=15.56 = totalLength`
⇒ **这条路径是空的**，因为源头 painter 不吐货。

painter#13552 的输入：

| 槽 | 本体格 | approach cell | 实际上面有什么 |
|---|---|---|---|
| shape | (-5,14) | (-5,13) | `belt#14838`，运 **`----CuCu`** |
| color | (-5,15) | (-4,15) | **空地**（无带子、无机器） |

`paths[5]` 实测：`cells=[(-5,10),(-5,11),(-5,12),(-5,13)]`、7 件货、**全部是 `----CuCu`**。
再往上游是 `belt#14835 (-5,10)` → `cutter#13544@(-5,9)` 的 **slot 0（left/下半）**。

cutter#13544 的两个出口（`debug_items.ejectors`）**都堵着、progress=1**：

```
ejector (-5,9) slot0 = ----CuCu   progress=1   ← 通往 painter 这一路
ejector (-5,9) slot1 = CuCu----   progress=1   ← 另一路，(-6,10) 起无任何带子，是死的
```

cutter 的来料是 `CuCuCuCu`（`paths[4]`：mixer#16742 出 → 13 格 → cutter#13544 primary），
`CuCuCuCu` 由 `miner#17644@(-10,9) r=270` 挖铜矿产出；那台矿机的输出格 `(-11,9)` 是**空地**，
所以矿石现在也没进来（`miner#17644` 的 ejector 里还压着一个 `CuCuCuCu`）。

**lower 路的真实成分 = painter 的输出。painter 现在不工作（color 槽空），所以 lower 路 = 空。**

### 1.3 upper 路 `(-1,6)`：长长的 path8 尾部

`belt#14805 (-1,6)` 是 `rotation_variant=2` 的右弯（`code=3`），属于 `debug_items.paths[8]`。

`paths[8]` 实测：`cells=165`、`itemsOnPath=259`、`boundAcceptor="yes"`（=stacker upper 槽），
按 `pos` 排序后只有两段：

| 段 | 件数 | 起点 → 终点（沿 pos 增大的方向） | pos 区间 |
|---|---|---|---|
| `blue`（**纯颜料 item**，不是形状） | 120 | (39,-12) → (81,0) | 0.48 … 75.45 |
| `ScSc----` | 139 | (81,1) → (-1,6) | 76.08 … 163.02 |

**这条 path 是满的**：最后一件 `ScSc----` 的 `pos=163.02`，等于我按带子长度逐格累加出的
`totalLength=163.02`（直线 1.0、弯带 0.78，`cells` 顺序与每格 rv/exit 逐格对拍 164/164 一致）。
换算成到接受端的距离 = **0.000**，而 `boundAcceptor` 绑的是 stacker 的 upper 槽。
⇒ 最前端那件 `ScSc----` 正顶在 stacker 门口，因为 stacker 缺 lower 路（`inputsPerCharge:2`）
而**永远吃不下**。这是一条物理上卡死的队列。

`blue` 那 120 件不是形状、是**颜料 item**（`ColorItem.getAsCopyableKey() = color`），
在 (81,1) 之后被 `ScSc----` 顶在后面 —— 它们永远到不了任何 mixer。

`ScSc----` 的来源：`miner#15044 / #15046 / #15113` 从 `(7,5)/(6,5)/(5,5)` 的 **red 矿**挖矿产出
（`miner#12445@(8,5) r=0` 是 chainable 的头，但它通向 `paths[15]` 的另一条红色线）；
再往前（pos 较小那侧）是 `miner#16204@(38,-12)` 的 **blue 矿**产出的 `blue` 颜料，
在 (81,1) 处被切到 path8 的头部 ——**两条完全不同的流在 (81,-1)…(81,1) 汇进同一条 path**。

### 1.4 关键排错（我第一遍读错过，写下来免得重犯）

`debug_items.belts[].pos` **不是"已走的距离"**，而是源码 `BeltPath.items[i][0]` 的
**`nextDistance`（到后一件物品的距离）**。所以 `paths[].cells[0]` 是**接受端**（下游/前端），
`cells[last]` 是**上游末端**；`pos` 越大的物品越**靠近接受端**。

- `paths[8].cells[0] = (39,-12)` = `miner#16204` 的出口格 ⇒ (39,-12) 是**前端**，不是源头。
- `paths[8].cells[164] = (-1,6)` = stacker upper 槽 ⇒ 这就是接受端。
- 该 path 的 `spacingToFirstItem = 0.48`（最前端物品离接受端 0.48 格），
  但 `pos=163.02` 那一件已在终点 ⇒ 队列里**最靠外的那个**才是"距接受端"基准，
  解包时不能拿 `idx=0` 当"源头"。我按 `pos` 排序后重算才得到正确结论。

证据链（源码）：`recon/upstream-full/src/js/game/belt_path.js:466-489` 的
`debug_checkIntegrity`：`currentPos = spacingToFirstItem; for each item currentPos += item[0]`，
最后要求 `currentPos == totalLength`。即 `item[0]` 是"间距"，累加到最后一件恰好等于整条 path 长度。
`mod` 侧 `debugItems()` 直接把 `[spacing, item]` 二元组写成 `{pos, item}`，字段名 `pos` 有歧义。

---

## 2. 推演结果

### 2.1 现状（painter 不工作）

- painter#13552 的 color 槽空 ⇒ `inputsPerCharge:2` 永远不满足 ⇒ **不出货**。
- ⇒ `paths[14]` 全空 ⇒ stacker lower 路无料。
- ⇒ `paths[8]` 最前面那件 `ScSc----` 顶在 upper 槽前，距离 0.000，**进不去**。
- ⇒ `paths[6]`（stacker → rotater 的 1 格）`itemsOnPath=0`（实测）。
- ⇒ `rotater#14685` 空转；`paths[10]` → `belt#15000 (-2,2)` → hub `(-2,-2)` 底部入口，
  这一段物理通达（`accepts()` 逐跳通过），但**没有一件货**。

**现状产出 = 空**。与 `hub.stored_shapes['CbCbCbRb:CwCwCwCw'] = undefined`、`delivered=0` 吻合。

### 2.2 修通 painter（假设接蓝色颜料，这是最有利于目标的假设）

逐步代数（全部由 `shape-ops.mjs` 算出，不是手推）：

```
painter 的 shape 来料 (paths[5] 实货)      = ----CuCu
paint(----CuCu, blue)                     = ----CbCb        ← painter 输出
path8 最前端实货                            = ScSc----
stack(lower=----CbCb, upper=ScSc----)     = ScScCbCb
```

注意两边顺序已对：`slotsOf` 明确 `lower` 是 `(-2,5)`/`(-2,6)`、`upper` 是 `(-1,5)`/`(-1,6)`；
游戏 `_process_STACKER` 是 `shapeActionStack(items.get(0), items.get(1))` = `stack(lower, upper)`。
（`stack(ScSc----, ----CbCb)` 得同一结果 `ScScCbCb`，因为两片象限不重叠 —— 所以**顺序不影响结论**，
这一点我两头都验了，免得结论吊在一个不牢的假设上。）

再经 `rotater#14685`（`code=11` = **顺时针**变体；`code=12` 是 ccw、`13` 是 180°）：

| 修的颜料色 | painter 输出 | stacker 输出 | rotater(CW) 输出 |
|---|---|---|---|
| blue | `----CbCb` | `ScScCbCb` | **`CbScScCb`** |
| green | `----CgCg` | `ScScCgCg` | `CgScScCg` |
| red | `----CrCr` | `ScScCrCr` | `CrScScCr` |
| white | `----CwCw` | `ScScCwCw` | `CwScScCw` |
| cyan | `----CcCc` | `ScScCcCc` | `CcScScCc` |

**七种颜色 × 两种进料顺序，没有一种命中 `CbCbCbRb:CwCwCwCw`。**
即使把 rotater 换成 CCW 或 180°，也是 `ScCbCbSc` / `CbCbScSc`，同样不对。

### 2.3 这不是"修得不彻底"，是"修错了关"

`CgScScCg` **正是 L11 的目标形状**（`recon/upstream-full/src/js/game/modes/levels.js:242`）：

```
// 11  Chainable miner
{ shape: "CgScScCg", required: 1000, reward: reward_miner_chainable }
// 12  Blueprints
{ shape: "CbCbCbRb:CwCwCwCw", required: 1000, reward: reward_blueprints }
```

而 `hub.stored_shapes` 里 **`CgScScCg = 2071`**（> 1000，即上一关是达成的）。
⇒ **stacker#14684 + rotater#14685 + cutter#13544 + painter#13552 这一整套是 L11 的产线**，
矿物 red 是它的星-青原料路径，绿色颜料是它缺的那一瓶。
上一关通关后进了 L12，目标换了，这条线没被拆，painter 断色（或者说中途某个 agent 想把它改成
蓝色而把颜色供料拆了）就冻在那里。

这也解释了 `hub.stored_shapes['ScScScSc']=1680` —— L11 的原料库存。

---

## 3. 与目标比对

| 项 | 目标 `CbCbCbRb:CwCwCwCw` | 修通后（接蓝）`CbScScCb` | 差 |
|---|---|---|---|
| 层数 | 2 | 1 | **缺整个第 2 层** |
| 下层 4 象限 | Cb Cb Cb Rb（3 圆蓝 + 1 方蓝） | Cb Sc Sc Cb（2 圆蓝 + 2 星青） | 缺 1 个 Cb、缺 Rb、多 2 个 Sc |
| 上层 | Cw Cw Cw Cw（4 圆白） | 无 | 缺 4 个 Cw |
| 形状种类 | 只用 circle / rect | 含 **star**（星形） | stacker 只要有一路带 star，结果就废 |
| 颜色 | 蓝、白 | 蓝、**青** | 缺白；青色是 L11 的，不是 L12 的 |

一句话：**缺"方-蓝"、缺"圆-白"、多"星-青"，且完全没有二层。**
根因不是这台 stacker 少接一路色，而是**另一路进料（`ScSc----`，星形半片）本身就是错的原料**，
上游没有一处能把星形变成方形或白色。

另外两条结构性硬约束（也都实测）：

1. **hub 的 16 个入口全部 `filter:"shape"`**（`recon/bundle.pretty.js` MetaHubBuilding，4×4 = 16 个
   acceptor、filter 全是 `"shape"`）。所以那 120 件 `blue` **颜料**即使流到 hub 门口也进不去。
   ⇒ "blue 颜料是唯一相关材料"这句话只在"能调头去 mixer"时才成立；它现在被 `ScSc----` 顶住，永远调不了头。
2. **这条链只有 1 台 stacker**（全图 `stats.by_type.stacker = 1`），速率 0.25/s；
   `rotater` 2/s、`painter` 0.333/s、`cutter` 0.5/s。即使形状对了，这条单线也顶不到 1000 件。

---

## 4. 要产出目标还需要什么

### 4.1 结论：这条链**方向就是错的**，修通它 = 把 L11 的老线修回去，与 L12 无关

不建议投入任何动作去"给 painter#13552 接色"。正确做法是**另起一条 L12 专用线**，
并且（如果要做实验）先明确写下来"这条老线只作对照，不作为 L12 的修法"。

### 4.2 我已经用游戏代数跑通了完整配方（可作施工图）

所有步骤均落在当前已解锁的机器上（cutter / rotater / stacker / painter / mixer 全有；
`upgrade_levels = {belt:1, miner:2, processors:0, painting:1}`，未解锁 quad cutter，
所以下面**只用半切 cutter**）：

```
① paint(CuCuCuCu, blue)        = CbCbCbCb       （铜矿 + 蓝颜料；蓝矿/蓝颜料现成）
② cutHalf(CbCbCbCb)            = [ ----CbCb , CbCb---- ]        // [0]=q2q3  [1]=q0q1
③ rotateCCW( ----CbCb )        = --CbCb--
   cutHalf( --CbCb-- )         = [ ----Cb-- , --Cb---- ]        // [0]=q2     [1]=q1
④ paint(RuRuRuRu, blue)        = RbRbRbRb       （Ru 矿：miner#16597@(2,-6)，现成）
   cutHalf( RbRbRbRb )         = [ ----RbRb , RbRb---- ]
   rotateCW( ----RbRb )        = Rb----Rb
   cutHalf( Rb----Rb )         = [ ------Rb , Rb------ ]        // [0]=q3     [1]=q0
⑤ stack( CbCb---- , ----Cb-- ) = CbCbCb--        // stacker #1，q0q1 + q2
⑥ stack( CbCbCb-- , ------Rb ) = CbCbCbRb        // stacker #2，+ q3   ← layer0 完成
⑦ paint(CuCuCuCu, white)       = CwCwCwCw        // white = red|green|blue
                                                 // 两台 mixer 串联：red|green=yellow, yellow|blue=white
⑧ stack( CbCbCbRb , CwCwCwCw ) = CbCbCbRb:CwCwCwCw
```

最后一步 `h(GOAL) === 'CbCbCbRb:CwCwCwCw'` **实测 true**（`.tmp-shape/recipe4.mjs`）。

连续两次 `stack` 能成一层，是因为 shapez 的 `cloneAndStackWith` 对"象限不相交"的两片会**合并到同一层**
（`layerToMergeAt` 由各象限最小间隙算出，最小间隙 ≤1 时原地合并）——
这一步我一开始以为是"叠成两层"，算错了；用 `stack(CbCbCb--, ------Rb) = CbCbCbRb`（单层）实测纠正。

### 4.3 机器与产能清单（目标 1000 件）

| 用途 | 数量 | 现有 | 备注 |
|---|---|---|---|
| cutter（半切） | 4 | 3 | 每一步 `cutHalf` 一台；可串行复用 |
| rotater（CW / CCW） | 2 | 1 | ③ 要 CCW，④ 要 CW；现有 #14685 是 CW |
| stacker | 3 | **1** | ⑤⑥ 两次叠层 + ⑧ 盖顶；**瓶颈**：0.25/s |
| painter | 2 | 2 | 一个喷蓝、一个喷白；现有 #13552 是 `default` 可用 |
| mixer | 2 | 4 | red|green→yellow，yellow|blue→white，**串联**（现有 4 台里 17294/17319/17340 在东侧，未验证接线） |

产能口径：`stacker` 0.25/s 是全局下限（3 台并联 → 0.75/s 仍不到 belt 的 2/s，
但比"单台 0.25/s 要 67 分钟"好）；要 1000 件至少需要 **≥4 台 stacker 并联**或等 processors 升级
（当前 `processors:0`，没有升级过）。

### 4.4 顺便记下的、会误导后续决策的三件事

1. **`path8` 的 `blue` 颜料是"死库存"**：120 件纯颜料 item 卡在 `ScSc----` 后面，物理上动不了。
   任何"全图有 210 件 blue 颜料 ⇒ 材料够"的推理都高估了可用量。真正能用于喷漆的蓝色颜料只有
   ejector 上那 7 件 + mixer 可能产出的量。
2. **两台 painter 的 color 槽（`(-4,15)` 与 `(88,-15)`）都是空地**，是同一类故障（建了 painter 没接色）。
   东侧 painter#14687 / cutter#13369 三个出口（`(89,-16)`、`(84,-15)`、`(83,-15)`）也全是空地 ——
   那半边是完全未接线的空壳（`path7`=12 格、`path11`=2 格，都 0 件货）。
3. **`miners` 里 8 台输出格是空地**（含挖 `RuRuRuRu` 的 `#16597@(2,-6)`、挖 green 的 `#17120/#17122`、
   挖铜的 `#17644@(-10,9)`）。做 4.2 的配方时，`RuRuRuRu` 与 `CuCuCuCu` 的矿机**必须先接出来**，
   否则配方第一步就没有原料。
