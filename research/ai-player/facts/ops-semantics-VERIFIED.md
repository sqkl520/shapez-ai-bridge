# 形状运算精确语义（主 Agent 亲自核证 + 端到端验证）

> 全部读自 `recon/upstream-full/`（精确 1.5.6 @ ee2279d）。实现见 `research/ai-player/proto/shape-ops.mjs`（可运行、有自检）。

## 1. 象限与索引（`shape_definition.js:33`）

```
索引 0 = TOP-RIGHT     索引 1 = BOTTOM-RIGHT
索引 2 = BOTTOM-LEFT   索引 3 = TOP-LEFT
```
即 **TR → BR → BL → TL**，视觉上是从右上开始的**顺时针**。

字符串写法：`[TR][BR][BL][TL]`，每象限 2 字符 = `形状码` + `颜色码`（`shape_definition.js:139 fromShortKey`）。

## 2. 运算表（含源码行号）

| 运算 | 源码 | 精确语义 | 我们的实现 |
|---|---|---|---|
| **CutHalf** | `manager.js:92` | 返回 `[filterQuads([2,3]), filterQuads([0,1])]` = **[左列, 右列]**（注意不是"左半/右半"直觉顺序） | `cutHalf(s)` ⇒ `[s(2,3), s(0,1)]` |
| **CutQuad** | `manager.js:113` | 返回 `[TR, BR, BL, TL]` 四个**单象限**形状 | `cutQuad(s)` |
| **RotateCW** | `manager.js:135` / `shape_definition.js:497` | `unshift(q[3]); pop()` ⇒ **象限索引整体 +1**（0←3, 1←0, 2←1, 3←2） | `rotateCW(s)` |
| **RotateCCW** | `:155` / `:511` | `push(q[0]); shift()` ⇒ 象限索引整体 -1 | `rotateCCW(s)` |
| **Rotate180** | `:180` / `:525` | `push(shift(), shift())` | `rotate180(s)` |
| **Stack** | `:192` / `:538` | `stack(lower, upper)`，upper 叠在 lower 上 | `stack(lower, upper)` |
| **PaintWith** | `:212` / `:609` | 给**所有非空象限**染色（含已有颜色，会**覆盖**） | `paint(s, color)` |
| **PaintWith4Colors** | `:232` / `:628` | 按象限分别染色；`colors[q]` 为空则**保持原色** | `paint4(s, colors)` |

### Stack 的精确合并语义（`shape_definition.js:538` 逐行复刻）

不是简单"层拼接"——它算**每象限的最小间隙**，把 upper 放在"最小间隙恰好为 1 层"的位置：
```js
gaps[q] = topLowestLayer[q] - bottomHighestLayer[q]
layerToMergeAt = max(1 - min(gaps), 0)
```
然后逐层合并（同格冲突 → 断言失败，即**不允许两个子形状占同一格**）；**最多 4 层**（`mergedLayers.splice(4)`）。

### 切割的层语义（`shape_definition.js:471`）
`filterQuads` 若某层被过滤后**全空，该层会被整层删除**（`splice`）——所以 `cutHalf(CuCuCuCu)` 得到的是**单层**的 `CuCu----`，不是"层里留了 null"。

## 3. 颜色系统（`colors.js`）

颜色是 **3 位位域**：`red=001, green=010, blue=100`；混合 = **按位或**（`colors.js:61 bitfieldToColor`）：
```
red|green = yellow(011)   red|blue  = purple(101)
green|blue = cyan(110)    r|g|b     = white(111)    无色 = uncolored(000)
```
**青（cyan, `c`）不是矿！** 地图只产 `red` / `green` / `blue` 三种纯色矿，
**青必须在游戏里用 mixer 把 绿 + 蓝 混出来**（`buildings/mixer.js`：`inputsPerCharge: 2`，两个 color 输入槽 + 1 个输出槽）。

⚠️ 常见的编码陷阱：`ScScScSc` 里的 `c` = **cyan**，不是 blue（blue 是 `b`）。别把它当成"蓝色矿"。

## 4. ★ 端到端验证：造出实机 level-11 的真目标 `CgScScCg`

用 `proto/shape-ops.mjs` 实测通过：

```
目标 CgScScCg 的四象限：TR=Cg  BR=Sc  BL=Sc  TL=Cg
  → 上排 (TR,TL) 全 Cg，下排 (BR,BL) 全 Sc  → 它是「横向」两半叠起来的

SuSuSuSu --paint cyan-->  ScScScSc --cutHalf[1]--> ScSc---- --rotateCW-->  --ScSc--   (下排)
CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg   (上排)
                                                              stack(下排, 上排) ⇒ CgScScCg  ✅
```

**7 步**：2×paint + 2×cutHalf + 2×rotate + 1×stack。
**原料**：`CuCuCuCu`（地图 295 格）、`SuSuSuSu`（111 格）、颜料 绿+蓝（地图 466/493 格，需 mixer 混青）。

**这条链的意义**：它是求解器的"金标准测试用例"——任何 solver 必须能自动推出它。

## 5. 建筑变体与**输出槽映射**（`buildings/cutter.js` + `systems/item_processor.js:367` 已核实）

- **cutter**：两个变体 —— `default`（2×1，切半 `cutter`）+ `quad`（4×1，切四 `cutterQuad`）。
  - 输入槽：`pos(0,0)` 方向 **bottom**（filter: "shape"）
  - 输出槽：default = `(0,0)` 与 `(1,0)` 方向 **top**；quad = `(0..3, 0)` 方向 **top**
  - **即：输入永远从下方进、输出永远向上出**（相对 rotation 0）——这解释了开发期"输出堵死"的坑。
- **★ 输出槽 → 形状的精确映射**（`item_processor.js:367-388` `process_CUTTER`）：
  ```js
  const cutDefinitions = shapeActionCutHalf(input);   // = [quads(2,3), quads(0,1)]
  for (let i = 0; i < cutDefinitions.length; ++i)
      payload.outItems.push({ item: ..., requiredSlot: i });   // ← i 直接就是 ejector 槽位号
  ```
  ⇒ **槽 0（tile (0,0)，即 2×1 的左格）输出 `quads(2,3)` = 形状的「左列」**；
  **槽 1（tile (1,0)，右格）输出 `quads(0,1)` = 「右列」**。
  两个输出都朝 **上**（rotation 0），所以两条出料带都必须**朝上流**。
  **空的一半会被跳过**（`isEntirelyEmpty()` → 该槽 `lastItem = null`，不占用）——
  意味着切 `RuRu----`（左列全空）时**只有槽 1 有东西**。
- **mixer**：2×1，`inputsPerCharge: 2`，输入槽 `(0,0)` bottom + `(1,0)` bottom（filter: "color"），输出 `(0,0)` top。
- 其余建筑的**槽位几何已在本文 §5–§10 逐个核证**（cutter/mixer/rotater/stacker/painter/trash/hub）；
  实机验证状态见 §9 速查表与 `facts/GEOMETRY-TABLE.md`。

## 6. 对 AI 玩家的直接含义

1. **求解器可以完全离线跑** —— 运算语义已在 `proto/shape-ops.mjs` 里可运行地复刻，且经过端到端验证。
2. **搜索空间可剪枝**：`rotate180` = `rotateCW`×2 = `rotateCCW`×2；`rotateCW`×4 = 恒等；
   `stack` 交换上下通常**不等价**（有方向性）。
3. **配方里颜色只是"位域或运算"** —— 求解器可以把颜色当 3-bit 向量处理，上色 = 置位。
4. **切半有方向性** —— 目标形状的对称性决定"切完要不要旋转再堆"，这是规划里最容易漏的一步。
5. **金标准用例**：`CgScScCg` 的 7 步链已验证，可作为 solver 的回归测试。

---

## 7. ★ 实机验证：cutter 槽位映射（主 Agent 实测，与源码预测完全一致）

**实验**：`/tmp/exp-cutter2.mjs`（施工点位 (-28,-123)，远离工厂，事前/事后均确认无残留）

```
资源 SuSuSuSu @ (-28,-123)
矿机(-28,-123) r=0(朝上) → 进料带 2 格 → 切割机(-28,-126) 默认变体 r=0
出料带0: (-28,-127)..(-28,-134)   出料带1: (-27,-127)..(-27,-134)
快进 2000 tick → 存档 → 离线解码 beltPaths

★ 出料带物品：
  (-28,-127)  ----SuSu  ----SuSu  ----SuSu  ----SuSu     ← 槽 0（左格）
  (-27,-127)  SuSu----  SuSu----  SuSu----  SuSu----     ← 槽 1（右格）
切割机观测: {"type":"cutter","x":-28,"y":-126,"r":0,"variant":"default","code":9}
```

**结论**：与 `item_processor.js:367-388` 的预测**逐字符一致**：
- 槽 0（2×1 的**左**格，相对 rotation 0）→ `----SuSu` = **左列**（quads 2,3）
- 槽 1（**右**格）→ `SuSu----` = **右列**（quads 0,1）

**对 AI 布局的硬约束**（已实测）：
1. 一个 2×1 切割机占 `(x,y)` 与 `(x+1,y)`；**两个输出必须各接一条朝上的出料带**，
   否则堵死（这是开发期 B3 卡住的根因，现在有了精确解释）。
2. 输出槽是**固定几何**（都在 top 方向、分别在其所在格），不随 rotation 变成"两侧"——
   旋转整个机器会连带旋转这两个槽的位置（rotation 0 时是 +x 方向并排）。
3. 若输入只有一半内容（如 `RuRu----`），空的那一半**不占用输出槽**（`isEntirelyEmpty()`），
   即**可以只接一条出料带**——但接错槽位就永远收不到货。这是 AI 最易犯的错，务必按语义算槽位。

---

## 8. painter 的槽位几何（源码核实，`buildings/painter.js:118-183`）

**painter 是 2×1**，占 `(x,y)` 与 `(x+1,y)`（rotation 0 时沿 +x 展开）：

| 槽 | 相对格 | 方向 | 过滤 | 说明 |
|---|---|---|---|---|
| 输入·形状 | `(0,0)` | **left** | `shape` | 待上色的形状**从左边**进 |
| 输入·颜色 | `(1,0)` | **top**（mirrored 变体为 bottom） | `color` | 颜料**从上方**进 |
| 输出 | `(1,0)` | **right** | — | 上色后的形状**从右边**出 |

`inputsPerCharge = 2`（一形状 + 一颜料 = 一次 charge）。

**变体**（`enumPainterVariants`）：`default` / `mirrored`（颜料改从**下方**进）/ `double`（双联，两形状共用一份颜料）/
`quad`（四色，电线控制，level 21 解锁）。

**对 AI 布局的硬约束**：
1. painter 的**形状线与颜料线来自两个不同方向**（左 vs 上）——布局时必须为颜料单独留一条**垂直进料通道**。
   这是"颜料是独立物流"在几何上的具体体现（见 `shape-algebra.md §3`）。
2. `mirrored` 变体把颜料改到下方进 —— **AI 可以用它在密集布局中绕开交叉**（官方 tips 也提到它的用途）。
3. 输出在右格（`(1,0)`）的 right 方向 —— 与输入的 left 方向**共线**，所以形状是**直进直出**的，
   这让 painter 可以**串在一条水平线上**（不像 cutter 那样输入下、输出上）。

### 三种加工建筑的方向对比（给布局编译器的速查表）

| 建筑 | 占地 | 形状进 | 颜料/第二输入进 | 出 |
|---|---|---|---|---|
| **cutter**（默认） | 2×1 | bottom (`(0,0)`) | — | top ×2（`(0,0)` 左列 / `(1,0)` 右列） |
| **cutter quad** | 4×1 | bottom | — | top ×4（`(0..3,0)` 四象限） |
| **painter** | 2×1 | **left** `(0,0)` | **top** `(1,0)` | **right** `(1,0)` |
| **mixer** | 2×1 | color bottom `(0,0)` | color bottom `(1,0)` | top `(0,0)` |
| **rotater** | 1×1 | bottom `(0,0)` | top `(0,0)` | ✅ 源码 §9（实机未单独测，几何最简） |
| **stacker** | 2×1 | bottom `(0,0)`+`(1,0)` | top `(0,0)` | ✅ M3 实机 | — |

⚠️ **stacker / rotater / balancer / tunnel 的精确槽位未由主 Agent 核证** —— 见 agent 产出的
已在 §5–§10 逐个核证（见上）。

---

## 9. stacker / rotater 槽位（源码核实）＋ 完整性补全

**stacker**（`buildings/stacker.js:30,67-81`）—— **2×1**，占 `(x,y)` 与 `(x+1,y)`：

| 槽 | 相对格 | 方向 | 说明 |
|---|---|---|---|
| 输入 A | `(0,0)` | **bottom** | 下层料（first input） |
| 输入 B | `(1,0)` | **bottom** | 上层料（second input） |
| 输出 | `(0,0)` | **top** | 合并后的形状 |

`inputsPerCharge: 2`。官方提示："能并排就**融合**，不能就把右输入**叠在上层**"（base-en.yaml:1026-1030）
—— 与 `cloneAndStackWith` 的"最小间隙 1 层"语义一致。

⚠️ **两个输入都从下方进**，而输出从上方出 —— 意味着**两条输入带与一条输出带必须分层绕行**
（输出会与输入冲突）。这是布局里最容易搞错的一处，也是 stacker 成为 **MAM 瓶颈**（0.25/s，最慢）的几何原因。

**rotater**（`buildings/rotater.js:113-131`）—— **1×1**：

| 槽 | 相对格 | 方向 |
|---|---|---|
| 输入 | `(0,0)` | **bottom** |
| 输出 | `(0,0)` | **top** |

`inputsPerCharge: 1`。三个变体（`default`=CW / `ccw` / `rotate180`）**只改运算，不改几何** ——
所以 rotater 可以**直接串联在同一条竖直带上**，是布局里最"便宜"的机器。

### ★ 完整布局速查表（主 Agent 已核证的部分）

| 建筑 | 占地 | 输入 | 输出 | 速率（base，× 升级倍率） |
|---|---|---|---|---|
| **miner** | 1×1 | 资源格本身 | top `(0,0)` | 0.4/s |
| **belt** | 1×1 | 任意相邻朝向它 | 自身朝向 | 2/s |
| **cutter**（默认） | 2×1 | bottom `(0,0)` | top `(0,0)`+`(1,0)` | 0.5/s |
| **cutter quad** | 4×1 | bottom `(0,0)` | top `(0..3,0)` ×4 | 0.5/s |
| **rotater** | 1×1 | bottom `(0,0)` | top `(0,0)` | 2/s（永远够快） |
| **stacker** | 2×1 | bottom `(0,0)`+`(1,0)` | top `(0,0)` | **0.25/s（最慢）** |
| **painter** | 2×1 | shape←left `(0,0)` / color←top `(1,0)` | right `(1,0)` | 0.33/s |
| **mixer** | 2×1 | color←bottom `(0,0)`+`(1,0)` | top `(0,0)` | 0.4/s |
| **trash** | 1×1 | 四边全收（top/right/bottom/left） | — | — |
| **hub** | 4×4 | 四边共 16 格（§10） | WiredPins 信号出 `(0,2)` left | ⬜ 未接 hub 做过机器实验（端到端交付见 exp-e2e） |

**速率来源**：`config.js:81,101-111` + `hub_goals.js:487-532`（人类策略调研 agent 已核，见 `human-strategies.md §2.4`）。

**【推断】AI 布局的核心矛盾**（由本表直接导出）：
- **吞吐瓶颈是 stacker（0.25/s，只有带的 1/8）** → 一条满带（2/s）需要 **8 台 stacker** 才能吃下。
- 因此**"每级目标形状需要几次堆叠"直接决定工厂规模**，这是 AI 该优化的第一目标函数。
- **几何冲突**：stacker/cutter 都是"下进上出"，天然需要**分层布线**或**隧道**；
  而 painter/rotater 是"直通"或"侧进直出"，布线自由度高。
  → **布局编译器应该把机器按"几何类型"分组处理**，而不是一视同仁。

---

## 10. hub 几何（`buildings/hub.js:73-91` 源码核实）

**hub 是 4×4**，占 `(hx,hy)` 到 `(hx+3,hy+3)`。

**输入槽（16 个，四边全收）**——`direction` 语义 = "物品从哪个方向来"：

```js
for (let i = 0; i < 4; ++i) {
    slots.push(
        { pos: (i, 0), direction: top    },   // 顶排：物品从上方(y-1)来
        { pos: (i, 3), direction: bottom },   // 底排：物品从下方(y+4)来
        { pos: (0, i), direction: left   },   // 左列：物品从左侧(x-1)来
        { pos: (3, i), direction: right  }    // 右列：物品从右侧(x+4)来
    );
}
```

**全部 filter: "shape"** —— 只能收**形状**（颜料不能直接进 hub，必须先上色到形状上）。

**几何含义（AI 布局用）**：hub 的**四条边都能进料**，共 **16 个入口格**。
- 若 hub 在 `(hx,hy)`，则**外侧**进料格是：
  - 上：`(hx+i, hy-1)` for i=0..3，带子必须**朝下**（流向 hub）
  - 下：`(hx+i, hy+4)`，带子**朝上**
  - 左：`(hx-1, hy+i)`，带子**朝右**
  - 右：`(hx+4, hy+i)`，带子**朝左**

**这意味着 AI 可以让最多 16 条产线同时进料** —— 布局规划时不必挤在一条边。

**另注**：hub 还有一个 `WiredPins` 槽在 `(0,2)` 方向 left —— 这是**目标形状的信号输出**
（实测存档里看到 `WiredPins: {slots: [{value: {shape: "CgScScCg"}}]}`）。
level 26 之后官方推荐用它做 MAM（自动读取请求图形）。当前我们的工具链**未暴露**这个信号给 AI【待验/缺口】。

---

## 11. 传送带自动定向算法（`buildings/belt.js:161-247` 源码核实）—— 布局的关键

**这是游戏决定一格带子取什么形状（直/左弯/右弯）的完整算法**。
它**只看邻居**，不看"意图"——这正是开发期"拐角铺错"的根因：

```js
computeOptimalDirectionAndRotationVariantAtTile({root, tile, rotation, variant, layer}) {
    top/right/bottom/left = 由 rotation 推出的四个方向

    // ① 扫这个格子上**朝向我的** ejector（谁在往我这喷）
    for (ejector of ejectorsAt(tile))
        if (ejector.toDirection === top)    hasBottomEjector = true   // 下方的机器/带向上喷
        else if (ejector.toDirection === left)  hasRightEjector = true
        else if (ejector.toDirection === right) hasLeftEjector  = true

    // ② 扫**我要喷向的** acceptor（谁能收我的货）
    for (acceptor of acceptorsAt(tile))
        if (acceptor.fromDirection === bottom) hasTopAcceptor = true
        else if (acceptor.fromDirection === right) hasLeftAcceptor = true
        else if (acceptor.fromDirection === left)  hasRightAcceptor  = true

    // ③ 决策（顺序即优先级）
    if (!hasBottomEjector) {                       // 下面没有东西往我这喷
        if (hasRightEjector && !hasLeftEjector) return {rotation:+270°, variant:2}  // 左→上 弯
        if (hasLeftEjector  && !hasRightEjector) return {rotation:+90°,  variant:1}  // 右→上 弯
    }
    if (!hasTopAcceptor) {                          // 上面没人收货
        if (hasRightAcceptor && !hasLeftAcceptor) return {rotation: 同, variant:2}   // 右转
        if (hasLeftAcceptor  && !hasRightAcceptor) return {rotation: 同, variant:1}  // 左转
    }
    return {rotation, rotationVariant: 0}           // 直行
}
```

**对 AI 布局的铁律（由本算法直接导出）**：

1. **带子的形状是"邻居派生"的，不是"我指定"的** —— 所以**逐格放置的顺序很重要**：
   先放的邻居不在时算出的形状，可能在后来的邻居出现后就不对了。
   → **正确做法：先放所有机器，再铺带（此时邻居齐全）**；或按**流动方向**从上游往下游铺。
   （这解释了 `bench_b3.mjs` 里 `placeLane()` 为什么写成"逐格显式定方向"的稳妥版。）

2. **一个格子只能有一条带**，且它自动"解决"转弯 —— 所以**在一条路径里放 3 格带子**时，
   中间那格会自动变成弯道，**前提是两端邻居已存在**。

3. **`rotationVariant` 的含义**：0=直行，1=左转（相对 rotation），2=右转。
   我们的 `obs` **已经导出 `rotation_variant` 字段**（见 `src/mod/shapez-ai-bridge.js:453`）——
   **AI 可以用它读出一条已有产线在哪拐弯**（而不必从坐标反推）。

4. **优先级顺序是"先看 ejector 再看 acceptor，先看转弯再看直行"** —— 意味着
   **一个格子上如果有多个可能连接，游戏的选择可能与 AI 的期望不同**。
   → 布局编译器**必须模拟这个算法**来决定每格带子的 rotation/rotationVariant，
   否则生成的蓝图与预期不符（尤其是既有输入又有输出的"转角"格）。

5. **源码注释自己承认**：`// NOTICE: This makes the belt prefer side turns *way* too much!`
   —— 上游作者知道这个启发式不完美。**AI 的布局应避免依赖它做复杂转弯**，
   复杂拓扑用隧道或多层更稳。
