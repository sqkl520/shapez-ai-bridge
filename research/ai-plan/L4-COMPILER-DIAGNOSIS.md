# L4 离线编译器失败诊断（红队）

日期：2026-10-27
目标：`RuRu----` / hub `(-2,-2)` / level 4 / 真实存档 181 实体
结论一句话：**根因是 (d) —— `place()` 的两段式布局把"接 hub 的收集带"先铺、把"废料 trash"后放，而 trash 的候选生成只看几何不看占用，9 个候选全部落在刚刚铺好的收集带上。不是"没地方"，是"自己堵自己"。**

全程只读：`obs` / `status` / `resources` 之外没有调用任何写 RPC；未碰存档；未改任何源文件（下方所有探针都在 `research/ai-plan/tmp/diag/` 下的副本里）。

---

## 0. 先纠正一个前提：任务给的命令里 `--seed` 是错的

`research/ai-plan/L4-SEED-FINDING.md` 记录了这份存档的真实地图种子 = **55013**（暴力反解 + 存档解码两条独立路径互证）。CLI 默认 `43391` 是 level-11 存档的值。

实测（`research/ai-plan/tmp/diag/tilecheck2.mjs`）：

```
seed 43391: 6/8 命中 -10,4=- -9,4=- -8,5=CuCuCuCu -7,5=CuCuCuCu 2,-8=RuRuRuRu 3,-8=RuRuRuRu 4,-8=RuRuRuRu 5,-8=RuRuRuRu
seed 55013: 7/8 命中 -10,4=CuCuCuCu -9,4=CuCuCuCu -8,5=CuCuCuCu -7,5=CuCuCuCu 2,-8=RuRuRuRu 3,-8=RuRuRuRu 4,-8=RuRuRuRu 5,-8=null
```

（`55013` 对 `5,-8` 也差一格，是 `tileResource` 的矿格口径与实机矿机的 origin 口径不完全一致，属另一个已记录的独立问题，不影响本文结论。）

**这很重要**：任务里"直接跑失败 `cell:[4,-13]`"的那次，用的其实是默认 seed。用 `--seed 55013` 重跑，`failingNode` 变成 `cell:[4,-14]` —— 同一个 bug，只是机器簇下移了一格。所以下面的实验都同时给两组 seed，结论不受影响。

---

## 1. 失败链完整分解（每一段：哪行代码、什么判据、实际值）

### 1.1 DAG 是什么

`node research/ai-plan/tmp/diag/inspect_dag.mjs`（直接调 `solveGoal` / `mapOps`）：

```
steps: [
 { "id":"n0", "op":"mine", "hash":"RuRuRuRu", "depth":0, "inputs":[], ... },
 { "id":"n1", "op":"cut",  "hash":"RuRu----", "depth":1, "args":{"half":"right"}, "inputs":["RuRuRuRu"] }
]
```

- `n0` = 钌矿机（0.4/s）
- `n1` = 切割机（`cut`，`args.half="right"`）

`n1` 是**切割机**。`src/ai/op-templates.mjs:266-276`：

```js
op: "cut", footprint: [2, 1],
inputs:  [slot([0,0], "bottom", "primary")],
outputs: [slot([0,0], "top", "left"), slot([1,0], "top", "right")],
mustDiscardUnused: true,
wasteRoles: ["right"],
```

两个输出槽（left / right）**物理上都在**，切一半必然产生另一半。所以 **trash 不是编译器"多此一举"，目标是真需要一条废料出口**。这一半的事实支持选项 (a) —— 但只支持到"需要 trash"，不支持"放不下"。

### 1.2 谁接走了目标槽

`--hub 0,30`（同一目标、远离旧工厂）成功，`layout.channels`：

```
n1 右半格 (-24,-4) -> hub      ← 目标半块进了 hub
n1 左半格 (-25,-4) -> n1d0     ← 废料半块进 trash
```

与 `half: "right"` 一致（`compile.mjs:322`：`half === "right" ? "right" : "left"`；`compile.mjs:575` 的槽位映射注释写明 slot0=left、slot1=right）。**槽位选择是对的。**

### 1.3 为什么 trash 放不下：9 个候选逐一被占

`src/ai/compiler/place.mjs:1895-1904` `trashCandidates()`：

```js
for (let k = 2; k <= 2 + TRASH_PUSH_MAX; k++) cands.push({ cell: addN(slot0, out.dir, k), ... });  // 直串 7 个（k=2..8）
for (const perp of (isVert(out.dir) ? ["left", "right"] : ["top", "bottom"])) {                   // 侧让 2 个
    cands.push({ cell: add(first, perp), acceptor: OPP[perp] });
}
```

直串方向是 `out.dir`，侧让方向是**同一个 `out.dir` 的两侧**。整个候选集里**没有任何一个候选朝输出口的反方向走**。

加探针（`research/ai-plan/tmp/diag/place_dbg.mjs`，源文件的副本）跑空地图（seed 55013，`n1` 在 local `(4,-14)`）：

```
[DBG] node n1 op cut at 4 -14 outSlot 0 left top slotCell [4,-14]
[DBG]   cand [4,-16] acceptor bottom occupied? true
[DBG]   cand [4,-17] acceptor bottom occupied? false
[DBG]   cand [4,-18] acceptor bottom occupied? false
[DBG]   cand [4,-19] acceptor bottom occupied? false
[DBG]   cand [4,-20] acceptor bottom occupied? false
[DBG]   cand [4,-21] acceptor bottom occupied? false
[DBG]   cand [4,-22] acceptor bottom occupied? false
[DBG]   cand [3,-15] acceptor right occupied? true
[DBG]   cand [5,-15] acceptor left occupied? true
[DBG]   cand [4,-17] ROUTE FAIL why= cell-occupied at= null
[DBG]   cand [4,-18] ROUTE FAIL why= cell-occupied at= null
[DBG]   cand [4,-19] ROUTE FAIL why= cell-occupied at= null
[DBG]   cand [4,-20] ROUTE FAIL why= cell-occupied at= null
[DBG]   cand [4,-21] ROUTE FAIL why= cell-occupied at= null
[DBG]   cand [4,-22] ROUTE FAIL why= cell-occupied at= null
[DBG] beltCells: [[4,-7,"bottom","top"],... 7 格矿机竖干 ...,
                   [5,-15,"bottom","top"],[5,-16,"bottom","left"],[4,-16,"right","left"],
                   [3,-16,"right","bottom"],[3,-15,"top","bottom"],[3,-14,"top","bottom"],...,[3,-1,"top","bottom"]]
[DBG] machines: [["n0","mine",4,-6,1,1],["n1","cut",4,-14,2,1]]
```

**被谁占了**：全部是编译器自己在 §8.2 铺的 hub 收集带，**没有一格来自旧工厂**。

逐候选（`slot0=(4,-14)`，`out.dir=top` ⇒ `first=(4,-15)`，候选全部朝**屏幕上方** y 递减）：

| # | 候选 | 坐标 | 失败原因 | 占位者（`beltCells` 里的同一格） |
|---|---|---|---|---|
| ① | 直串 k=2 | `(4,-16)` | 候选格本身被占 | 收集带 `[4,-16,"right","left"]` |
| ②-⑦ | 直串 k=3..8 | `(4,-17)…(4,-22)` | 路由路径 `[(4,-15),(4,-16)]` 撞带 | 同上 `(4,-16)` |
| ⑧ | 侧让 left | `(3,-15)` | 候选格本身被占 | 收集带 `[3,-15,"top","bottom"]` |
| ⑨ | 侧让 right | `(5,-15)` | 候选格本身被占 | 收集带 `[5,-15,"bottom","top"]` |

**9 个候选里 7 个被同一格 `(4,-16)` 挡住，另 2 个被 `(3,-15)`/`(5,-15)` 挡住** —— 三格全是收集带。

注：②-⑦ 报的是 `cell-occupied` 且 `at=null`。原因是 `planChannel` 的 `at: cells.find(blocked)`（`place.mjs:1317`）在"直线"分支里成立，但 trash 这条走的是"同轴反向"分支（`last` 与 `first` 相邻且方向相反），返回 `at: first`；`first` 本身是空的，于是 `at` 打印为 `null`。**不要被这个 null 误导成"没有阻挡格"** —— 真正阻挡在 `(4,-16)`。

也就是说：**hub 收集带从切割机右半格出发，先向上 2 格、再向左 2 格绕到 `x=3`，然后沿 `x=3` 一路下行到 hub 顶排入口。这条"上绕"路径恰好横跨在切割机左半格（废料口）正上方的唯一走廊上，把 9 个候选全部封死。**

### 1.4 因果验证（不是相关性）

**实验 A：把 §8.3（trash）挪到 §8.2（hub）之前**（临时副本 `place_reorder.mjs`，仅拼接两个代码块）：

```
no-world                 ok=true
no-world (connectHub:false) ok=true
with-world               ok=false  no-site-large-enough
with-world (connectHub:false) ok=false  no-site-large-enough
```

对照原始顺序：

```
no-world                 ok=false no-site-large-enough   ← V9 消失
with-world               ok=false dag-not-placeable:column-conflict-unresolved
```

**空地图的 V9 在反序后直接消失** —— 因果成立。（这条 `ok:true` 不可直接采用：反序后 trash 抢先注册了 `n1.left` 这个输出槽，hub 建立时该槽已被 `usedOut` 标记，于是 `hubConnection: null`，计划里没有任何东西通向 hub。这说明两个步骤**互相依赖**：trash 必须在 hub 之后，才能知道哪个槽是"真废料"；而 hub 又需要 trash 先把路面让出来。当前代码没有为这个循环依赖做迭代。）

**实验 B：`place()` 失败后不做加宽重试**（`compile.mjs:807-810`）：

```js
export function routeStage(placeResult, ctx) {
    if (placeResult.ok === false) return placeResult;   // ← 直接返回，gap 重试永不触发
```

实测 `--row-gap 8/10/12/14` 全部同一个 V9（`research/ai-plan/tmp/diag/matrix.sh` 的 T10 与手工矩阵）—— 加宽毫无帮助，因为 `place()` 一失败就短路了。

### 1.5 "最后因 cell-occupied" 的措辞有误导

`hint` 说"末因 cell-occupied"，但那是**第 9 个候选**（侧让 right `(5,-15)`）的失败原因；前 8 个里 6 个也是 `cell-occupied`，只有 2 个是首发格被占。这句话会让人以为是旧工厂挡路，实际是编译器自己的带子。

---

## 2. 三次对照实验（原始输出）

### 2.1 主矩阵（`research/ai-plan/tmp/diag/matrix.sh`）

```
T1 空地图 hub(-2,-2) seed默认   => ok:false no-site-large-enough fail={"nodeId":"n1","cell":[4,-13],"check":"V9-unused-outlet"}
T2 空地图 hub(-2,-2) seed55013  => ok:false no-site-large-enough fail={"nodeId":"n1","cell":[4,-14],"check":"V9-unused-outlet"}
T3 world181 hub(-2,-2) seed默认 => ok:false dag-not-placeable:column-conflict-unresolved fail={"nodeId":"n1","cell":[5,-13],"check":"V6-crossing"}
T4 world181 hub(-2,-2) seed55013=> ok:false dag-not-placeable:column-conflict-unresolved fail={"nodeId":"n1","cell":[7,-12],"check":"V6-crossing"}
T5 world181 hub(-2,-2) seed55013 tunnels => ok:false dag-not-placeable:column-conflict-unresolved fail={"nodeId":"n1","cell":[7,-12],"check":"V6-crossing"}
T6 空地图 hub(0,30) seed默认    => ok:true ents=43 anchor=[-25,23]
T7 world181 hub(0,30) seed默认  => ok:true ents=43 anchor=[-25,23]
T8 空地图 hub(0,30) seed55013   => ok:true ents=21 anchor=[3,34]
T9 world181 hub(0,30) seed55013 => ok:true ents=21 anchor=[3,34]
T10 空地图 hub(-2,-2) rowGap14  => ok:false no-site-large-enough fail={"nodeId":"n1","cell":[4,-20],"check":"V9-unused-outlet"}
T11 空地图 hub(-2,-2) miners4   => ok:true ents=52 anchor=[1,-19]
T12 world181 铜目标 CuCuCuCu    => ok:false dag-not-placeable:column-conflict-unresolved fail={"nodeId":"n0","cell":[-5,8],"check":"V6-crossing"}
```

### 2.2 三次结果的对照解读

| 条件 | 结果 | 说明 |
|---|---|---|
| **不给 `--world`（纯空地图）** | `V9-unused-outlet` @ `(4,-13)` | 与用户报告的签名**逐字一致** ⇒ 用户那次跑的是空地图路径（或 `--world` 没生效，见 §3） |
| **给 `--world`（181 实体）** | `V6-crossing` @ `(5,-13)` | 失败点**变了**：不是"没地方放 trash"，而是"接不上 hub" |
| **换 hub `0,30`** | `ok:true` | 离开旧工厂就能编出来 ⇒ **不是"整个 world 没地方"** |
| **换 hub `0,30` 且带 181 实体** | `ok:true`，且与不带 world **逐字节同布局** `ents=21 anchor=[3,34]` | 说明远离旧工厂时 world 占位根本没参与布局（合理） |

**"没地方"还是"逻辑错"？**
- 不是"整张地图没地方"：`0,30` 成功，`-2,-2` 失败。
- 也不是"hub 旁边没地方"：同一 hub 下 `--miners 4` 成功（`ents=52 anchor=[1,-19]`），因为它把切割机挤到 `x=8`，绕开了收集带。
- 失败是 **`n1` 与"接 hub 的收集带"抢用同一片 3×3 区域**。BFS 独立验证（`pathcheck.mjs`）：空地图里从废料口 `(4,-14)` 到 hub 入口有 **14 格**的合法路径，说明物理上走得通，只是 `trashCandidates` 枚举不到那个方向。

### 2.3 带 world 时失败点为什么变了

`--world` 让矿机被迫换格（真实 Ru 矿格被旧矿机占了），机器簇整体右移，收集带也跟着换了一条路，结果撞上另一个问题：hub 入口接不上。

`--world` 下的探针（`DBG_HUB=1`）打印的是**局部坐标**（`place()` 的 origin = 真 hub `(-2,-2)`，所以世界坐标 = 局部 + `(-2,-2)`）。逐条换算后：

| 探针 entry | 局部格（探针原值） | **世界格** | `obs` 占用 | 结果 |
|---|---|---|---|---|
| 0 | `(0,-1)` | **`(-2,-3)`** | `belt r=180` uid 10074 | **BLOCKED** |
| 4 | `(1,-1)` | **`(-1,-3)`** | `belt r=270` uid 10032 | **BLOCKED** |
| 12 | `(3,-1)` | **`(1,-3)`** | `belt r=180` uid 10183 | **BLOCKED** |
| 3 | `(4,0)` | `(2,-2)` | 空 | `column-conflict` |
| 7 | `(4,1)` | `(2,-1)` | 空 | `column-conflict` |
| 8 | `(2,-1)` | `(0,-3)` | 空 | `column-conflict` |
| 2 | `(-1,0)` | `(-3,-2)` | 空 | `column-conflict` |
| 11 | `(4,2)` | `(2,0)` | 空 | `column-conflict` |
| 13 | `(3,4)` | `(1,2)` | 空 | `column-conflict` |
| 15 | `(4,3)` | `(2,1)` | 空 | `column-conflict` |
| 6 | `(-1,1)` | `(-3,-1)` | 空 | `column-conflict` |
| 9 | `(2,4)` | `(0,2)` | 空 | `column-conflict` |
| 5 | `(1,4)` | `(-1,2)` | 空 | `column-conflict` |
| 10 | `(-1,2)` | `(-3,0)` | 空 | `column-conflict` |
| 1 | `(0,4)` | `(-2,2)` | 空 | `column-conflict` |
| 14 | `(-1,3)` | `(-3,1)` | 空 | `column-conflict` |

**16 个入口的独立核对**（直接对 `obs` 的 181 实体查 hub 外圈）：

```
入口编号  格      边     占用者
   0  (-2,-3) top     belt uid 10074      ← 被占
   1  (-1,-3) top     belt uid 10032      ← 被占
   2   (0,-3) top     空                  ← 唯一空的顶排入口
   3   (1,-3) top     belt uid 10183      ← 被占
   4   (-2,2) bottom  空
   5   (-1,2) bottom  空
   6    (0,2) bottom  空
   7    (1,2) bottom  空
   8   (-3,-2) left   空
   9   (-3,-1) left   空
  10   (-3,0) left    空
  11   (-3,1) left    空
  12    (2,-2) right  空
  13    (2,-1) right  空
  14     (2,0) right  空
  15     (2,1) right  空
```

- **只有 3 个入口被旧实体真正挡住**：`(-2,-3)`、`(-1,-3)`、`(1,-3)` —— 全在**顶排**，是旧铜线（`x=-2..-6, y=-3` 横段）和旧钌线（`x=1`）进 hub 的最后一格。
- **其余 13 个入口是 `column-conflict`**，包括物理上完全空的 `(0,-3)`、底排 4 格、左列 4 格、右列 4 格。

**所以带 world 时的 V6 是两个独立缺陷叠加**：

1. 3 个顶排入口被旧线吃掉（真实的增量对接难点，但只剩 13 个入口，不影响"能不能接上"）。
2. 13 个入口路由失败 —— 这是**路由器的几何约束太窄**（v1 只允许"竖直—横向—竖直"的 Z 形，且要求横段不进别的列），不是被占。空地图上同样的 13 个也会失败（T1/T2 的 `column-conflict` 探针输出），只是空地图先撞上 V9，轮不到 hub。

**推论：即使把 3 条挡路旧带删掉（这是允许的最激进操作），带 world 仍然会 `column-conflict`。** 我验证了这一点：

```
node ... --hub -2,-2 --seed 55013 --world research/ai-plan/tmp/diag/world_block3.json
（world 只含 hub + 3 条挡 hub 的旧带）
=> ok:true  anchor [0,-18]  ents=31  validation pass true  hubConnection {"entry":[2,-1],"side":"top","dir":180}
```

等等 —— 这条**成功了**。说明 3 条带子在时反而能接上（因为机器簇被 `--world` 推到另一个位置）。而一旦 161 条带子全在，机器簇换到 `(6,-4)`，收集带就必须从 `(5,-13)` 竖直往北，撞上 `column-conflict`。

**结论**：带 world 的失败主要不是"入口被占"（只占 3/16），而是"**机器簇被迫移到 `x=6`，收集带所在的列/车道路线整体落进了路由器的死区**"。入口占用是次要因素 —— 但它是**真实的增量对接难点**，只是这一次没有成为决定性因素。

（`world_block3` 那条 `ok:true` 不能当作"删掉 3 条带就能成功"的凭据：它的 31 实体蓝图对**完整** 181 实体仍有重叠，与 §6.1 是同一类错误。）

## 3. `--world` 的实现审计：它工作了一半，另有一半被静默绕过

### 3.1 它把既有实体当成什么

`src/ai/compiler/place.mjs:189-222` `validateWorld()`：

```js
occupancy.push({
    cell: [en.x, en.y],
    state: en.type === "belt" ? "replaceable" : "solid",
    who: String(en.uid), kind: String(en.type),
});
```

- hub → 铺 4×4 `solid`
- belt → `replaceable`
- 其它机器 → `solid`

`place.mjs:2296-2306` 的注释说得很清楚：**replaceable（带子）当前一律算占位**（保守策略，因为覆盖旧带会断旧产线）：

```js
for (const o of occupancyLocal) {
    const k = cellKey(o.cell[0], o.cell[1]);
    occupied.add(k);       // 带子也加进 occupied
}
```

所以口头上"带子可覆盖"，实际代码里**带子也挡机器、也挡通道**。两者都是"不可替换"。

### 3.2 `--world` 真的生效了吗：**生效，但不完整**

**生效的证据**（不是相关性）：
- `--miners 4 + world` 时报 `emit:mismatch`：`期望 占地 6,-6 与既有世界 occupancy 冲突`（`types.mjs:736`）。这条断言只在 `report.occupancy` 非空时才可能触发。
- 给"只有 1 台旧矿机在 (2,-8)"时，新矿机落到 `(4,-6)`；给"3 台旧矿机"时新矿机落到 `(4,-6)` 但收集带撞车。**旧矿机位置改变了布局**，说明占位进入了 `planMinerColumns` / `jointResourceShift`。

**不生效（静默绕过）的证据 —— 这是最危险的一处**：

`cli.mjs:130-132` 只写 `input.worldEntities`：

```js
input.worldEntities = list
    .filter(e => e && typeof e.type === "string" && Number.isFinite(e.x) && Number.isFinite(e.y))
    .map(e => ({ type: e.type, x: e.x, y: e.y }));
```

而 `compile.mjs:1482` 给 `siteStage` 传的是 `input.world`：

```js
seed, world: input.world || null, ...
```

`compile.mjs:1460` 只把 `worldEntities` 放进 `ctx`，**没有任何一行把 `input.worldEntities` 变成 `input.world`**。于是 `regionClear(ctx)`（`compile.mjs:1156-1160`）在 CLI 路径下**永远拿到 `world=null` ⇒ 永远返回 `true`**。

直接调 `siteStage` 复现（`regionclear_probe2.mjs`）：

```
CLI 实际路径（siteStage 收到 world=null）  : false no-resource-in-range 放置层给的矿位与 seed 的资源图对不上
若 siteStage 真收到 world（181 实体）      : false no-site-large-enough 世界快照里有既有实体（非 hub）⇒ 这份计划不是「全新址」…
```

**含义**：`compile.mjs:1044` 那道"世界不干净就拒绝"的闸，在 `--hub` 路径（也就是 README 让用户走的唯一路径）上从来没有执行过。它只在单测/库调用直接传 `world` 时才生效。这是一条**假绿通道**：`--world` 世界里有 181 个实体，CLI 仍然往 `siteStage` 之外走，所有"世界系不干净"的判断都跳过了。

### 3.3 占位精度：只算 origin 一格（未按 footprint 展开）

`validateWorld` 对非 hub 实体只 push `[en.x, en.y]` 一格。实测（`footprint_check.mjs`，喂 cutter (-8,-11)、balancer (8,-9)、miner (2,-8)、belt (0,0)、hub (-2,-2)）：

```
occupancy count: 20
cutter right half (-7,-11) marked? false
balancer right half (9,-9) marked? false
```

20 = 16（hub 4×4）+ 4 格（4 个非 hub 实体各 1 格）。**2×1 机器的右半格完全没有占位。**

当前存档里 2×1 机器共 8 台，`rotation` 全部 = 0（`rotation 分布 {"0":8}`），所以这一次的右半格恰好都空着，没有立刻触发 paste 冲突。但只要将来 `r=90/270` 的 2×1 机器出现，`origin` 的位置会左移/上移，右半格就会漏判 —— 这是一个潜伏的缺陷，不是当前失败的根因。

### 3.4 旋转字段被丢弃

`cli.mjs:130-132` 的 `.map(e => ({ type, x, y }))` 把 `r` 和 `rotation_variant` 全丢了（实测 `rfield.mjs`：`含 r 字段? false`）。`validateWorld` 因此无法知道机器的朝向，也就无法算 footprint 展开方向。与 §3.3 是同一个根因的两面。

### 3.5 放置时"机器压旧实体"不是约束，是事后断言

`place.mjs:2272` 构造 `new Grid()` 后立刻 `placeMachines(grid, nodes)`，而既有世界的占位直到 `place.mjs:2301` 才灌进 `occupied`。`Grid` 里**没有任何一处**调用 `markOccupancy`（全文检索：`markOccupancy` 只有定义，无调用）。

后果：`placeMachines` 只防"新机器之间互撞"。如果新机器压在旧机器上，`place()` 本身**不会报错**，要等到 `buildReport` → `assertLayoutReport`（`types.mjs:731-737`）才抛 `ContractViolation`，而 `placeStage` 把它包成 `emit:mismatch`（一个误导性的"发射"阶段错误）。

实测 `--miners 4 + --world`：

```
ok:false emit:mismatch | 契约违反 layout.placements: 期望 占地 6,-6 与既有世界 occupancy 冲突 …
```

而 `(6,-6)` 在真实存档里是**空的**（`world 里 (6,-6) 的实体: []`）。这说明**断言用的 occupancy 与真实世界不是同一份**：`place()` 把新机器的 4 台矿机/balancer 坐标换算成局部系后，与 `occupancyLocal` 的换算口径不一致，报了一个假冲突。这条需要单独排查，但它证明 `--world` 路径目前**既漏判真冲突、又会误报假冲突**。

---

## 4. 根因判定

### 4.1 排除 (a)：目标本身需要废料出口 ⇒ 需要，但不是根因

`cut` 模板 `wasteRoles: ["right"]`，切一半必然有另一半，**trash 是必需的**。但实测 `connectHub:false`（不接 hub、两个槽都进 trash）时空地图 `ok:true`：

```
===== no-world (connectHub:false) ok= true
   n0 mine / n1 cut / n1d0 trash / n1d1 trash
```

同一块地、同样两台机器，**只要不让收集带抢跑道，两个 trash 都放得下**。所以"需要 trash"是前提，"放不下"不是必然。

### 4.2 排除 (b)：没有利用既有占位 ⇒ `--world` 生效了，问题不在这里

对照 §2.2：带 world 与不带 world 的失败**不是同一个失败**，说明 world 确实改变了规划。而且空地图（完全没有占位）也照样 V9 失败 —— **如果根因是"没利用占位"，空地图反而不该失败**。所以 (b) 不是本次 V9 的根因（但 §3.2 的 `regionClear` 绕过是**真实存在的独立缺陷**，只是不解释这个 V9）。

### 4.3 排除 (c)：`placeStage` 选址判断有 bug ⇒ 选址根本没跑到

`placeStage` 在 `stages` 里是 `{"ok": false, "reason": "no-site-large-enough"}`，但那是 `place()` 返回的 `reason` 被透传（`compile.mjs:1464` 的 `trace` 直接抄 `pl`）。真正的选址 `siteStage` 在 `stages` 里**根本没有出现**（`T2` 的 `stages` 只有 `inspectGoal / solveGoal / rebuildDag / mapOps / pigmentGate / placeStage`）—— 因为 `placeStage` 失败后 `compileInner` 直接 `bail` 了，从未进入 `siteStage`。

所以 (c) 不成立：不是"选址判断错"，是**压根没走到选址**。

### 4.4 判定：(d) —— 两段式布局的步骤顺序 + 候选枚举方向单一是根因

具体三条，按因果强度排序：

**(d-1) `place()` 的 §8.2（hub）与 §8.3（trash）存在循环依赖，代码用了固定顺序且不回退。**
`place.mjs:2450-2494`（hub）先执行，成功才在 `:2486` 用 `usedOut.add` 标记该槽；`place.mjs:2497-2549`（trash）后执行，只能看到"剩余槽"。hub 铺的带子占掉了 trash 的全部候选格，trash 失败 → 整单 abort，**没有任何回退**（`place.mjs:2546` 直接 `return makeFailure`）。

反序实验（§1.4 实验 A）是直接证据：反序后空地图 V9 消失。

**(d-2) `trashCandidates()` 的方向枚举与"接 hub 的收集带"天然冲突。**
收集带从切割机右半格出发，为了绕到 hub 必须经过切割机**右侧和下方**；而 `trashCandidates` 的 9 个候选恰好全部在**右侧、下方、右侧侧让**（§1.3 表格）。两者抢同一片区域是结构性的，不是这一次的巧合。

**(d-3) `place()` 失败不进入加宽重试。**
`compile.mjs:808` 的第一行就短路。所以 `--row-gap 8/10/12/14` 全失败（T10 与手工矩阵），重试机制形同虚设。

**为什么说不是 (a)(b)(c)**：(a) 需要 trash 但不必然放不下（`connectHub:false` 成功）；(b)×world 生效且空地图同样失败；(c) 选址根本没跑到。

---

## 5. `--world` 是否真的工作的结论

**部分工作，但有一处静默失效，且精度不足。**

| 方面 | 结论 | 证据 |
|---|---|---|
| 是否改变布局 | ✅ 是 | 单台旧矿机在 (2,-8) 时新矿机落 (4,-6)；无旧矿机时落 (2,-8) |
| 机器 / 带子是否挡住新机器 | ⚠️ 只在事后断言里挡，`place()` 本身不挡 | `place.mjs:2272` 先落子、`:2301` 才灌占位；`Grid` 零次 `markOccupancy` |
| 带子是否被视为"可覆盖" | ❌ 否（代码里一律算占位） | `place.mjs:2306` 无条件 `occupied.add(k)` |
| footprint 是否逐格 | ❌ 否，只算 origin 一格 | `footprint_check.mjs`：cutter 右半格 `false` |
| 旋转是否读取 | ❌ 否，`r` 在 CLI 就被丢弃 | `cli.mjs:132`；`rfield.mjs` |
| `regionClear` 世界净地闸 | ❌ **CLI 路径下永不执行** | `compile.mjs:1482` 传 `input.world`，而 CLI 只填 `input.worldEntities`；`regionclear_probe2.mjs` 正反对照 |
| 表格里最危险的一条 | **`regionClear` 被绕过** | 它让"世界不干净"的硬拒绝在 `--hub` 路径上完全消失，与 `L4-SEED-FINDING.md` 记的"`--world` 只进占位、不进矿图"是同一类问题 |

---

## 6. 半手工方案的量级估算

### 6.1 先自我更正一处：`T_block3m` 不是"现成可贴"

初稿里我把 `T_block3m`（31 实体）写成了"已贴进真实存档且不压旧实体"。**这是错的。** 它编译时只喂了 5 个实体（hub + 3 条带 + 1 台矿机），拿它对**全部 181 个实体**做重叠检查：

```
T_block3m 蓝图格数 32 与全部 181 实体同格: 15 ["4,-14","5,-14","3,-15","4,-8","4,-9","4,-10","4,-11","4,-12","4,-13","5,-15"]
```

15 格重叠（整条收集竖干压在旧钌线 `x=3`/`x=4` 上）。它只证明"只保留 5 个实体时编译器能排出合法蓝图"，**不能当交付物**。

### 6.2 关键事实：现有钌线有一段是**向上**的

`obs` 实测 `belt rotation 分布: {"0":108,"90":10,"180":41,"270":2}`。其中 **r=0 = 向上**（`belt-rules.mjs:20`：`DIRV.top = [0,-1]`；带子 `r=0` 从 `(x,y+1)` 收货、送到 `(x,y-1)`）。

逐格看 `x=1..6`（`obs` 原始数据，`b0` = 带子 r=0，`b180` = 带子 r=180）：

```
  y    x1    x2    x3    x4    x5    x6
  -9  b180   b0    b0    b0    b0    b0
 -10  b180   b0    b0    b0    b0    b0
 -11  b180   b0    b0    b0    b0    b0
 -12  b180   b0    b0    b0    b0    b0
 -13  b180   b0    b0    b0    b0    b0
 -14  b180   b0    b0    b0    b0    ..
 -15  b180   b0    b0    b0    b0    ..
 -16  b180   b0    b0    ..    ..    ..
```

- `x=2..5` 从 `y=-16` 到 `y=-9` 共 8 格是 **r=0（向上）**，源头是 4 台钌矿机 `(2..5,-8)`。
- `x=1` 全列 r=180（向下），通往 hub 的 `(1,-3)` 入口。
- 所以现有钌线是 **U 形回绕**：矿机向上（x=2..5）→ 到 `y=-34` 横移到 `x=1` → 向下（x=1）进 hub。整块 `RuRuRuRu` 直接进 hub（`hub.stored_shapes.RuRuRuRu = 112481`，而 `goal.delivered = 0`）。

**这就是 `WHY-NO-CUTTER-INSERT.md` 里"插不进去"结论的边界条件**：它试的是 `x=1` 的向下段（r=180），方向确实不对；但 `x=2..5` 的向上段**满足 `r=0` 切割机的要求**（输入在南侧 `y+1`，流向从南往北）。

### 6.3 目标在哪个槽：right 槽（已用 `cutHalf` 验证）

```
node research/ai-plan/tmp/diag/half_check2.mjs

h[0] (slot0 / 'left'  → 输出格 (x,   y-1)): [[null,null,rect,rect]]
h[1] (slot1 / 'right' → 输出格 (x+1, y-1)): [[rect,rect,null,null]]
goal (RuRu----):                            [[rect,rect,null,null]]
h[1]===goal? true
```

**目标 `RuRu----` = h[1] = slot1 = right 槽 = `(x+1, y-1)`。** 废料是 left 槽 `(x, y-1)`。

### 6.4 理论最小方案：**2 个新实体**

在 `(4,-13)` 放一台切割机（占 `(4,-13)`、`(5,-13)`），把 `(4,-14)` 换成 trash：

| 槽位 / 格 | 坐标 | `obs` 现状 | 结果 |
|---|---|---|---|
| 输入 | `(4,-13)+(0,+1) = (4,-12)` | `belt r=0` uid 10208 | 向上喂入 ✓ **不动** |
| 右半 = 目标 | `(5,-13)+(0,-1) = (5,-14)` | `belt r=0` uid 10150 | 已有带子接收，继续上行 → `(5,-15)` → balancer ✓ **不动** |
| 左半 = 废料 | `(4,-13)+(0,-1) = (4,-14)` | `belt r=0` uid 10143 | **换成 trash**，直收 ✓ |
| 切割机本体 | `(4,-13)`、`(5,-13)` | 两条 `belt r=0`（uid 10209、10149） | **删掉，放切割机** |

**净变化：`+1 cutter`、`+1 trash`、`-3 belts`。**

**关键点：目标那一半的去路是现成的。** `(5,-14)` 本来就是 r=0 的带子，它从 `(5,-13)`（切割机右格）收货、往 `(5,-15)` 送 —— 方向天然对，一格都不用加。

### 6.5 这个方案的真实代价（必须人工确认）

**切割机是 2 格宽，横跨 `x=4` 和 `x=5` 两条流路。** `x=5` 那条流路的货（来自矿机 `(5,-8)`）到 `(5,-12)` 时，上方 `(5,-13)` 变成了切割机的**右格**，而切割机的唯一输入在 `(4,-12)`（左格下方）。所以：

- `(5,-12)` 的带子会把货推向切割机右格，**那里不收**（输入槽只在左格下方）⇒ `x=5` 这条流路会堵。
- 缓解办法：把 `(5,-12)` 的带子改成朝东（`r=90`）拐到 `(6,-12)`，再并回 `x=6` 列。`(6,-12)` 处 `obs` 显示是空的（`(6,-12) 空`），`x=6` 列 `y=-13..-9` 有 `belt r=0`。**代价：改 1 格带子方向 + 加 1 格带子。**

所以现实的量级是：

| 方案 | 新增 | 删除/改动 | 总计 |
|---|---|---|---|
| **A0 理论最小** | cutter ×1, trash ×1 | 删 3 格旧带 | **+2 实体** |
| **A1 含 x=5 改道**（推荐） | cutter ×1, trash ×1, belt ×1 | 删 2 格旧带、改 1 格方向 | **+2~4 实体** |

两者都远小于"重建一条线"。

### 6.6 备选：全新一条线（完全不碰旧线）

若连"删 3 格旧带"都不接受，就新建一条线。BFS 搜索（`manual_plan.mjs`；约束 = 不压任何既有实体 + 4 邻接 + 切割机 2×1 + 目标进 hub 顶排唯一空入口 `(0,-3)`）给出 26 个可行候选，最省的 6 个：

```
矿机6,-4 gap1 切割机6,-6 目标半块=left trash7,-8 | 喂料带0 到hub带12 => 约 16 实体
矿机6,-5 gap1 切割机6,-7 目标半块=left trash7,-9 | 喂料带0 到hub带13 => 约 17 实体
矿机6,-4 gap1 切割机6,-6 目标半块=right trash6,-8 | 喂料带0 到hub带13 => 约 17 实体
矿机7,-4 gap1 切割机7,-6 目标半块=left trash8,-8 | 喂料带0 到hub带13 => 约 17 实体
矿机6,-6 gap1 切割机6,-8 目标半块=left trash7,-10 | 喂料带0 到hub带14 => 约 18 实体
矿机6,-5 gap1 切割机6,-7 目标半块=right trash6,-9 | 喂料带0 到hub带14 => 约 18 实体
```

**约 16~18 个实体**（1 矿机 + 1 切割机 + 1 trash + 12~14 格带子）。注意这些 BFS 结果是"几何可行"，未校验速率与 `half` 语义，落地前仍需 dry_run。

### 6.7 量级结论

| 方案 | 实体增量 | 交付 70 个 | 是否动旧线 |
|---|---|---|---|
| **A. 插进现有向上段** | **+2 ~ +4** | 现有 4 矿机 ≈1.6/s → **约 44 秒** | 删 2~3 格旧带（原地替换） |
| B. 新建一条线（BFS 最优） | 16~18 | 1 矿机 0.4/s → **175 秒** | 完全不碰 |
| C. 新建 4 矿机线 | 约 50 | 1.6/s → 44 秒 | 完全不碰，需 4 格相邻空闲 Ru 矿 |

**量级判断：2~18 个实体。绝对量级是"个位数到十几个"，不是"上百个"。**

若允许原地替换，方案 A 只需 **2~4 个实体**（1 切割机 + 1 trash + 至多 1 格带子），并且直接继承现有 4 台矿机的产能。

### 6.8 约束核对

- **切割机输入 `(x, y+1)`、输出 `(x, y-1)`/`(x+1, y-1)`，仅 r=0**：已核对 `op-templates.mjs:266-276`，与 `WHY-NO-CUTTER-INSERT.md` 一致。流向必须从南往北（y 减小）—— 现有 `x=2..5` 的 r=0 向上段满足。
- **矿机 0.4/s、带子 2/s**：带子不瓶颈。4 台矿机 = 1.6/s。
- **目标 70 个**：`obs.goal.requirement = {shape:"RuRu----", required:70, delivered:0}` —— 是**总量**不是速率。4 台矿机约 44 秒；1 台约 175 秒。
- **hub 16 入口**：顶排实测只剩 `(0,-3)` 空（`(-2,-3)`/`(-1,-3)`/`(1,-3)` 都被旧带占）；其余三排在 `obs` 里没有实体贴附。BFS 证明到 `(0,-3)` 的距离只有 10~15 格。编译器实测 13 个入口报 `column-conflict`（§2.3），是路由策略太窄，不是物理不可达。

---

## 7. 给下一步的最小修复方向（不实施，仅记录）

按性价比排序：

1. **`trashCandidates` 增加"反方向 + 远端侧让"候选**（`place.mjs:1895`）。当前 9 个候选全在输出口的 `out.dir` 半平面；补 `-out.dir` 方向与"远端侧让"（`addN(slot0, out.dir, k)` 再侧让）即可绕开收集带。改动最小，且不改变任何现有成功目标的输出（因为新候选排在末尾）。
2. **`place()` 的 §8.2/§8.3 改成"先定槽、再统一布线"**：先算出哪些输出槽必须进 hub、哪些必须进 trash，再一次性布线；或者在 §8.3 失败时回退 §8.2 换一个 hub 入口。这是根治 d-1 的做法，但改动大。
3. **把 `input.worldEntities` 接到 `siteStage` 的 `world`**（`compile.mjs:1482`）。这一条与本次失败无关，但它是"假绿"通道：修之前 `--world` 永远不会触发"世界不干净"拒绝。
4. **`placeMachines` 之前把 `occupancyLocal` 灌进 `Grid`**（`place.mjs:2272` 前），让"机器压旧实体"在放置时就失败，而不是等到 `emit:mismatch`。
5. **`validateWorld` 按 footprint 展开 + 读 `r`**（`place.mjs:210-218`），并让 CLI 保留 `r`（`cli.mjs:132`）。

---

## 附：本文所有实验的复现命令

```bash
cd "D:/Projects/rea/Project work/shapez"

# 0) 取存档快照（只读）
curl -s -X POST http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
  -d '{"method":"obs","params":{}}' > research/ai-plan/tmp/diag/obs.json
node -e "const o=JSON.parse(require('fs').readFileSync('research/ai-plan/tmp/diag/obs.json','utf8'));\
require('fs').writeFileSync('research/ai-plan/tmp/diag/world181.json',JSON.stringify({entities:o.result.entities}))"

# 1) 主矩阵
bash research/ai-plan/tmp/diag/matrix.sh

# 2) 失败链探针（place.mjs 的副本，不改源文件）
DBG_TRASH=1 node research/ai-plan/tmp/diag/probe_place_dbg.mjs
DBG_HUB=1   node research/ai-plan/tmp/diag/probe_place_dbg.mjs

# 3) 反序因果实验
node research/ai-plan/tmp/diag/probe_reorder.mjs

# 4) --world 精度 / regionClear 绕过
node research/ai-plan/tmp/diag/footprint_check.mjs
node research/ai-plan/tmp/diag/regionclear_probe2.mjs
node research/ai-plan/tmp/diag/worldgate.mjs

# 5) 半手工方案量级
node research/ai-plan/tmp/diag/manual_estimate.mjs
```

**声明**：`probe_place_dbg.mjs` / `place_dbg.mjs` / `place_reorder.mjs` 全部是 `src/ai/compiler/place.mjs` 的**副本**，放在 `research/ai-plan/tmp/diag/` 下；源文件一个字节都没有改动。游戏桥在实验中途退出了游戏（`in_game:false`），之后的实验全部基于已保存的 `obs.json` 离线完成，没有重新读档、没有写任何东西。
