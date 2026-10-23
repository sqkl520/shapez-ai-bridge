# 形状代数（主 Agent 亲自核证，v1）

> 本文件的每一条都由主 Agent 在 `recon/upstream-full/`（精确 1.5.6 @ ee2279d）里读过源码确认。
> 证据等级：【观测】= 源码实读；【实测】= 本地脚本跑出来的数据。

## 1. 形状的字符串编码（short key）【观测】

来源：`recon/upstream-full/src/js/game/shape_definition.js:139` `ShapeDefinition.fromShortKey(key)`

**格式**：`<8字符>` 或 `<8字符>:<8字符>`（多层，`:` 分隔；`layers` 从**下到上**）

**每个 8 字符层**：4 个 quadrant，每个占 **2 字符** = `形状码` + `颜色码`，顺序固定：

```
quadrant 索引 0 = TOP-RIGHT     (文本第 0-1 字符)
quadrant 索引 1 = BOTTOM-RIGHT  (文本第 2-3 字符)
quadrant 索引 2 = BOTTOM-LEFT   (文本第 4-5 字符)
quadrant 索引 3 = TOP-LEFT      (文本第 6-7 字符)
```

**方向是顺时针**（从右上开始）——源码 `shape_definition.js:33-38`：
```js
export const TOP_RIGHT = 0, BOTTOM_RIGHT = 1, BOTTOM_LEFT = 2, TOP_LEFT = 3;
// Order is Q1 (tr), Q2(br), Q3(bl), Q4(tl)
```

**形状码**（大写，`shape_definition.js:50`）：
| 码 | 形状 | enumSubShape |
|---|---|---|
| `R` | 方形 | rect |
| `C` | 圆形 | circle |
| `S` | 星形 | star |
| `W` | 风车 | windmill |
| `-` | **空**（该 quadrant 无内容） | — |

**颜色码**（小写，`colors.js:18`）：
| 码 | 颜色 |
|---|---|
| `u` | 无色（uncolored） |
| `r` `g` `b` | 红 / 绿 / 蓝 |
| `y` `p` `c` | 黄（红+绿）/ 紫（红+蓝）/ 青（蓝+绿） |
| `w` | 白（红+绿+蓝） |

**解析规则**（`fromShortKey`）：形状码命中则**必须**有合法颜色码；形状码是 `-` 则该 quadrant = `null`（空）。

## 2. 实测样本（本地 level-11 存档）【实测】

```
CuCuCuCu  = 四象限全是 圆形-无色      → "圆"
CgCgCgCg  = 四象限全是 圆形-绿色      → "绿圆"
RuRu----  = TR/BR 是 方形-无色, BL/TL 空 → 右半（竖切的一半）
RuRuSuSu  = TR/BR 方形-无色, BL/TL 星形-无色
CgScScCg  = TR 圆-绿, BR 星-青, BL 星-青, TL 圆-绿   ← level-11 目标
```

**验证**：`CgScScCg` 的 TR 与 TL 都是 Cg、BR 与 BL 都是 Sc —— 关于**竖直轴**对称。
即：`CgScScCg` = 左半 `?` + 右半 `?`。按顺时针顺序写出来是 `[Cg, Sc, Sc, Cg]`。

## 3. 资源图（真实地图，3002 格）【实测】

`research/ai-player/facts/live/resources.json` 统计出 **16 种**资源形状：

| 形状 | 格数 | 读法 |
|---|---|---|
| `RuRuRuRu` | 576 | 纯方形 |
| `blue` | 493 | **纯色矿（颜料）** |
| `green` | 466 | 纯色矿 |
| `red` | 452 | 纯色矿 |
| `CuCuCuCu` | 295 | 纯圆 |
| `RuRuSuSu` | 149 | 右半方形 + 左半星形 |
| `RuRuCuCu` | 125 | 右半方形 + 左半圆形 |
| `SuSuSuSu` | 111 | 纯星 |
| `CuCuSuSu` | 67 | |
| `CuCuRuRu` | 60 | |
| `RuWuSuRu` | 41 | 四象限全不同 |
| `CuRuRuRu` | 40 | |
| `RuCuCuRu` | 37 | |
| `RuCuRuRu` | 34 | |
| `SuSuCuCu` | 33 | |
| `SuSuCuRu` | 23 | |

**关键结论（对求解器极重要）**：
- 地图天然提供 **Ru / Cu / Su / W** 四种 sub-shape 的**混合**形状，以及 **red/green/blue 三种颜料**。
- **没有** `ScScScSc`（星-青）这种纯矿 —— 目标里的 `Sc`（星-青）必须**用 Star 矿 + 蓝色颜料加工**得到。
- 注意 `blue`/`green`/`red` 是**纯色物品**（不是形状），说明颜料是独立物流。
- 所以：**配方必须包含"上色"步骤，且颜料需要单独的物流线**。

## 4. 运算（待补：需读 item_processor.js 确认精确语义）

已确认存在的方法名（`shape_definition_manager.js`）：
`shapeActionCutHalf` / `shapeActionCutQuad` / `shapeActionRotateCW` / `shapeActionRotateCCW` /
`shapeActionStack` / `shapeActionPaintWith` / `shapeActionPaintWith4Colors` / `shapeActionPaintWith2`(?)

⚠️ **尚未核证**（留给专用 agent，见 `research/ai-player/facts/ops-semantics.md`）：
- `CutHalf` 是横切还是竖切？两个输出的顺序？
- `Stack(a,b)` 谁在上？
- `PaintWith` 是给整个形状上色还是只给无色 quadrant？
- `RotateCW` 的 quadrant 置换（应是把 TR←TL←BL←BR 循环）

## 5. 对"AI 玩家方案"的直接含义

1. **AI 必须能读写这个字符串编码** —— 这是它与游戏沟通形状的唯一方式（`goal.requirement.shape`、`hub.stored_shapes` 的 key）。编码规则已在本文档，可离线实现。
2. **求解器的输入端**：目标形状字符串 + 地图资源表（本文档 §3）。
3. **求解器的输出端**：一个 DAG，其叶子是地图上真有的形状，内部节点是运算，根是目标。
4. **颜料是独立物流** —— 配方求解不能只考虑形状，还要考虑"颜料从哪来"，这是 layout 层的事。
5. **`CgScScCg` 对 AI 的意义**：它需要 圆-绿(右) + 星-青(左)，即需要：星矿 → 上蓝 → 切成半 → 与 圆矿→上绿→切成半 → 堆叠。这是一条**典型的 4-5 步链**，适合作为 solver 的第一个目标案例。
