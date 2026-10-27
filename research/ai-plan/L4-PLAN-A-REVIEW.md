# L4 方案 A 独立审查（红队）

审查人：独立验证 Agent（只读 RPC，未做任何写操作）
被审对象：`research/ai-plan/L4-PLAN-A.md`（2026-10-27）
存档：`cf469f75`，181 实体，hub level 4，目标 `RuRu----` 0/70
地图种子：`55013`（`world_info` 实测确认）

## 裁决

**根本错误 —— 不能直接执行。**

方案有 **两处致命几何错误**，任何一处都会让产线一件货也送不到 hub：

1. **x=12 竖列的方向整体装反了。** 12 条带子全部按 `-y` 方向（远离 hub）布置，
   而目标在 `+y` 方向。货从槽1 出来走到 `(12,-14)` 后，会被 `(12,-14)` 的
   `code=2`（出口 top）**喷向 `(12,-15)` 这个空格**，链路在此断头。整列 12 条带子
   加上两个转角，一共 13 个实体需要改朝向。
2. **`(2,-3)` 不是 hub 的入口格。** hub 顶排入口是 `(-2..1, -3)`，右列入口是
   `(2, -2..1)`。`(2,-3)` 与 hub 4×4 只是**对角相邻**，任何方向都不挨着 hub。
   方案让 `(2,-3)` 出口 bottom 喷进 `(2,-2)`，而 `(2,-2)` 是空格，货就地蒸发。
   **缺 1 条带子 `(2,-2)`。**

另有 5 处非致命错误（见 §E）。占位检查结论是**干净的**：方案全部 37 格（含切割机第二格）
无冲突——这一点设计师说对了。

修正后的最短方案只需 **18 个实体**（方案声称 43，实际也应是 36），见 §D。

---

## A. 格子占用（✓ 通过）

方法：`obs` 全量拉 181 实体，按真实 footprint 铺占位图
（hub 4×4 / cutter 2×1 / balancer 2×1 / 其余 1×1），逐格比对方案坐标。

```
$ obs {region:[-2,-25,16,2], max_entities:5000, include_stats:true}
tick 97877.6  count 102  truncated false
hub {"stored_shapes":{"CuCuCuCu":46,"----CuCu":47854,"RuRuRuRu":114015},
     "blueprint_shape_key":"CbCbCbRb:CwCwCwCw"}
goal {"level":4,"requirement":{"shape":"RuRu----","required":70,"delivered":0,...}}
```

| 方案格子 | 实测 | 结论 |
|---|---|---|
| miner `(6,-7)` | free | ✓ |
| 带子 `(6,-8)..(6,-12)` | 全 free | ✓ |
| 切割机 `(6,-13)`+`(7,-13)` | 全 free | ✓ |
| 带子 `(6,-14)`、trash `(6,-15)` | free | ✓ |
| 带子 `(7,-14)`、`(8..11,-14)` | free | ✓ |
| 带子 `(12,-14)`、`(12,-13)..(12,-4)`、`(12,-3)` | 全 free | ✓ |
| 带子 `(11..2,-3)` | 全 free | ✓ |

**冲突格子清单：空（0 个）。** 37 格全空。特别核对任务点名的三条通道：

- `x=6, y=-20..-3` → 18 格中占用 **0**。方案写"13/13 空"——结论对，**但区间里有 18 格不是 13 格**（算术错，见 §E-6）。
- `x=7, y=-20..-3` → 18/18 空 ✓
- `x=12, y=-20..-3` → 18/18 空 ✓
- `(2,-3)` → free ✓（`obs` 无实体；`(1,-3)` 有 belt#10183，`(2,-2)` 空）

**矿格验证（两种独立方法，均通过）：**

```
$ resources {region:[0,-25,14,-1]}
RuRuRuRu count=22 bbox=[2,-10,8,-4]
runs: {y:-4,x:6..7} {y:-5,x:6..8} {y:-6,x:4..8} {y:-7,x:6..8} {y:-8..-10,x:2..4}
```
`(6,-7)` 落在 `y=-7, x=6..8` 这一段内 ✓。
离线复核 `src/ai/world.mjs tileResource(55013,6,-7)` → `"RuRuRuRu"` ✓
（顺带确认 `(6,-8)` = `null`，即矿机下方不是矿——和方案一致，矿机只占 1 格没有问题）。

---

## B. 几何自洽（✗ 严重问题）

先把规则本身验一遍，避免误判：

**belt-rules 在实机上重新对拍：140 对相邻带子，0 处不符。**

```
$ debug_items {region:[-40,-45,40,10]}   → 16 条路径
按 beltExit(prev.code-1, prev.r) 预测下游格，与实际 path 的下一格比对：
live belt pairs: 140  mismatches: 0
```

规则可信（`src/ai/belt-rules.mjs:36-59`）。下面用它逐条判定方案。

### B-1. 4 个转角 code 是否等于 `solveTurn` 的解

| 格子 | 方案要求的 entry→exit | `solveTurn` 实际解 | 方案声称 | 判定 |
|---|---|---|---|---|
| `(7,-14)` | bottom→right | `{r:0, rv:2}` → **code 3** | code 3 | ✓ |
| `(12,-14)` | left→**top** | `{r:90, rv:1}` → code 2 | code 2 | ✗ **entry/exit 本身错了**（应为 left→bottom，code 3） |
| `(12,-3)` | **bottom**→left | `{r:0, rv:1}` → code 2 | code 2 | ✗ **entry/exit 本身错了**（应为 top→left，r180 code 3） |
| `(2,-3)` | right→bottom | `{r:270, rv:1}` → **code 2** | 表里写 "r270 rv2 **code 3**" | ✗ **表与自身 layout 冲突**（layout 写 code 2 是对的，表写错了） |

即：4 个转角里有 3 个的几何前提是错的。

### B-2. 相邻带子的出口/入口是否真的对上

逐对检查（`beltExit(i)` 的方向必须指向 `i+1` 的格子，且 `i+1` 的 `beltEntry` 必须是反方向）：

```
=== PLAN x=12 column as written ===
  BROKEN [12,-14] exit top -> [12,-15]  next [12,-13] entry bottom need bottom
  BROKEN [12,-13] exit top -> [12,-14]  next [12,-12] entry bottom need bottom
  ... （连续 11 处）
  BROKEN [12,-4]  exit top -> [12,-5]   next [12,-3]  entry bottom need bottom
  chain BROKEN belts=12
```

**根因：`r=0 code=1` 是 entry=bottom / exit=top**，即货朝 `-y`（`y` 变小）走。
方案从 `(12,-14)` 走到 `(12,-3)`，`y` 是从 -14 **增大**到 -3，方向是 `+y`（bottom）。
带子朝向和行进方向完全相反。

后果链条：
- `(12,-14)` code2 出口 top → `(12,-15)`（空格）→ **槽1 的货到这里就掉地上**
- `(12,-13)..(12,-4)` 全部朝向 hub 的反方向
- `(12,-3)` entry=bottom 意味着它期待从 `(12,-2)` 来货，而 `(12,-2)` 是空格

y=-3 横排本身是**对的**（10 条 `r=270 code=1`，entry=right / exit=left，逐对相接连通）：

```
=== PLAN y=-3 row as written ===  chain CONNECTED belts=10
```

所以错误精确定位在 `x=12` 竖列（12 条）+ `(12,-3)` 转角，共 13 个实体。

### B-3. 切割机槽0/槽1 的出口方向（✓ 方案说对了）

上游源码逐行核对：

- `recon/upstream-full/src/js/game/buildings/cutter.js:116-121`
  ```js
  entity.components.ItemEjector.setSlots([
      { pos: new Vector(0, 0), direction: enumDirection.top },
      { pos: new Vector(1, 0), direction: enumDirection.top },
  ]);
  ```
  两槽都朝局部 `top`，r=0 时世界出口 = `(x,y-1)` 与 `(x+1,y-1)`。方案 `(6,-13)` → `(6,-14)`/`(7,-14)` ✓

- 入口：`cutter.js:94-104`，`pos(0,0) direction bottom filter:"shape"`。
  按 `item_acceptor.js:105-132`（`desiredDirection = inverted(fromLocalDirection)`），
  等价于"货以 `top` 方向喷入 `(6,-13)`"，即上游带子必须在 `(6,-12)` 且出口 top ✓
  ——方案 `(6,-12) r=0 code=1` 正确。

- 槽位内容：`shape_definition_manager.js:92-106`
  ```js
  const rightSide = definition.cloneFilteredByQuadrants([2, 3]);
  const leftSide  = definition.cloneFilteredByQuadrants([0, 1]);
  return [registerOrReturnHandle(rightSide), registerOrReturnHandle(leftSide)];
  ```
  返回数组下标 0 → 槽0 `(0,0)`，下标 1 → 槽1 `(1,0)`。
  `shape_definition.js:40-45`：quadrant 0=tr、1=br、2=bl、3=tl ⇒ `[2,3]`=左半、`[0,1]`=右半。
  对 `RuRuRuRu`：槽0 = `----RuRu`，槽1 = `RuRu----` ✓

**方案的风险 1（槽位分配）确实成立，已用源码确认。**

顺带解释方案的一处措辞问题：它说"货从切割机**下方**喷入"。几何上出口是 `y-1`
（屏幕上更靠上），方向名是 `top`。方向名对，"下方"这个说法是反的——不影响执行。

### B-4. `(7,-14)` 的入口会不会被切割机抢走（任务点名的疑虑，✓ 不是问题）

不会。`belt_path.js:206-259` 的判定是：
```js
const beltAcceptingDirection = targetStaticComp.localDirectionToWorld(enumDirection.top);
if (ejectSlotWsDirection === beltAcceptingDirection) { ...接受... }
```
即带子**只认一个入射方向**，由 `rotation` 唯一决定。`(7,-14)` 取 `r=0`，只接受"以 top 方向喷入"
的货，来源唯一：`(7,-13)` 切割机第二格的槽1 ejector。`(6,-14)` 是另一条独立带子，
由 `(6,-13)` 槽0 ejector 供料，两者不竞争。

`(6,-14) r=0 code=1` 出口 top → `(6,-15)` trash，trash 四边全收（`trash.js:74-92`）✓

---

## C. 逻辑漏洞（✗ `(2,-3)` 不是 hub 入口）

`world_info` 实测：
```json
{"seed":55013, "hub":{"x":-2,"y":-2,"w":4,"h":4,"rotation":0,"uid":10000}}
```

用 `src/ai/op-templates.mjs hubEntriesWorld([-2,-2])`（与 `hub.js:76-84` 同源）算出 16 个入口：

```
top    -2,-3 / -1,-3 /  0,-3 /  1,-3     (带子需朝下喷入)
bottom -2, 2 / -1, 2 /  0, 2 /  1, 2
left   -3,-2 / -3,-1 / -3, 0 / -3, 1
right   2,-2 /  2,-1 /  2, 0 /  2, 1     (带子需朝左喷入 hub 格 (1,y))
is (2,-3) an entry? false
```

**实机旁证：** hub 顶排当前已经在用，而且就是 `y=-3` 这一行：

```
$ debug_items {region:[-40,-45,40,10]}
path cells=1  boundAcceptor="yes"   -1,-3
path cells=4  boundAcceptor="yes"   -2,-3
path ... -> 1,-3  boundAcceptor="yes"
```
（`(-2,-3)` `r180 code1` 出口 bottom 进 `(-2,-2)`；`(-1,-3)` `r270 code2` 出口 bottom 进 `(-1,-2)`）

`(2,-3)` 与 hub 4×4 只是**对角相邻**（`(2,-3)` 的邻居里没有 hub 格）：
`(1,-3)`、`(3,-3)`、`(2,-2)`、`(2,-4)` —— 唯一的联系是 `(2,-2)`，而 `(2,-2)` 是空格。

所以方案第 7 步 `(2,-3) 转角向下喷进 hub` **是错的**。`(2,-3)` 出口 bottom 只会把货喷到
`(2,-2)` 这块空地上。**缺一条带子 `(2,-2)`**，它应当 `entry=top, exit=left`：

```
solveTurn('top','left') = {rotation:180, rotationVariant:2} → code 3
```

加上 `(2,-2) r180 code3` 之后，链路才闭合（已验证，见 §D 的 FIX-1b）。

同一错误也出现在 §通道 第 41 行："`y=-3, x=2`：空（hub 顶部入口）"——`(2,-3)` 不是顶部入口，
`(-2..1,-3)` 才是。

---

## D. 有没有更简单的方案（有，短得多）

### D-1. 在原布局上做最小修补（保留 43 实体布局，只改朝向 + 补 1 格）

改 13 个 + 加 1 个：

| 格子 | 原方案 | 改为 | 理由 |
|---|---|---|---|
| `(12,-14)` | r90 code2 | **r90 code3** | entry left → exit **bottom** |
| `(12,-13)`…`(12,-4)` 共 10 条 | r0 code1 | **r180 code1** | entry top → exit bottom（向下行） |
| `(12,-3)` | r0 code2 | **r180 code3** | entry top → exit left |
| `(2,-2)` | 不存在 | **新增 r180 code3** | 接 `(2,-3)` 的出口，喷进 hub `(1,-2)` |

程序化复核（用 `beltEntry`/`beltExit` 逐对相接连通）：

```
=== FIX-1 (cutter 6,-13; x=12 down; y=-3; then 2,-3 down; 2,-2 left) ===
  last [2,-2] entry top exit left
 => CONNECTED
```

### D-2. 推荐：砍掉整个 x=12 绕行（18 个实体，只有方案宣称 43 的 42%）

方案绕到 `x=12` 是因为它把切割机固定在了 `(6,-13)`（为了凑 `(6,-7)` 那格矿）。
但 `(6,-4)` 也是钌矿（`tileResource(55013,6,-4)` = `"RuRuRuRu"`，`resources` 的 `y=-4, x=6..7` 段），
把矿机/切割机整体上移 7 格，就能在 `x=8` 直接下去，**省掉 x=12 的 11 格竖列**。

```
矿机    (6,-4)  r=0                       ← RuRuRuRu，实测 free
带子    (6,-5)  r=0   code=1
切割机  (6,-6)  r=0                       → 占 (6,-6)(7,-6)
  槽0 → (6,-7)  带子 r=0 code=1 → trash (6,-8)
  槽1 → (7,-7)  带子 r=0 code=3           ← entry bottom, exit right
带子    (8,-7)  r=90  code=3              ← entry left, exit bottom（转向下）
带子    (8,-6)  r=180 code=1
带子    (8,-5)  r=180 code=1
带子    (8,-4)  r=180 code=1
带子    (8,-3)  r=180 code=1
带子    (8,-2)  r=180 code=3              ← entry top, exit left
带子    (7,-2)  r=270 code=1
带子    (6,-2)  r=270 code=1
带子    (5,-2)  r=270 code=1
带子    (4,-2)  r=270 code=1
带子    (3,-2)  r=270 code=1
带子    (2,-2)  r=270 code=1              ← 直行，出口 left 喷进 hub 格 (1,-2)
```

- 实体：1 矿机 + 1 切割机 + 1 trash + 15 带子 = **18**
- 占位：19 格逐一核对，**0 冲突**
- 连通性：程序化逐对复核 → `CONNECTED`，末格 `exit=left` 正好对准 hub 右列入口

```
=== FIX-2 (miner 6,-4; cutter 6,-6; x=8 down to -2; y=-2 left; 2,-2 straight) ===
  last [2,-2] entry right exit left
 => CONNECTED
```

注意 `y=-2` 横排完全没有占用（`x=2..12` 全 free），hub 右列 `(2,-2..1)` 也没有任何带子，
不会和现有产线抢。

---

## E. 其余错误（不致命，但都应该改）

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| 1 | §关键转角 表第 4 行 | `(2,-3) solveTurn('right','bottom')` 写成 "r270 rv2 **code 3**"。实际 `solveTurn` 返回 `{rotation:270, rotationVariant:1}` → **code 2**；同一份文档的 layout 第 78 行写的是 code=2。**表与 layout 自相矛盾** | 本地跑 `solveTurn` |
| 2 | §理论产能 | "切割后每个输出 0.2/s" **错 2 倍**。切割是 1 进 2 出（`process_CUTTER` 对每个非空定义都 push 一件），**每个输出槽的速率 = 输入速率**，不是一半 | `systems/item_processor.js:367-388`；`config.js:102` `cutter:1/4` × belt 2 = 0.5 charges/s |
| 3 | 同上 | 因而 70 个 = **175 秒**，不是 350 秒。矿机 0.4/s 是瓶颈（`config.js:151` belt/5），切割机 0.5/s 吃不完，升级等级本轮全 0（`goal.upgrade_levels` = `{belt:1,miner:0,processors:0,painting:0}`，miner 倍率 1.0） | `obs.goal` |
| 4 | §实体统计 | "带子 40 / 合计 43" **算错**。按它自己的 layout 逐格数：`(6,-8..-12)`=5、`(6,-14)`=1、`(7..11,-14)`=5、`x=12` 列=12、`y=-3` 行=10 ⇒ **33 条带子，合计 36**（含切割机占 2 格共 37 格）。40/43 高估 7 | 脚本逐格计数 |
| 5 | §几何规则 下方的"三组实机校准（铜线）"表 | **2/3 行与本存档对不上**：表中 `(-1,-13) r90 code3` —— 实测该格是**空的**（`obs` 无实体）；表中 `(-1,-3) r180 code1` —— 实测是 `r270 code2`。只有 `(-8,-13) r0 code3` 对得上。规则本身没错（140/140 实机对拍通过），但**引用证据是错的**，"100% 吻合"这句话在本存档上不成立 | `obs` 全量 |
| 6 | §通道 | "`x=6, y=-20..-3`：**13/13** 空" —— 该区间是 **18** 格不是 13 格。结论（空）正确，计数错误 | 占位脚本 |
| 7 | §回滚 | "所有新实体 uid > **10901**（当前 nextUid）" —— 只读 RPC 拿不到 `nextUid`（`status`/`obs`/`world_info` 都不返回），**无法验证**；且实测现存实体最大 uid = **10223**（`nextUid ≥ 10224`），与 10901 相差 678。若真实值是 10224，`uid > 10901` 的筛选会**漏掉全部新实体**，回滚失效。执行前必须先读到 nextUid（或改用"放置返回的 entity_uid 白名单"） | `obs` 全量 |
| 8 | §执行顺序 | 用 `place` 连放直线时，`place` 会走 `computeOptimalDirectionAndRotationVariantAtTile` 按邻居自动定 rv；且每次放置都会触发 `updateSurroundingBeltPlacement` 重算**周围一圈**带子的 rv（`systems/belt.js:63`）。如果先贴转角、后补直线，转角可能被后续放置覆写。**必须"先直线、后转角、转角最后贴"**（方案写的顺序是对的），并且转角一律走 `paste_blueprint`（`bridge:2463-2490` 的 `performImmutableOperation` 才会屏蔽重算） | 源码 |

### 关于"`place` 放不出指定 rv"的说法（✓ 已确认）

`src/mod/shapez-ai-bridge.js:1561`：
```js
place: { fields: new Set(["building", "x", "y", "r", "variant"]) },
```
**`place` 根本没有 `rotation_variant` 参数**，只能让 `placeOne` 按邻居推导（`:1471-1500`）；
只有 `paste_blueprint` 会传 `info.rotationVariant` 覆盖。方案的第 5 条限制**成立**。

---

## 逐项结论汇总

| 验证项 | 结论 |
|---|---|
| A. 全部格子占用（37 格） | ✓ **0 冲突** |
| A. `(6,-7)` 是钌矿 | ✓ `RuRuRuRu`（RPC + 离线双证） |
| A. `x=6/7/12` 三条通道"全空" | ✓ 结论对（但 x=6 的格数写错，见 E-6） |
| B. 4 个转角的 code | ✗ **3/4 错**（2 个 entry/exit 前提错，1 个表内自相矛盾） |
| B. 相邻带子入口/出口对接 | ✗ **x=12 竖列 11 处断链** |
| B. 切割机槽0/槽1 出口方向 | ✓ 源码确认（`cutter.js:116-121`） |
| B. 槽1 = `RuRu----` | ✓ 源码确认（`shape_definition_manager.js:92-106`） |
| B-4. `(7,-14)` 入口被切割机抢 | ✓ 不成立，带子只认单一入射方向 |
| C. `(2,-3)` 是 hub 入口 | ✗ **不是**，缺 `(2,-2)` 一格 |
| C. hub 顶部入口 = `y=-3` | ✓ 实机 `boundAcceptor="yes"` ×3 佐证 |
| D. 有更短方案 | ✓ 18 实体 vs 36，见 §D-2 |
| E. 产能 0.2/s / 350 秒 | ✗ 应为 0.4/s / 175 秒 |
| E. 实体数 43 | ✗ 应为 36 |
| E. 回滚 uid 阈值 10901 | ? 无法验证，且有失效风险 |

## 执行建议

1. **不要按 L4-PLAN-A.md 的坐标执行。**
2. 优先采用 §D-2 的 18 实体方案（更短、少 18 格、避开现有 balancer 群 `x=8..11,y=-9` 附近）。
3. 若坚持原布局，按 §D-1 改 13 格 + 补 `(2,-2)`。
4. 无论哪种，**执行前先确认 `nextUid`**（或记录放置返回的 `entity_uid` 作为回滚白名单），否则回滚会失灵。
5. 落盘后用 `debug_items` 检查两点：末格路径的 `boundAcceptor` 必须是 hub（不是 `null`），
   且 `(7,-14)` 所属路径的 `cells` 必须从切割机一路连到 `(2,-2)`。
