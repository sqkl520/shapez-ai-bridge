# 方向 A：belts_reaching_hub 审计

采集时间：2026-11-21 05:36–06:05（本地）。存档 7c93b3dd（seed 60908，L12，hub_level 12）。
全程只读：`obs` / `debug_items` / `production` / `world_info` / `status` / `debug_loop` / `debug_log` / `health`。
脚本在 `.tmp-a/`（`obs.json` / `items.json` / `items2..4.json` 为 4 次采样快照）。

## 结论（一句话）

`belts_reaching_hub = 390` 是**只验下游几何、不验上游供给、也不验中间机器能不能跑**的「下行可达」数，
而当前世界里 **真正能把一块形状送进 hub 的带子数是 0**：所有载货带子的终点都是某台停摆的机器
（stacker 88 / cutter 7 / painter 4），191 条下行直达 hub 的带子里 **一条货都没有**，且其中 189 条向上追溯
断在 3 个带子朝向断口上；真正的死锁点是 `painter#13552` 的 color 入口 `(-4,15)` 是空的 —— 它不喷漆 →
stacker 永远只有 1 路料 → stacker 不吐 → 上游 259 件货塞满 165 格带子全部冻结。

---

## 1. 计算口径

### 1.1 `belts_reaching_hub` 实际由谁算

`src/agent/loop/health.mjs:101-112`：

```js
const idx = indexOf(o);
const set = flowReachable(o, idx);      // ← 注意：没有传 itemsDoc
const beached = belts.filter(b => !set.has(b.uid));
reachBelts = belts.length - beached.length;   // → belts_reaching_hub
```

即 `belts_reaching_hub = 699 - 309 = 390`（`reach_pct` = 0.558，就是问题里那个 56%）。
`belts_deliverable`（`health.mjs:132` 的「类型口径」）在同一份数据上也算出 **390，完全相同的集合** —— 见 §2.4。

### 1.2 `flowReachable` 的算法（`src/agent/loop/topology.mjs:546-656`）

正向建边 + 从 hub 反向闭包：

1. 对**每个实体**取「出货出口」（`flowOutlets`，`topology.mjs:503`）：
   带子 → `exitCellOf/exitDirOf`；隧道 sender → 配对 receiver 的出口；机器 → `slotsOf().outputs` 的 `cell`。
2. 落点实体 `dst = at(ix, o.cell)`，**每一跳都 `accepts(ix, o.cell, o.dir)`**（`topology.mjs:568`）：
   几何相邻但入口朝向对不上 → 这条边不存在。
3. 建 `feeds: 下游uid → Set(上游uid)`，从 `hub.uid` 做一次 BFS（`topology.mjs:573-581`）。

所以它**确实看入口朝向**（不是「几何相邻就算通」），但它的语义是：

> 「**假设这条带子上有货，货顺着下游一路推，能不能推进 hub 的某个输入槽**」

### 1.3 它不看什么（这是 390 虚高的全部来源）

| 维度 | 看不看 | 证据 / 后果 |
|---|---|---|
| 这条带子现在有没有货 | ❌ | 390 里 **214 条是空带子** |
| 这条带子往上游有没有源头（矿机/机器有没有接上） | ❌ | 390 里 **189 条向上追溯断在带子朝向错口**，13 条断在空格 |
| 中间机器**能不能真的运转**（缺料/缺色/出口堵） | ❌ | 390 里 199 条要穿过机器；那 199 条全部卡在停摆的机器前 |
| 货的类型 vs hub 的 `filter:"shape"` | ⚠️ 只在传 `itemsDoc` 时 | `health.mjs:112` 没传；`prompt.mjs:1772` 也没传 |
| 机器出口被下游堵死（backpressure） | ❌ | stacker 出口是空的、上游却全满 —— 拓扑完全「通」，物流完全「死」 |

**一句话对照**：`flowReachable` 算的是「下行通路」，而 hub 交付需要的是「上行有料 × 下行通路 × 中间机器在跑 × 货是形状」四项同时成立。390 只测了第 2 项。

### 1.4 与 `hubReachable()` 的区别（`topology.mjs:660-697`）

| | `hubReachable` | `flowReachable` |
|---|---|---|
| 方向 | 从 hub 的**输入槽**反向沿带子 `entry` 爬 | 正向建边 + 从 hub 反向闭包 |
| 验 `accepts` | ❌ 不验（只看带子的 `beltEntry`） | ✅ 每一跳都验 |
| 穿机器 | ❌ 遇到机器就停，但会把机器 uid 收进集合 | ✅ 从机器输出槽继续 |
| 隧道 | 当死端 | sender 跳 receiver |
| 用途 | 诊断 tier 过滤（「能影响 goal 的实体」） | prompt 的 `[not reaching hub]` 标记、`belts_reaching_hub` |
| 实测值 | **532 条带子**（+ 1 hub + 3 trash + 2 mixer + 2 miner + 1 stacker + 1 rotater） | **390 条带子**（+ 1 hub + 1 miner + 1 cutter + 1 painter + 1 stacker + 1 rotater） |

差出来的 159 条正是「`hubReachable` 靠不验朝向多收的」：例如 `(2,1)` 那条红线上的 `15004@(3,1)`，
`hubReachable` 认为它通 hub，`flowReachable` 正确地把它排除了。
两个数**都**远高于真实可交付数 0，但 `flowReachable` 已经是这两者里更严的那个。

### 1.5 一个必须澄清的前提修正

问题描述里说「货确实在流动（不同时刻 pos 在变，已排除堵着不动）」。**这个观察只对 2 条带子链成立，而且那 2 条是往垃圾站丢的废料线。**

4 次 `debug_items` 采样（05:37 / 05:50 / 05:54 ×2），按 `path#idx` 对齐：

| path | 货数 | 格数 | 4 次采样间 pos 多重集 | 判读 |
|---|---|---|---|---|
| 0 | 4（green） | 10 | **在变**（2.079→0.551） | 在流 → 终点 trash#17306 |
| 15 | 4（red） | 9 | **在变**（0.315→1.150） | 在流 → 终点 trash#17584 |
| 4 | 12（CuCuCuCu） | 13 | 完全冻结 | 堵 |
| 5 | 7（----CuCu） | 4 | 完全冻结 | 堵 |
| 8 | **259**（blue 120 + ScSc---- 139） | 165 | 完全冻结 | **满载堵塞（1.57 件/格）** |
| 19 | 3（blue） | 2 | 完全冻结 | 堵 |
| 20 | 87（blue） | 55 | 完全冻结 | **满载堵塞（1.58 件/格）** |

另做一次 45 秒静置探针（tick 前进 45.04）：**376 件货里只有 8 件 pos 变化，0 件换格**。
`status.tick` 与真实时间 1:1 前进（60 s → Δtick 60），所以**不是时钟停摆，是世界真的堵住了**。
20 个 ejector 里 19 个 `progress = 1.0`（出料口全满、推不出去）。

→ 「货在动」这句话应该改成：**8/376 件在动，且都在往垃圾站丢的线上；其余 368 件全部冻结。**

---

## 2. 真实可交付条数

### 2.1 结论

**390 条里，真正能交付形状到 hub 的约 0 条。**

不是「远小于 390」，是 0。三条独立的、口径不同的计算都指向 0：

**(a) 按「本带下游严格到 hub」分桶（191 / 199）**

| 下游终点 | 条数 | 载货条数 |
|---|---|---|
| 直达 hub 且 `accepts` 通过 | **191** | **0** |
| 需穿机器：stacker#14684 | 181 | 165 |
| 需穿机器：cutter#13544 | 13 | 7 |
| 需穿机器：painter#13552 | 4 | 4 |
| 需穿机器：rotater#14685 | 1 | 0 |
| 合计 | 390 | 176 |

191 条「已经通到 hub」的带子 **一条货都没有**。载货的 176 条全部停在机器前，而那几台机器当前都没在吐货。

**(b) 载货带子的终点（241 条载货带子，全部 699 条里）**

| 终点 | 带子数 | 货 | 备注 |
|---|---|---|---|
| trash#17306 | 4 | green×4 | 废料，正常消耗 |
| trash#17584 | 4 | red×4 | 废料，正常消耗 |
| stacker#14684 | 165 | blue×77 / ScSc----×88 | **停摆（只有 1 路进料，见 §4）** |
| cutter#13544 | 9 | blue×2, CuCuCuCu×7 | 停摆（下游 painter 缺色） |
| painter#13552 | 4 | ----CuCu×4 | 停摆（color 入口空） |
| empty（跑出世界） | 55 | blue×55 | 断头，`boundAcceptor: null` |
| **能进 hub 的** | **0** | **0** | |

`path 20`（55 条带子、87 件蓝货）的 `boundAcceptor` 是 `null` —— 整条 55 格的带子末端悬空在 `(37,-40)`。

**(c) 按「载着形状 + 下行通 hub」交叉**

- 390 条里：空带子 214、载颜料 77、载形状 99。
- 那 99 条的终点：stacker 88（ScSc----）、cutter 7（CuCuCuCu）、painter 4（----CuCu）—— **没有一条直接到 hub**。
- 全集 699 条带子里，「下行一路 `accepts` 通到 hub」的也是 191 条，其中载货 0 条。

### 2.2 再叠一层「上游是不是接好了」

用与 `upstreamFed` 同判据（带子出口必须落在本带 origin 且 `accepts` 通过；机器必须有一个输出槽的
`cell` 正好是本带 origin；落在「槽位本体格」时扫四邻机器）逐跳回溯 390 条：

| 最终供方 | 条数 |
|---|---|
| miner | 165 |
| **断口（带子出口方向与本带入口不符）** | **189** |
| 无源（走到空格） | 13 |
| painter | 16 |
| cutter | 4 |
| stacker / rotater / trash | 各 1 |

**下行通 hub 且上游链完整接通**的只有 **1 条：`belt#15000@(-2,2)`**，供方是 `rotater#14685 ← stacker#14684`。
而它现在是空的 —— 因为 stacker 不吐货（§4）。

### 2.3 189 条断口集中在 3 处（不是「大面积接错」）

681 处带子→带子交接里，666 处正确、**15 处错**，其中致命的 3 处吞掉了全部 189 条：

| 断口 | 上游带（出口） | 下游带（入口） | 受影响条数 |
|---|---|---|---|
| A | `belt#17586@(29,-50)` r90/rv0，`exit=right → (30,-50)` | `belt#17258@(28,-50)` r270/rv0，`entry=right`（应来自 (29,-50)） | **81** |
| B | `belt#16477@(81,-2)` r180/rv0，`exit=bottom → (81,-1)` | `belt#16451@(80,-2)` r270/rv0，`entry=right`（应来自 (81,-2)） | **79** |
| C | `belt#16401@(30,-2)` r270/rv0，`exit=left → (29,-2)` | `belt#16162@(30,-1)` r180/rv2，`entry=top`（应来自 (30,-2)） | **29** |

三处都是「上游带子出口朝一边，下游带子从另一边收」的 T 形交接。
A 那条（81 条）是沿 hub 西侧 `x=-3` 从 `y=-1` 一路铺到 `y=-50`、再沿 `y=-50` 向东到 `x=28` 的整条长链 ——
它**只是从 hub 旁边经过**，然后在最远端断掉；`flowReachable` 却因为它的下游端 `17024@(-3,-1)` 正对 hub
左入口 `(-2,-1)` 而把整条 81 格算成「到 hub」。
剩下 12 处错交接在 `(36,-21) / (-3,-22) / (43,-13) / (27,-50) / (33,-40) / (27,-42)×2 / (33,-43)×2 /
(36,-38) / (35,-39)` 等，都是短支线，不影响 hub 交付。

### 2.4 类型口径（`belts_deliverable`）这次是**空转**的

`topology.mjs:597-641` 的 PAINT 剪枝只在「**直接喂 hub 的带子、且该格 pos 最大的货是颜料**」时才把边剪掉。
当前 5 条直接喂 hub 的带子上**一件货都没有**（`byCell` 查不到行），所以 `badFeeders = 0`，
`flowReachable(obs, idx, {itemsDoc})` 与不传 `itemsDoc` 的结果 **逐 uid 完全相同**（396 = 396）。

→ `belts_deliverable` 与 `belts_reaching_hub` 在这份世界上是同一个人数（390），
它给人「类型问题已经排除」的错觉，实际上它只覆盖了「入口那 5 条带子」这一种形态。
真正该被类型口径扣掉的是「末端是颜料、且颜料根本到不了 mixer」的那 77 条，剪枝条件不覆盖。

---

## 3. 16 个入口状态表

`slotsOf('hub','default',-2,-2,0,0)` 给出 16 个 `{slot, dir, cell}`（hub.js:79-82 的 4×4 环）。
`slot` = 槽位本体格（hub 判定用的是这个），`cell` = 上游带子所在的 approach 格。
「能进 hub」= 门口带子的 `exitCell == slot` **且** `accepts(idx, slot, exitDir)` 通过。

| # | 入口格(本体/朝向) | 门口格 | 实体 | 朝向对 | 有货 | 货类型 | 能进 hub |
|---|---|---|---|---|---|---|---|
| 1 | (-2,-2) top | (-2,-3) | 空 | — | — | — | 否 |
| 2 | (-2,1) bottom | (-2,2) | belt#15000 r0/rv0 | 是 | 无 | — | **是** |
| 3 | (-2,-2) left | (-3,-2) | belt#17179 r180/rv0，出口 bottom→(-3,-1) | **否** | 无 | — | 否 |
| 4 | (1,-2) right | (2,-2) | belt#16373 r270/rv0 | 是 | 无 | — | **是** |
| 5 | (-1,-2) top | (-1,-3) | belt#16209 r270/rv1 | 是 | 无 | — | **是** |
| 6 | (-1,1) bottom | (-1,2) | 空 | — | — | — | 否 |
| 7 | (-2,-1) left | (-3,-1) | belt#17024 r180/rv1 | 是 | 无 | — | **是** |
| 8 | (1,-1) right | (2,-1) | belt#16133 r270/rv0 | 是 | 无 | — | **是** |
| 9 | (0,-2) top | (0,-3) | trash#17587 r0 | — | — | — | 否（垃圾站占住门口） |
| 10 | (0,1) bottom | (0,2) | 空 | — | — | — | 否 |
| 11 | (-2,0) left | (-3,0) | 空 | — | — | — | 否 |
| 12 | (1,0) right | (2,0) | 空 | — | — | — | 否 |
| 13 | (1,-2) top | (1,-3) | trash#17597 r0 | — | — | — | 否（垃圾站占住门口） |
| 14 | (1,1) bottom | (1,2) | 空 | — | — | — | 否 |
| 15 | (-2,1) left | (-3,1) | mixer#16742 r270 | — | — | — | 否（输出槽在 (-5,1)，不指向本槽） |
| 16 | (1,1) right | (2,1) | trash#17584 r0 | — | — | — | 否（垃圾站占住门口） |

汇总：**正确喂料 5 / 朝向不对 1 / 垃圾站占位 3 / 机器不指向 1 / 空 6**。

这 5 条「正确」的带子，向上追：

| 入口带 | 上游 | 现在有没有货 |
|---|---|---|
| #15000 (-2,2) | rotater#14685 ← stacker#14684 | 无（stacker 停摆） |
| #16209 (-1,-3) | **trash#17587@(0,-3)**（源头就是垃圾站，不可能有货） | 无 |
| #17024 (-3,-1) | 81 条长链 → 断口 A | 无 |
| #16373 (2,-2) | 79 条长链 → 断口 B | 无 |
| #16133 (2,-1) | 29 条长链 → 断口 C | 无 |

即：**5 条接线正确的入口带，0 条有货，其中 4 条的上游本身是死的。**
另有一条 `belt#17179@(-3,-2)` 躺在 hub 左入口的 approach 格上、看起来像接口，实际它的出口是 `bottom`
（往 `(-3,-1)` 走），它只是路过；真正接的是上面那格 `#17024`。

---

## 4. 根因判断

### 4.1 直接原因：唯一有产能的线在一台只有单路进料的 stacker 前面死锁

`stacker#14684@(-2,5)`（2×1，输入 `(-2,6)` 下路 / `(-1,6)` 上路，输出 `(-2,4)`）——
游戏源码 `recon/upstream-full/src/js/game/buildings/stacker.js:60` 是 `inputsPerCharge: 2`，
**两路各来一件才能合成一次**。

| 路 | approach | 带子 | 有货 |
|---|---|---|---|
| 下路 `(-2,6)` | belt#14992 | 来自 `(-2,7)..(-2,17)` 16 格竖列 ← `belt#14977@(-5,16)` ← **painter#13552.out** | **无** |
| 上路 `(-1,6)` | belt#14805 | 来自 `path 8`（165 格、259 件） | 有（ScSc---- 一直顶到 stacker 口） |

下路整条 16 格竖列全空，因为源头 `painter#13552@(-5,14)` 的 **color 槽 approach `(-4,15)` 是空格**：
`slotsOf('painter')` 给的是 `color: {slot:(-5,15), dir:"right", cell:(-4,15)}`，该格无实体、四个邻居也无带子。
painter 不喷漆 → 它的 `out (-5,16)` 不出货 → `belt#14977 → 14978..14981 → 14982..14992` 全空 → stacker 只有 1 件。

于是：stacker 攒不满 2 件 → 不处理 → 不吐货（`ejectors` 里根本没有 `(-2,5)` 这一行，说明它没在排空）
→ 输出 `(-2,4) → rotater#14685 → (-2,2) → hub` 这条**拓扑完美的通路永远空着**
→ 上游 259 件货把 165 格带子塞到 1.57 件/格（理论满 1/0.63 = 1.59），
`path 8` 的货头一直顶到 `(39,-12)`，把 `miner#16204` 的出料口也堵死（ejector progress=1.0）。

**这就是「几何 56% 通 hub / 实际交付 0」的完整链路：不是接错，是中间那台机器缺一路料，整条链一起冻住。**

### 4.2 第二条并行的死锁：painter 缺色 → cutter 也堵

同一条西侧产线：`cutter#13544@(-5,9)` 只接了 left 输出（`right` 输出格 `(-6,10)` 是**空地**），
切出来的 `----CuCu` 走 `(-5,10..13)` 进 painter 的 shape 槽 —— 但 painter 缺 color（4.1），
于是 `path 5`（7 件 ----CuCu）和 `path 4`（12 件 CuCuCuCu）双双冻结。
`cutter#13544` 的两格 ejector 也都 `progress=1.0`。

更上游：`miner#17644@(-10,9)`（挖 CuCuCuCu）的**输出格 `(-11,9)` 是空地** —— 这台矿机根本没接线，
它的 ejector 里躺着一件 `CuCuCuCu`、progress=1.0。所以这条线的铜料本来就已经断了。

### 4.3 这台世界里根本没有颜料生产线

- `mixer#16742@(-4,1)`：两个 color 输入是 `(-4,1)`(本体格) 和 `(-3,0)`，**approach `(-3,1)` 上就是它自己**、
  `(-3,0)` 是空地 → mixer 无进料；输出 `(-5,1) → belt#14827 → cutter#13544`（往北去了，不是去 painter）。
- 目标 `CbCbCbRb:CwCwCwCw` 需要 **cyan**（blue+green）和 **white**（blue+green+red），
  地图上没有 cyan/white 矿（`constants.mjs:139-140`），只能 mixer 合成。
- 当前带上/槽里出现过的货只有：`green / CuCuCuCu / ----CuCu / blue / ScSc---- / red / ----SuSu / SuSu---- / CuCu---- / RuRuRuRu`
  —— **一个 cyan、一个 white 都没有**，hub 存量里 `Cw*` 键也是空。
- 而三台红色矿机 `15044/15046/15113@(5..7,5)` 的输出**朝向是错的**：
  输出格 `(7,6)/(6,6)/(5,6)` 上的带子 `14797/14798/14799` 对 `accepts` 返回 **false**，
  所以 red 只能沿 `path 15` 一路漂到 `trash#17584@(2,1)` —— 而这格恰好是 **hub 右入口 (1,1) 的 approach 格**。
  也就是：红色颜料被送进了「hub 入口门口的一个垃圾站」，而它本可以用来合成 white。

### 4.4 三层口径缺陷（这才是「56%」这个数骗人的地方）

1. **`flowReachable` 只算下行通路**，不看这条带子有没有料、上游通不通、中间机器在不在跑。
   390 = 214 条空带子 + 176 条载货但全部卡在机器前。
2. **`flowReachable` 会沿着「路过 hub 的长链」把整条链算成可达**：81 条 `x=-3 / y=-50` 的长链只是
   从 hub 西侧经过并在最远端断掉，却被算成「到 hub」。这类结构让数字对「断头长链」特别不敏感。
3. **类型口径 `belts_deliverable` 覆盖不到真正的问题**：它只剪「直接喂 hub 且末端是颜料」的边，
   本世界里那 5 条直接喂料带是空的，所以 `badFeeders = 0`，它与 `belts_reaching_hub` 完全相同。
   而真正的类型问题是「颜料根本没进任何 painter/mixer」，不在它的判据范围内。

### 4.5 如果只改一个数，应该改成什么

不建议直接改 `belts_reaching_hub` 的既有语义（`health.mjs:127` 明确说有多处依赖）。
真正缺的是一个**「当前真的在交付路径上」**的度量，判据要同时满足：

- 本带下游严格 `accepts` 通到 hub（已有）；
- 上游逐跳 `accepts` 通到一个非 trash 的机器（新增，本轮 390 → 1）；
- 途经的机器**当前不在停摆**（出口格上有货 / ejector 没有 progress=1，或者上游两路都有料）。
  这一条在本世界上会把 181 条 stacker 队列全部判红，正是我们想要的。

按这套口径，这份世界现在能上交付路径的带子是 **1 条（#15000），且它空着**，真实可交付 = **0**。
这个数字才对得上 `delivered_total: {}` 与 hub 存量 20000 tick 零变化。

---

## 附：本次采集的原始计数（便于复核）

```
obs:       749 entities / 699 belt / 17 miner / 3 cutter / 2 painter / 1 stacker / 1 rotater / 4 mixer / 1 balancer / 20 trash / 1 hub
items:     376 件分布 241 条带子；20 个 ejector（19 个 progress=1.0）；32 条 beltPath，7 条有货
           green 4 / CuCuCuCu 12 / ----CuCu 7 / blue 210 / ScSc---- 139 / red 4
离群:      path 20 (55 格/87 件) 的 boundAcceptor = null
health:    belts 699 / belts_reaching_hub 390 / belts_dead 309 / reach_pct 0.558
           belts_deliverable 390 / belts_undeliverable 309（与几何口径同值）
           dead_by_source {miner:86, mixer:167, cycle:42, none:12, cutter:2}
production: produced_total {} / delivered_total {} / stored_delta 全 0（20 切片 × 10 s 窗口）
hub:       required 1000 / delivered 0 / progress 0；stored_shapes 无 Cw/Cb 相关键
交接审计:  681 处带子→带子交接，666 正确 / 15 错（致命 3 处吞掉 189 条）
```

关键文件行号：`src/agent/loop/topology.mjs:205`（accepts）、`:503`（flowOutlets）、
`:546`（flowReachable）、`:568`（每跳验 accepts）、`:597-641`（PAINT 剪枝）、`:660`（hubReachable）；
`src/agent/loop/health.mjs:101-135`（两个口径）、`:216-222`（字段赋值）；
`src/agent/verify_runtime.mjs:316`（slotsOf）；
`recon/upstream-full/src/js/game/buildings/hub.js:79-82`（16 个 `filter:"shape"`）、
`.../components/item_acceptor.js:85`（filter 判定）、`.../buildings/stacker.js`（inputsPerCharge: 2）。
