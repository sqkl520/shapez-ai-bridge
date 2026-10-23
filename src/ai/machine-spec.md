# shapez 1.5.6 机器规格表（machine-spec）

> 交付物 2/2（机器可读版：`src/ai/machine-spec.json`）。布局编译器（P1–P8）的静态数据底座。
> 纯离线规格检索：权威源码 `recon/upstream-full/src/js/game/`（commit `ee2279d`，精确对应 1.5.6）。
> 本文所有路径相对于仓库根 `D:/Projects/rea/Project work/shapez`。
> **本次派发（第 2 次）已完成**：59 码全量机械对拍 + 8 个指定变体逐字段全核 + `notes`/`rateMeta` 全部引用行号复核。发现并修正 3 处错误（见 §4）。

---

## 0. 证据等级定义（本文所有表格均按此标注）

| 标记 | 含义 | 允许的出处 |
|---|---|---|
| 【实机】 | 从 1.5.6 实机桥接会话提取，已与真实游戏行为对拍 | `research/ai-player/facts/building-codes-live.json`（M1b/M2a）、`facts/MILESTONE-M3-stacker-verified.md`、`MILESTONE-M4-*.md`、`facts/RV-FIX-verified.md`、`facts/live/world-full.json`（真实存档 dump）、`facts/GEOMETRY-TABLE.md`、`facts/ops-semantics-VERIFIED.md` |
| 【源码】 | 仅由上游源码读出（文件:行号），未在实机验证 | `recon/upstream-full/src/js/game/**/*.js` |
| 【内嵌表】 | 本仓库已固化的常量表（可能与源码版本或解读有偏差） | `src/ai/belt-rules.mjs`、`src/ai/op-templates.mjs`（`ALL_TEMPLATES`/`MACHINE_CODES`/`UNLOCK_LEVEL_FALLBACK`） |
| 【未验证】 | 源码中找不到确定答案，或证据互相冲突且无法裁决 | — |

裁决优先级：**实机观测 > 上游源码（含 `recon/bundle.pretty.js` 二次比对）> 内嵌表/文档**。冲突一律进入 §4「矛盾清单」。

**注意【实机】的两种强度，本文严格区分**：
- **实机-流动**：真实产线上跑过、产物逐字符比对过（只有 belt / miner / cutter-default / rotater / stacker / painter-default / trash 及其 code）。
- **实机-存在性**：`world-full.json` / `building-codes-live.json` 里有真实实例，证明 code↔(building,variant,rv) 映射与建筑确实存在，但**槽位几何未在产线上单独跟踪**。这类只能给 code 背书，不能给槽位背书。

---

## 1. 概述与方法

### 1.1 code 是怎么来的（唯一生成路径）

shapez 的 `code` **就是** `internalId`，二者数值恒等。链路（`building_codes.js:43-58` + `meta_building_registry.js:36-47`）：

```
MetaXxxBuilding.static getAllVariantCombinations()   ← 手写静态数组（每建筑一个）
   → registerBuildingVariant(combination.internalId, meta, variant||"default", rotationVariant||0)
   → gBuildingVariants[code] = { metaClass, metaInstance, variant, rotationVariant, tileSize }
   → buildBuildingCodeCache(): hash = "buildingId/variant/rotationVariant" → code
   → getCodeFromBuildingData(meta, variant, rotationVariant)  // 反查
```

关键推论（编译器必须遵守）：
1. `variant` 缺省 `"default"`（`meta_building.js:10` `defaultBuildingVariant = "default"`），`rotationVariant` 缺省 `0`。所以只有 belt / underground_belt / wire 显式写了 `rotationVariant`（其余建筑靠缺省 0）。
2. `tileSize` 由 `new meta().getDimensions(variant)` 求得（`building_codes.js:56`）；未覆写 `getDimensions` 的建筑默认 **1×1**（`meta_building.js:48-50`）。
3. code **非连续、非按建筑顺序**。1–64 中只用 59 个，缺 **41, 56, 57, 58, 59**（1.5.6 无任何 `getAllVariantCombinations` 赋值，历史/保留号）。**禁止假设 code↔下标连续。**
4. `variant` 字符串是 enum 的**值**不是键 —— balancer 的两个反向变体真值是 `"merger-inverse"` / `"splitter-inverse"`（带连字符），不是驼峰键名。详见 §4 矛盾 C1（本次已修 JSON）。

### 1.2 槽位是怎么来的

- **静态阶段**：`MetaBuilding.setupEntityComponents(entity)` → `new ItemAcceptorComponent({slots:[...]})` / `new ItemEjectorComponent({slots:[...]})` / `new WiredPinsComponent({slots:[...]})`。
- **变体阶段**：`updateVariants(entity, rotationVariant, variant)` 用 `setSlots([...])` 覆写（cutter/painter/balancer/rotater/underground_belt/wire/virtual_processor/logic_gate/transistor 都走这里）。
- 本文的槽位 = **两阶段合成后的最终值**，按 `(building, variant, rv)` 分别取。多数建筑 `setupEntityComponents` 与 `updateVariants` 写同一套值（冗余但一致，已逐一核对）。
- **只有 tunnel 类需要按 rv 分槽**：`underground_belt`（rv0 sender / rv1 receiver）、`wire`（rv0..3 形状不同但无物品槽）。其余建筑所有 code 共用一套 rv=0 槽位。

### 1.3 坐标系与方向语义（编译器读表的唯一解释规则）

| 概念 | 语义 | 出处 |
|---|---|---|
| `tile` | **rotation=0 局部系**偏移，相对建筑左上 origin（origin 含 `[0,0]`） | `components/static_map_entity.js:183-190`（`localToTile` = local.rotate + origin）、`:196-198`（`worldToLocalTile` 逆运算） |
| 世界格 | `world = rotateLocal(tile, rotation) + origin`；`rotateFastMultipleOf90`: **90 → (-y, x)** | `core/vector.js:503-520` |
| `dir`（acceptor） | 货**从该方位进入**（该方位=来向） | `components/item_acceptor.js:110-114` 注释 + `enumInvertedDirections` |
| `dir`（ejector） | 货**朝该方位喷出** | `item_acceptor.js:114` 取反匹配 |
| `dir`（pin） | 引脚**位于建筑的该侧** | 与物品槽同一方向词表 |
| 方位↔角度 | top=0, right=90, bottom=180, left=270 | `core/vector.js:30-45` |
| 方位↔向量 | top=[0,-1], right=[1,0], bottom=[0,1], left=[-1,0]（**y 向下为正**） | `core/vector.js:685-690` |
| acceptor 取反表 | top↔bottom, left↔right | `core/vector.js:20-25` |

匹配规则（编译器接线判据）：ejector 的 `toDirection` 经 `enumInvertedDirections` 取反后，必须等于 acceptor 的 `direction`，且 `pos` 相同（`item_acceptor.js:116-133`）。

### 1.4 覆盖计数（修正后）

| 指标 | 数值 | 备注 |
|---|---|---|
| 注册建筑（building key） | **28** | `meta_building_registry.js` 注册数 |
| 变体（variant 记录） | **49** | JSON `buildings.*.variants` 计数 |
| code 记录 | **59** | 含 rv 维度（49 变体展开成 59 个 code） |
| 含**物品槽**（acceptor/ejector）的变体 | **29** | 其中 23 个有 acceptor |
| 含 **pin**（WiredPins）的变体 | **22** | 电线层 + storage/reader/hub/painter-quad |
| 含任一槽位的变体 | **45** | 零槽位仅 4 个：wire×2 / wire_tunnel / block（源码确实无槽，见 §2.10） |
| 与实机 code 记录对拍 | **60/60** | `building-codes-live.json` 全部 60 条记录、15 组 (building,variant,rv)→code 全命中（本次重跑复核） |
| 与 `bundle.pretty.js` 对拍 | **59/59** | internalId 集合完全一致，0 差、0 重（本次重跑复核） |

---

## 2. 逐建筑规格（28 节）

### 2.0 code 总表（59 行，全量机械对拍通过）

「证据」列：**流动** = 实机产线跟踪过；**存在** = 实机 dump 里有真实实例；**源码** = 仅源码。

| code | building | variant | rv | 占地 | 证据 | 备注 |
|---|---|---|---|---|---|---|
| 1 | belt | default | 0 | 1×1 | 流动 | 直带，出口局部 top |
| 2 | belt | default | 1 | 1×1 | 流动 | 左弯，出口局部 left |
| 3 | belt | default | 2 | 1×1 | 流动 | 右弯，出口局部 right |
| 4 | balancer | default | 0 | 2×1 | 存在 | 2进2出，world-full 475 台 |
| 5 | balancer | merger | 0 | 1×1 | 源码 | bottom+right → top |
| 6 | balancer | **merger-inverse** | 0 | 1×1 | 源码 | bottom+left → top（§4 C1 已修） |
| 7 | miner | default | 0 | 1×1 | 流动 | |
| 8 | miner | chainable | 0 | 1×1 | 流动* | *几何同 default，链式行为未跟踪 |
| 9 | cutter | default | 0 | 2×1 | 流动 | |
| 10 | cutter | quad | 0 | 4×1 | 存在 | 四象限槽序未实机 |
| 11 | rotater | default | 0 | 1×1 | 流动 | CW |
| 12 | rotater | ccw | 0 | 1×1 | 流动 | |
| 13 | rotater | rotate180 | 0 | 1×1 | 流动 | |
| 14 | stacker | default | 0 | 2×1 | 流动 | M3 |
| 15 | mixer | default | 0 | 2×1 | 存在 | world-full 24 台 |
| 16 | painter | default | 0 | 2×1 | 流动 | M2a |
| 17 | painter | mirrored | 0 | 2×1 | 存在 | world-full 15 台 |
| 18 | painter | double | 0 | 2×2 | 存在 | 几何未单独跟踪 |
| 19 | painter | quad | 0 | 4×1 | 存在 | 需电线使能 |
| 20 | trash | default | 0 | 1×1 | 流动 | 四边全收 |
| 21 | storage | default | 0 | 2×2 | 源码 | |
| 22 | underground_belt | default | **0** | 1×1 | 存在 | **sender**（入口 bottom） |
| 23 | underground_belt | default | **1** | 1×1 | 存在 | **receiver**（出口 top） |
| 24 | underground_belt | tier2 | **0** | 1×1 | 源码 | sender，跨度 9 |
| 25 | underground_belt | tier2 | **1** | 1×1 | 源码 | receiver，跨度 9 |
| 26 | hub | default | 0 | 4×4 | 存在 | 16 入口 |
| 27 | wire | default | 0 | 1×1 | 源码 | forward |
| 28 | wire | default | 1 | 1×1 | 源码 | turn |
| 29 | wire | default | 2 | 1×1 | 源码 | split |
| 30 | wire | default | 3 | 1×1 | 源码 | cross |
| 31 | constant_signal | default | 0 | 1×1 | 源码 | |
| 32 | logic_gate | default | 0 | 1×1 | 源码 | AND |
| 33 | lever | default | 0 | 1×1 | 源码 | |
| 34 | logic_gate | not | 0 | 1×1 | 源码 | |
| 35 | logic_gate | xor | 0 | 1×1 | 源码 | |
| 36 | logic_gate | or | 0 | 1×1 | 源码 | |
| 37 | filter | default | 0 | 2×1 | 源码 | |
| 38 | transistor | default | 0 | 1×1 | 源码 | |
| 39 | wire_tunnel | default | 0 | 1×1 | 源码 | |
| 40 | display | default | 0 | 1×1 | 源码 | |
| **41** | — | — | — | — | — | **未使用** |
| 42 | virtual_processor | default | 0 | 1×1 | 源码 | 逻辑 cutter |
| 43 | analyzer | default | 0 | 1×1 | 源码 | |
| 44 | virtual_processor | rotater | 0 | 1×1 | 源码 | |
| 45 | virtual_processor | unstacker | 0 | 1×1 | 源码 | |
| 46 | comparator | default | 0 | 1×1 | 源码 | |
| 47 | balancer | splitter | 0 | 1×1 | 源码 | top+right |
| 48 | balancer | **splitter-inverse** | 0 | 1×1 | 源码 | top+left（§4 C1 已修） |
| 49 | reader | default | 0 | 1×1 | 源码 | 直通带 + 2 pin |
| 50 | virtual_processor | stacker | 0 | 1×1 | 源码 | |
| 51 | virtual_processor | painter | 0 | 1×1 | 源码 | |
| 52 | wire | second | 0 | 1×1 | 源码 | forward（第二套线） |
| 53 | wire | second | 1 | 1×1 | 源码 | turn |
| 54 | wire | second | 2 | 1×1 | 源码 | split |
| 55 | wire | second | 3 | 1×1 | 源码 | cross |
| **56–59** | — | — | — | — | — | **未使用** |
| 60 | transistor | mirrored | 0 | 1×1 | 源码 | slot1 left→right |
| 61 | item_producer | default | 0 | 1×1 | 源码 | 编辑器 |
| 62 | constant_producer | default | 0 | 1×1 | 源码 | 编辑器 |
| 63 | goal_acceptor | default | 0 | 1×1 | 源码 | 关卡目标接收器 |
| 64 | block | default | 0 | 1×1 | 源码 | 占位，无组件 |

> 「流动」判定基准：`building-codes-live.json` 实机提取的 15 组 (building,variant,rv)→code（60 条记录）+ M1b/M2a/M3/M4 里程碑。`world-full.json` 的 14 组 (type,variant,rv,code) 亦全部与源码一致（含 belt rv1=2/rv2=3、tunnel 22/23、painter 16/17、hub 26、balancer 4）。

---

### 2.1 belt（code 1/2/3）— 唯一 rv 有实机证据的建筑

`buildings/belt.js:25-42`(combos) · `:141-148`(updateVariants→Belt.direction) · `components/belt.js:9-36`(FAKE 槽) · `:79/:88/:92`(fake getter)

belt **没有** `ItemAcceptorComponent`/`ItemEjectorComponent`，靠 `BeltComponent` 暴露**假槽**参与接线（`components/belt.js:9-36`）：

| 假槽 | 值 | 出处 |
|---|---|---|
| `FAKE_BELT_ACCEPTOR_SLOT` | `(0,0)` **bottom**（三种 rv 都一样） | `components/belt.js:9-12` |
| `FAKE_BELT_EJECTOR_SLOT_BY_DIRECTION` | 按 `Belt.direction` 取 top/left/right 之一 | `components/belt.js:15-36` |
| `Belt.direction` ← `arrayBeltVariantToRotation[rv]` | rv0→top, rv1→**left**, rv2→**right** | `belt.js:12` + `:141-148` |

> **`BeltComponent.direction` 不在存档里 → 实机不可直读**（开放缺口 §6 G1）。编译器一律用 `rv` 推导。

**rv→code 与局部几何的唯一权威 = `src/ai/belt-rules.mjs`**（1906/1906 实机核验，禁止二次实现）：
- `beltCode(rv) = 1 + rv`（`belt-rules.mjs:58-59`）
- `EXIT_LOCAL = {0:"top", 1:"left", 2:"right"}`；入口恒局部 `bottom`（`:36-38`）
- 世界方向 = 局部方向按 rotation 旋转（`rotateLocal`, `:28-31`）
- 弯带的入/出是**垂直**关系，不是相反 —— **不可用 `OPP[exit]` 求入口**（`:33-35` 注释）

JSON 的 `buildings.belt.variants.default` 额外带 `beltVariants`（rv→{exitLocal,code}）与 `codeRule`。**注意**：JSON 里 belt 的 `acceptors/ejectors` 只写了 rv0 的一套（entry bottom / exit top）；rv1/rv2 的出口必须走 `beltVariants` 或 `belt-rules.mjs`，**不可**直接读 `ejectors[0].dir`。

autoroute：`belt.js:161-251` `computeOptimalDirectionAndRotationVariantAtTile`（形状由邻居派生；编译器**不需要**复现，蓝图显式携带 rv）。

`getIsReplaceable()` = true（`belt.js:68-70`）→ 只有 belt/wire 可被"替换"操作（约束 C1）。`getLayer()` 未覆写 → `regular`。`getDimensions` 未覆写 → 1×1（`meta_building.js:48-50`）。
**可旋转**（默认 `getIsRotateable()` true），有方向锁（`:53-55`），放置时自动转向（`:60-62`）。

### 2.2 miner（code 7 default / 8 chainable）— 【实机-流动】

`buildings/miner.js:24-34`(combos) · `:81-86`(ejector) · `:93-96`(chainable 标记) · 尺寸未覆写→1×1

| 项 | 值 |
|---|---|
| acceptors | **无**（不接线，开采所在格下方资源 `systems/miner.js:52-63`） |
| ejectors | `(0,0)` **top**（无 filter） |
| pins | 无 |
| processor | 无 `ItemProcessorComponent`（只有 `MinerComponent`） |

变体差异**仅** `MinerComponent.chainable`（`updateVariants:93-96`）：`chainable` 可链到 miner 的 acceptor……实际是「chainable miner 可接收上游 miner 的信号」。几何/槽位两者**完全相同**。
`getAvailableVariants`（`:57-63`）：解锁 `reward_miner_chainable`（L11）后**只返回 chainable**，即 default 变体在解锁后被隐藏 —— 编译器按 code 查表不受影响，但 UI 层面「能放的 miner 变体」会变（§5）。

### 2.3 cutter（code 9 default / 10 quad）— default【实机-流动】

`buildings/cutter.js:20-30`(combos) · `:37-46`(dims 2×1 / 4×1) · `:94-104`(acceptor) · `:116-131`(ejector，按 variant 分支)

| 变体 | 占地 | acceptor | ejector（槽序 = 输出象限序） |
|---|---|---|---|
| default (9) | 2×1 | `(0,0)` bottom `shape` | 槽0 `(0,0)` top / 槽1 `(1,0)` top |
| quad (10) | 4×1 | `(0,0)` bottom `shape` | 槽0..3 = `(0..3,0)` top |

processor `cutter`/`cutterQuad`，`inputsPerCharge=1`（`cutter.js:88-91`）。
**槽位↔象限映射**（`systems/item_processor.js:367-388` 用 `requiredSlot: i`，i = `cutHalf` 数组下标；quad 同理 `:393-416`）：
- `shapeActionCutHalf`（`shape_definition_manager.js:92-106`）返回数组顺序：`[0]=cloneFiltered([2,3])=左列`，`[1]=cloneFiltered([0,1])=右列`。槽号 i 直接映射 ejector 槽 i（`systems/item_processor.js:377-386` 的 `requiredSlot: i`）⇒ **槽0=(0,0)top→左列、槽1=(1,0)top→右列**，与实机 M1b 逐字符一致。
  ⚠ 上游变量名是反的：`rightSide = clone([2,3])` 实际装的是象限 2,3 = x=-1 = **左列**；`leftSide = clone([0,1])` 是**右列**（据 `arrayQuadrantIndexToOffset`，quads 0/1 在 x=+1，2/3 在 x=-1）。读源码时别信变量名，只信数组顺序。JSON `notes[7]` 写的是正确版本。
- `shapeActionCutQuad`（`:113-128`）返回 `[0,1,2,3]` = 象限索引序 = **TR, BR, BL, TL**（`shape_definition.js:36-45` `arrayQuadrantIndexToOffset`）。
- **空象限不占用输出槽**（`definition.isEntirelyEmpty()` → 跳过，`item_processor.js:378-381`）→ 求解器不能假设 quad cutter 四路都出货。

象限索引定义（`shape_definition.js:36-45`，`getHash` 按 0..3 序拼字符串 `:266-282`）：
`0=TR(+1,-1)`, `1=BR(+1,+1)`, `2=BL(-1,+1)`, `3=TL(-1,-1)`（y 向下，故 -1=上）。

### 2.4 rotater（code 11 default / 12 ccw / 13 rotate180）— 【实机-流动】

`buildings/rotater.js:26-40`(combos) · `:120-136`(ejector/acceptor) · `:145-162`(processor type 按 variant)

三变体**几何完全相同**：1×1，acceptor `(0,0)` bottom `shape`，ejector `(0,0)` top。差异仅在 `ItemProcessor.type` = `rotater` / `rotaterCCW` / `rotater180`（`inputsPerCharge=1`, `:115-117`）。
`enumRotaterVariants = { ccw:"ccw", rotate180:"rotate180" }`（`:12`）—— 注意 default 无覆写 `getAvailableVariants`，靠 `MetaBuilding` 默认 + 各自 reward（L4/L7/L18）。

### 2.5 stacker（code 14）— 【实机-流动 M3】

`buildings/stacker.js:17-23`(combos) · `:30-32`(dims 2×1) · `:66-86`(ejector+acceptor)

| 项 | 值 |
|---|---|
| acceptors | 槽0 `(0,0)` bottom `shape` · 槽1 `(1,0)` bottom `shape` |
| ejector | `(0,0)` top |
| processor | `stacker`, `inputsPerCharge=2` |

**槽序语义（关键，编译器分层不能搞反）**：`payload.items` 就是 `inputSlots`（`systems/item_processor.js:298,310`），而 `inputSlots` 的键 = **匹配到的 acceptor 槽号**（`belt_path.js:334 tryTakeItem(item, matchingSlotIndex)`；`components/item_processor.js:124-141`）。`process_STACKER`（`systems/item_processor.js:461-463`）取 `get(0)=lower` / `get(1)=upper`。
⇒ **槽0 = 下层，槽1 = 上层**。M3 实机 `CuCuSuSu : RuRuCuCu` 印证。
（对照：`trash`/`hub`/`goal` 三种 type 走 `inputSlots.set(this.inputCount, ...)` 的特殊分支 `item_processor.js:126-133`，键是计数而非槽号。）

### 2.6 mixer（code 15）— 【实机-存在性】

`buildings/mixer.js:17-23`(combos) · `:26-28`(dims 2×1) · `:66-86`

acceptors `(0,0)` bottom `color` · `(1,0)` bottom `color`；ejector `(0,0)` top；processor `mixer`, `inputsPerCharge=2`。
几何与 stacker **同形**（2×1 双进一出），但 filter 是 `color` 而非 `shape`。混色=按位或（`colors.js:58-74` `enumColorMixingResults`，`bitfieldToColor`）。
【实机-存在性】：`world-full.json` 有 24 台 mixer code=15，但 `GEOMETRY-TABLE.md` 表1 标 ⬜ 未单独跑流动。

### 2.7 painter（code 16/17/18/19）— default【实机-流动 M2a】

`buildings/painter.js:25-43`(combos) · `:46-58`(dims) · `:118-142`(setup 基线) · `:150-293`(updateVariants 按 variant 覆写)

| 变体 | 占地 | acceptors | ejector | pins | processor / inputsPerCharge |
|---|---|---|---|---|---|
| default (16) | 2×1 | `(0,0)` left `shape` · `(1,0)` **top** `color` | `(1,0)` right | — | painter / 2 |
| mirrored (17) | 2×1 | `(0,0)` left `shape` · `(1,0)` **bottom** `color` | `(1,0)` right | — | painter / 2 |
| double (18) | 2×2 | `(0,0)` left `shape` · `(0,1)` left `shape` · `(1,0)` top `color` | `(1,0)` right | — | painterDouble / 3 |
| quad (19) | 4×1 | `(0,0)` left `shape` · `(0,0)(1,0)(2,0)(3,0)` bottom `color` | `(0,0)` top | `(0,0)..(3,0)` bottom **in** ×4 | painterQuad / 5 + `processingRequirement=painterQuad` |

- default↔mirrored 差异**只有**颜料入口 top↔bottom（`:167-171`），其余同。
- quad 会**添加** `WiredPinsComponent`（`:223-248`），四个引脚都是 `logicalAcceptor`（`in`）；且设了 `processingRequirement = enumItemProcessorRequirements.painterQuad`（`:283-284`）→ **必须通电才处理**（编译器 v1 不建模电线，故 quad painter 在 v1 排除）。
- double/quad 会走 `entity.removeComponent(WiredPinsComponent)`（`:156-158,188-190`）以保证 default/double 无 pin。
- `process_PAINTER_DOUBLE`（`systems/item_processor.js:527-551`）一次吃 3 件、**出 2 件**（两个 shape 各上一色）。

### 2.8 trash（code 20）— 【实机-流动】

`buildings/trash.js:18-24`(combos) · `:27-29`(**不可旋转**) · `:35-37`(1×1) · `:73-95`(四边 acceptor)

acceptors `(0,0)` top / right / bottom / left（**四个，无 filter**）；ejectors **无**；processor `trash`, `inputsPerCharge=1`。
`getIsRotateable() = false`（`:27-29`）→ 唯一性：`rotation` 恒 0，编译器可当固定朝向处理。
`getSpecialOverlayRenderMatrix(rotation)`（`:39`）存在但 `getIsRotateable=false` → 实际只有 rotation=0 生效（见 §4 C4 讨论）。

### 2.9 hub（code 26）— 与 goal_acceptor 必须区分

`buildings/hub.js:14-20`(combos) · `:23-25`(**4×4**) · `:31-33`(**不可旋转**) · `:44-46`(不可移除) · `:61-71`(pin) · `:76-90`(**16 入口由循环生成**)

16 入口由 `for i=0..3` 生成，JSON 已展开为具体槽（每边 4 个）：

| 侧 | 槽 | dir | filter |
|---|---|---|---|
| 上边 | `(0,0)(1,0)(2,0)(3,0)` | top | shape |
| 下边 | `(0,3)(1,3)(2,3)(3,3)` | bottom | shape |
| 左边 | `(0,0)(0,1)(0,2)(0,3)` | left | shape |
| 右边 | `(3,0)(3,1)(3,2)(3,3)` | right | shape |

- **全部 filter = "shape"** → 颜料/布尔不能直接进 hub（编译器接线判据）。
- 角落格（如 `(0,0)`）有**两个** acceptor 槽（top + left），`(3,3)` 同理（bottom + right）。JSON 保持源码 push 顺序（上4→下4→左4→右4），槽索引即该顺序。
- ejectors **无**；processor `hub`, `inputsPerCharge=1`（交付即计数）。
- pin `(0,2)` **left**，类型 `out`(`logicalEjector`) = **当前目标形状信号输出**（`systems/hub.js:37-40` 写 `pinsComp.slots[0].value`）。工具链未把它暴露给 AI（开放缺口 §6 G4）。
- `getSprite()`/`getBlueprintSprite()` 返回 null（自行渲染，`:35-42`）。
- `getIsRotateable()=false` + `getIsRemovable()=false` → 唯一不可动建筑，`origin` 即锚点；world-full 实测 hub 在 `(-2,-2)`，覆盖 `(-2..1, -2..1)`。

**hub vs goal_acceptor 的区别（编译器必须分开处理）**：见 §2.11 —— hub 是玩家可放置、4×4、16 入口、不可旋转不可移除、story 目标接收器；goal_acceptor 是编辑器/关卡目标实体，1×1、单入口、`getIsRemovable` 仅在 editor 模式 true。

### 2.10 underground_belt / balancer（多 rv / 多变体）

#### 2.10.1 underground_belt（code 22/23/24/25）— 【实机-存在性】，v1 排除

`buildings/underground_belt.js:43-66`(combos，**唯一显式写 rotationVariant 的 regular 建筑之一**) · `:15-18`(`arrayUndergroundRotationVariantToMode`) · `:23-26`(`enumUndergroundBeltVariantToTier`) · `:270-299`(`updateVariants`) · `:212-262`(配对搜索) · `core/config.js:90`(`undergroundBeltMaxTilesByTier:[5,9]`)

| rv | mode | acceptor | ejector |
|---|---|---|---|
| **0** | sender | `(0,0)` bottom（**无 filter**） | 无 |
| **1** | receiver | 无 | `(0,0)` top |

tier：`default`→0（跨度 **5**），`tier2`→1（跨度 **9**）。⇒ code 22/23 = T1 出/入，24/25 = T2 出/入。
JSON 用 `rotationVariantSlots["0"|"1"]` 按 rv 存槽（其余建筑用顶层 `acceptors/ejectors`）。
`getFlipOrientationAfterPlacement() = true`（`:72-74`）：放置时朝向翻到对面。
配对判据（`:212-262`）：**同 tier、同 rotation**，沿 `enumAngleToDirection[rotation]` 正方向搜索 ≤ 跨度格，找到对面 mode 的实体即连；中途撞到同 mode 的 sender 则放弃。
**实机核验（本次重跑）**：`world-full.json` 182 台隧道 = 91 sender(rv0,c22) + 91 receiver(rv1,c23)，按「同 r、沿 r 指向正方向」配对 **91/91 全中**，跨度分布 {2格:8, 3格:83}，**全部 ≤5**，无孤儿。spec 原记「同向、跨度均≤5」→ **实机为真**（我最初的 `r+180` 假设是错的，已按源码 212-262 更正检查方式）。
⚠ **v1 排除**（约束 C3）：跨格非局部连接，布局编译器的局部接线模型不覆盖。

#### 2.10.2 balancer 家族（code 4/5/6/47/48）

`buildings/balancer.js:34-57`(combos) · `:59-71`(dims) · `:176-260`(updateVariants 五分支) · `:117-133`(getAvailableVariants)

| code | variant（**真值**） | 占地 | acceptors | ejectors |
|---|---|---|---|---|
| 4 | `default` | 2×1 | `(0,0)bottom` `(1,0)bottom` | `(0,0)top` `(1,0)top` |
| 5 | `merger` | 1×1 | `(0,0)bottom` `(0,0)right` | `(0,0)top` |
| 6 | `merger-inverse` | 1×1 | `(0,0)bottom` `(0,0)left` | `(0,0)top` |
| 47 | `splitter` | 1×1 | `(0,0)bottom` | `(0,0)top` `(0,0)right` |
| 48 | `splitter-inverse` | 1×1 | `(0,0)bottom` | `(0,0)top` `(0,0)left` |

- **所有 acceptor/ejector 均无 filter**（`balancer.js` 各 slot 不带 `filter:` 字段）→ 物品/颜色都过。
- 共用 processor `balancer`, `inputsPerCharge=1`（`:151-157`）。
- 轮转输出：`nextOutputSlot++ % availableSlots`（`systems/item_processor.js:342-360`，`preferredSlot` 在 `:358`）→ **不是严格一一映射**，求解器不能假设固定分配。
- 附带 `BeltUnderlaysComponent`（渲染用，非接线，`:195-198` 等）。
- `getAvailableVariants`（`:117-133`）：`deterministic` 模式下 **default 与 merger 系列都不出现**，只剩 splitter 系列 —— 编译器若跑确定性/puzzle 模式需据此过滤（§5）。
- ⚠ 内嵌表 `src/ai/op-templates.mjs` 的 `ALL_TEMPLATES` **完全没有 balancer**（只有 16 个 op，见 §4 C5）。

### 2.11 goal_acceptor（code 63）

`buildings/goal_acceptor.js:16-22`(combos) · `:28-36`(`getIsRemovable` = **editor 模式才 true**) · `:42-54`(acceptor) · `:56-62`(processor `goal` + `GoalAcceptorComponent`)

acceptor `(0,0)` bottom `shape`；无 ejector、无 pin；1×1（未覆写 dims）。
`getIsUnlocked` 未覆写 → 恒 true（`meta_building.js:184-186`），但它是关卡实体、非玩家可放置建筑。
`config.js:94` `goalAcceptorItemsRequired: 12`（填满 12 件即交付）。
processor type 是 `goal`（≠ hub 的 `hub`）→ **`inputsPerCharge` 未设**（`goal_acceptor.js:56-59` 只传了 `processorType`），走 `inputSlots.set(inputCount)` 特殊分支。

---

## 2B. 其余建筑（11 个 regular 层 / 电线层，全部【源码】）

| 建筑 / code | 占地 | acceptors | ejectors | pins | 出处（`buildings/<f>.js`） |
|---|---|---|---|---|---|
| storage / 21 | 2×2 | `(0,1)bottom` `(1,1)bottom` | `(0,0)top` `(1,0)top` | `(1,1)right` **out** · `(0,1)left` **out** | `:20-26`(combos) `:13`(cap=5000) `:40-42`(dims) `:57-86` `:92-109`(pins) |
| reader / 49 | 1×1 | `(0,0)bottom` | `(0,0)top` | `(0,0)right` **out** · `(0,0)left` **out** | `:21-27` `:41-43` `:65-80`(pins) `:82-103`(accept/eject) `:104-111`(processor reader) |
| filter / 37 | 2×1 | `(0,0)bottom` | `(0,0)top` `(1,0)right` | `(0,0)left` **in** | `:18-24` `:38-40` `:64-72`(pin) `:75-101`(accept/eject) |
| display / 40 | 1×1 | — | — | `(0,0)bottom` **in** | `:14-20` `:34-36` `:46-59` |
| wire / 27-30, 52-55 | 1×1 | — | — | — | `:40-82`(combos) `:97-99`(dims) `:114-116`(**layer=wires**) `:122-124`(`getIsReplaceable`) `:11-16`(`arrayWireRotationVariantToType`) `:26-28`(`wireVariants`) |
| wire_tunnel / 39 | 1×1 | — | — | — | `:16-22` `:47-49`(**不可旋转**) `:51-58`(dims+layer) |
| constant_signal / 31 | 1×1 | — | — | `(0,0)top` **out** | `:17-23` `:37-40`(layer) `:58-70`(pin) |
| logic_gate / 32,34,35,36 | 1×1 | — | — | AND/XOR/OR: `(0,0)top`**out** `(0,0)left`**in** `(0,0)right`**in**；NOT: `(0,0)top`**out** `(0,0)bottom`**in** | `:44-62`(combos) `:113-136`(and/xor/or) `:137-156`(not) |
| lever / 33 | 1×1 | — | — | `(0,0)top` **out** | `:14-20` `:35-37` `:51-66` |
| transistor / 38,60 | 1×1 | — | — | default: `top`**out** `left`**in** `bottom`**in**；mirrored: `top` `right` `bottom` | `:25-36`(combos) `:73-78`(mirrored 改 slot[1] left→right) `:83-108`(pins) |
| analyzer / 43 | 1×1 | — | — | `(0,0)left`**out** `(0,0)right`**out** `(0,0)bottom`**in** | `:17-23` `:37-40`(layer) `:60-81` |
| comparator / 46 | 1×1 | — | — | `(0,0)top`**out** `(0,0)left`**in** `(0,0)right`**in** | `:14-20` `:34-37`(layer) `:53-74` |
| virtual_processor / 42,44,45,50,51 | 1×1 | — | — | cutter/unstacker(42,45): `left`**out** `right`**out** `bottom`**in**；rotater(44): `top`**out** `bottom`**in**；stacker/painter(50,51): `top`**out** `bottom`**in** `right`**in** | `:43-66`(combos) `:22-28`(`enumVariantToGate`) `:107-173`(pin 按 gateType 三分支) |
| item_producer / 61 | 1×1 | — | `(0,0)top` | `(0,0)bottom` **in** | `:13-21` `:35-52`(ejector+pin) |
| constant_producer / 62 | 1×1 | — | `(0,0)top` | — | `:16-24` `:42-50`(ejector) |
| block / 64 | 1×1 | — | — | — | `:12-19` `:38`(**空 setupEntityComponents**) |

**已核对（本次）**：pin 计数与源码逐一相等（`logic_gate` 源码 5 条 vs JSON 11 条、`virtual_processor` 源码 8 vs JSON 14、`transistor` 源码 3 vs JSON 6 —— 差值全部来自源码把 AND/XOR/OR、cutter/unstacker、stacker/painter **共用同一个 `setSlots` 块**，JSON 按变体复制展开，属预期，不是错误）。

### 2B.1 layer 归属（8 个 wires 层建筑，其余 regular）

`getLayer()` 覆写为 `"wires"` 的只有 8 个文件：`analyzer.js` / `comparator.js` / `constant_signal.js` / `logic_gate.js` / `transistor.js` / `virtual_processor.js` / `wire.js` / `wire_tunnel.js`。默认 `regular`（`meta_building.js:42-44`）。
⇒ JSON `notes[3]` 的清单**正确**；`display`/`lever`/`item_producer`/`constant_producer`/`block` 确无覆写 → regular。
⚠ `world-full.json` **只 dump regular 层**（2805 实体无一 layer=wires）⇒ 电线层建筑的存在性/槽位**完全没有实机凭据**，全部【源码】。

### 2B.2 pin type 语义

`enumPinSlotType = { logicalEjector, logicalAcceptor }`（`components/wired_pins.js:8-11`）。JSON `notes[2]` 的映射 `out = logicalEjector`（发信号）/ `in = logicalAcceptor`（收信号）**正确**，已逐建筑核对。

### 2B.3 storage / reader / filter 的 pin 行为（源码核证，非实机）

- storage：`pins[0]=(1,1)right` = 当前存放物品；`pins[1]=(0,1)left` = 满仓布尔（`systems/storage.js:55-58`，spec JSON 写 `systems/storage.js:50-52` → **行号偏 5 行**，见 §4 C6）。容量 5000（`buildings/storage.js:13`）。**无 ItemProcessor**（只有 `StorageComponent` `:88`）。同种同 hash 才可混存（`components/storage.js:51-58`）。
- reader：`pins[0]=(0,0)right` = 吞吐布尔（近 0.5s 有货）；`pins[1]=(0,0)left` = 最近物品（`systems/belt_reader.js:26-27`，spec JSON 写 `:26-28` → 差 1 行，可接受）。行为像带一样直通 bottom→top。
- filter：`pins[0]=(0,0)left` 收值；值 `== BOOL_TRUE` 或 `== 物品` → 走 top 放行，否则走 right 剔除（`systems/filter.js:52-72`）；**未接电 = 谁都不收**（`:54-58` 返回 false）。`filter.js:55` UI 速度取 `getBeltBaseSpeed`。

---

## 3. rateMeta / rates 表

### 3.1 权威公式（`core/config.js` + `hub_goals.js`，倍率 = 1.0 时的 base 值）

| 目标 | 公式 | 出处 | base |
|---|---|---|---|
| belt | `beltSpeedItemsPerSecond(2) × beltMult` | `config.js:81` + `hub_goals.js:487-492` | **2.0** |
| miner | `(beltSpeed/5) × minerMult` | `config.js:82,151` + `hub_goals.js:509-514` | **0.4** |
| underground_belt | `beltSpeed × beltMult` | `hub_goals.js:498-503` | **2.0** |
| balancer(default) | `beltSpeed × beltMult × 2` | `hub_goals.js:531-532` | **4.0** |
| balancer 1×1 变体 | `(base/2) × 1` | `balancer.js:96-109`（mult=1 for merger/splitter） | **2.0** |
| reader | `beltSpeed × beltMult` | `hub_goals.js:533-534` | **2.0** |
| cutter / cutterQuad | `beltSpeed × processorsMult × buildingSpeeds(1/4)` | `config.js:101-113,551-566` | **0.5** |
| rotater / CCW / 180 | `× buildingSpeeds(1/1)` | `config.js:103-105` | **2.0** |
| stacker | `× buildingSpeeds(1/8)` | `config.js:111` | **0.25**（最慢 → 工厂瓶颈） |
| painter | `beltSpeed × paintingMult × 1/6` | `config.js:106` + `hub_goals.js:536-548` | **0.3333** |
| painterDouble | `× 1/8` = 0.25 **charges/s**，每 charge 出 2 件 → **0.5 件/s** | `config.js:107` + `systems/item_processor.js:527-551` | 0.25 / 有效 0.5 |
| painterQuad | `× 1/2` | `config.js:108` | **1.0** |
| mixer | `beltSpeed × paintingMult × 1/5` | `config.js:110` | **0.4** |
| filter | 无 ItemProcessor；吞吐随带速 | `buildings/filter.js:55` | (2.0 近似) |
| trash / hub / goal | **`1e30`**（不限量） | `hub_goals.js:527-530` | `null`（∞） |
| storage | **无 ItemProcessor、无速率** | `buildings/storage.js:88` | `null` |

> `buildingSpeeds` 在 `config.js:101-113`（**不是 101-111**，spec JSON 原引 101-111 已更正为 101-113）。
> painterDouble 的 `formatItemsPerSecond(speed, true)`（`painter.js:81`）只影响 UI 文案（追加 "双件" 标签，`core/utils.js:535-543`），**不翻倍数值**。

### 3.2 升级倍率（**本次修正的算术**）

`fixedImprovements = [0.5, 0.5, 1, 1, 2, 1, 1]`（`modes/regular.js:80`，`tierHandle.improvement = fixedImprovements[i]` 在 `:248`）。
`upgradeImprovements[id] = 1 + Σ_{i < level} fixedImprovements[i]`（初始化 `hub_goals.js:58-62`，每购买累加一档 `hub_goals.js:358`）。

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| mult | 1 | 1.5 | 2 | **3** | 4 | 6 | 7 | 8 |

`rates` 表全部是 **mult = 1.0**（即 0 级）的值；运行时真实吞吐 = `base × 对应 upgradeImprovements[组]`。
组映射（`multiplierTargets`）：belt/miner/underground_belt/balancer/reader/filter → `belt`（miner 独立走 `miner`）；cutter/rotater/stacker → `processors`；painter/mixer → `painting`。

**liveWorldLevels（已修正）**：`world-full.json` 实测 `upgradeLevels = {belt:3, miner:3, processors:2, painting:1}` ⇒
`beltMult = 3`、`minerMult = 3`、`processorsMult = 2`、`paintingMult = 1.5`。
⇒ 该存档真实吞吐：belt **6 件/s**、miner **1.2 件/s**、cutter **1.0**、stacker **0.5**、painter/mixer **0.5/0.6**。

### 3.3 其他常量

| 常量 | 值 | 行号 |
|---|---|---|
| `maxBeltShapeBundleSize` | 20 | `config.js:77` |
| `itemSpacingOnBelts` | 0.63 | `config.js:86` |
| `wiresSpeedItemsPerSecond` | 6 | `config.js:88` |
| `undergroundBeltMaxTilesByTier` | [5, 9] | `config.js:90` |
| `readerAnalyzeIntervalSeconds` | 10 | `config.js:92` |
| `goalAcceptorItemsRequired` | 12 | `config.js:94` |
| `goalAcceptorsPerProducer` | 5 | `config.js:95` |
| `puzzleModeSpeed` | 3 | `config.js:96` |
| `throughputDoesNotMatter` 分支 | belt/隧道×3；processor×**60** | `hub_goals.js:489,500,511,523` |

---

## 4. 矛盾清单（三方：JSON ↔ 上游源码 ↔ facts/内嵌表）

### 4.1 本次（第 2 次派发）**发现并已修正**的 3 处

**C1 — balancer 两个反向变体的 variant 字符串错误【已改 JSON】**
- spec 原写：`variant: "mergerInverse"` / `"splitterInverse"`（用了 enum 的**键名**，驼峰）。
- 源码真值：`enumBalancerVariants = { mergerInverse: **"merger-inverse"**, splitterInverse: **"splitter-inverse"** }`（`buildings/balancer.js:14-19`）。`getAllVariantCombinations` 传的是 enum **成员**，`getCodeFromBuildingData` 用 `buildingId/variant/rotationVariant` 拼 hash（`building_codes.js:67-69`）⇒ 运行时字符串**必须**是带连字符的值。
- 二次佐证：`recon/bundle.pretty.js:10059,10061` = `mergerInverse: "merger-inverse"` / `splitterInverse: "splitter-inverse"`。
- 影响面：**任何按 variant 字符串查 code 的路径都会 miss**（`"balancer/mergerInverse/0"` ≠ 缓存里的 `"balancer/merger-inverse/0"`）。硬失败，不是显示问题。
- 已改：`codes[6].variant`、`codes[48].variant`、`buildings.balancer.variants` 的两个 key。改后 59 码对拍 **0 mismatch**（此前 2 处）。

**C2 — `rateMeta.upgradeLadder.liveWorldLevels` 算术错误【已改 JSON】**
- spec 原写：`{belt:3,miner:3,processors:2,painting:1} → beltMult=2.5, minerMult=2.5, processorsMult=2, paintingMult=1.5`。
- 源码真值：`mult = 1 + Σ_{i<level} fixedImprovements[i]`，`fixedImprovements=[0.5,0.5,1,1,2,1,1]`（`modes/regular.js:80`；`:248` 赋 improvement；初始化 `hub_goals.js:58-62`；每购买累加一档 `hub_goals.js:358`）。
  - level 3 → 1+0.5+0.5+1 = **3**（不是 2.5）；level 2 → **2**；level 1 → **1.5**。
- **自相矛盾证据**：同一份 JSON 的 `upgradeLadder.afterTiers` 已经写对（`[1,1.5,2,3,4,6,7,8]`），只有 `liveWorldLevels` 把 level3 写成 2.5（少算一档）。
- 影响面：若编译器按 2.5 算带宽，会对该存档**低估 17% 带速**（真实 6 件/s 被算成 5）。
- 已改：`liveWorldLevels`，并新增 `formula` / `correctionNote` 字段固化公式。

**C3 — belt 的 `source.lines` 行号越界【已改 JSON】**
- spec 原写 `components/belt.js:9-36 (fake 槽); 147-149 (方向)`。
- 源码真值：`components/belt.js` **只有 123 行** → `147-149` 不存在。`Belt.direction` 赋值实际在 **`buildings/belt.js:141-148`**（`updateVariants`）+ `belt.js:12`（`arrayBeltVariantToRotation = [top, left, right]`）。fake 槽 `9-36` 正确，getter 在 `:79/:88/:92`。
- 影响面：仅出处可追溯性，不影响数值。已改为正确行号。

### 4.2 曾疑为矛盾、经源码裁决为**一致**（8 项）

| 编号 | 疑点 | 裁决 |
|---|---|---|
| K1 | 隧道「同向、跨度均 ≤5」是否属实（我最初按 `r+180` 反向找，得 **0/91**） | 源码 `underground_belt.js:212-262` 的配对判据是 **同 rotation**（不是相反！`:232 staticComp.rotation === targetRotation`，`targetSenderRotation = rotation`）。按此重跑 `world-full.json`：**91/91 全中**，跨度 {2:8, 3:83} 全 ≤5。**facts 正确，我的假设错误。** |
| K2 | 4 个变体物品槽/pin **全空**：wire(default/second)、wire_tunnel、block —— 是否漏填？ | 逐个读源码：`wire.js:137-140` / `wire_tunnel.js:60-62` / `block.js:38` 的 `setupEntityComponents` **只挂非物品组件**（WireComponent / WireTunnelComponent / **空函数**）。确实无 acceptor/ejector/pin。**null 正确，无需补。** |
| K3 | balancer merger/splitter 变体不在 `building-codes-live.json` | 该文件只覆盖 level≤11 实机；`reward_merger`=L9、`reward_splitter`=L19，且 merger 在 deterministic 模式不可用 → **未解锁，非漏采**。`liveEvidence` 已说明。 |
| K4 | 缺号 41/56/57/58/59 | 本次机械枚举 1–64，恰缺这 5 个；`bundle.pretty.js` internalId 集合 59/59 一致，无差无重。**`codeTableSummary` 正确。** |
| K5 | pin 计数：JSON 11 vs 源码 5（logic_gate）、JSON 14 vs 源码 8（virtual_processor）、JSON 6 vs 源码 3（transistor） | 源码把 AND/XOR/OR、cutter/unstacker、stacker/painter **合并在同一个 `setSlots` 块**，JSON 按变体独立复制展开。逐变体核后**每个变体槽集都与源码分支一致**，非错误。 |
| K6 | `notes[7]` cutter「cutHalf 返回 [quads(2,3)=左列, quads(0,1)=右列]」 | 按 `arrayQuadrantIndexToOffset`（`shape_definition.js:40-45`：quads 0/1 在 x=+1，2/3 在 x=-1）+ M1b 实机（`RuRuRuRu → 槽0 ----RuRu 槽1 RuRu----`）三方对齐 —— **JSON 正确**。⚠ 上游变量名 `rightSide=clone([2,3])` 是**反的**（见 §2.3），读码只信数组顺序。 |
| K7 | `notes[8]` stacker 槽0=下层/槽1=上层 | `payload.items` 即 `inputSlots`，其键 = 匹配到的 acceptor 槽号（`belt_path.js:334` → `components/item_processor.js:124-141`）；`process_STACKER` 取 `get(0)=lower`/`get(1)=upper`（`systems/item_processor.js:461-463`）⇒ **正确**，并解释了 trash/hub/goal 为何不同（`:126-133` 用 inputCount 而非槽号）。 |
| K8 | `config.js` buildingSpeeds 行号（原引 101-111） | 实为 **101-113**。本文 §3 已更正（JSON 内 `notes`/`formulas` 仍写 101-111，属可追溯性偏差，数值无误）。 |

### 4.3 与 facts / 内嵌表的口径差异（未改 JSON，仅登记）

| 编号 | 冲突 | 裁决 |
|---|---|---|
| D1 | **`op-templates.mjs` 内嵌表完全没有 balancer**（16 op：mine/cut/cutQuad/rotate/rotateCCW/rotate180/paint/paintMirrored/mix/stack/trash/belt/mineChainable/paintDouble/paintQuad/hub） | 源码确有 5 个 balancer 变体（4/5/6/47/48）。JSON 更全、正确；内嵌表是 v1 故意收窄。`loadMachineSpec` 会把这些组合登记成 gap「machine-spec 里出现内嵌表没有的组合」。 |
| D2 | 内嵌表 `belt/default`、`hub/default` 的 code = `undefined`（`MACHINE_CODES` 无这两键） | belt 走 `beltCode(rv)=1+rv`（`belt-rules.mjs:58-59`），hub 实为 **26**（`hub.js:17`；world-full 实机 c26）。JSON 两者都填对，缺字段在内嵌表侧。 |
| D3 | 内嵌表 painterDouble/paintQuad `ratePerSec=0.33`，JSON `rates` 给 0.25 / 1.0 | 源码 `buildingSpeeds.painterDouble=1/8`、`painterQuad=1/2`（`config.js:107-108`）⇒ **JSON 正确**；内嵌表把 painter 的 1/6 复制过来了。`loadMachineSpec` 用 spec 覆盖内嵌 ratePerSec。 |
| D4 | `GEOMETRY-TABLE.md` 表1 对 cutter-quad / rotater / painter-mirrored / mixer / hub 标 **⬜ 未测** | 本 JSON 对应 `verifiedBy` 均写 `source-only`（rotater 有 `building-codes-live` 4 个 rotation 的 code 记录 → 存在性有凭据）。**口径一致，无夸大。** |
| D5 | 实机「流动」vs「存在性」分级：`building-codes-live.json` 60 条覆盖 15 组 (b,v,rv)→code，**全部 rotation_variant=0** | 严格「流动级」只有 belt/miner/cutter/cutter-quad/rotater×3/miner-chainable/stacker/painter/trash/mixer；其余为存在性。JSON `verifiedBy` 逐条核过。 |
| D6 | painter-quad 有 c19 但没跑过流动（需电线使能） | JSON `verifiedBy=source-only` + `liveEvidence` 说明。 |
| D7 | hub 的 pin `(0,2)left` 目标信号：`systems/hub.js:37-40` 确实写 `slots[0].value = 当前目标形状`，但工具链读不到 | 归入 §6 G4 缺口，非矛盾。 |
| D8 | `notes[0]` 引 `item_acceptor.js:110-135`，实际取反匹配在 `:114-133` | 近义、可接受，未改。 |

**抽验结论**：59 码全量机械对拍 + 28 建筑/49 变体槽位逐条核 + `notes`/`rateMeta` 全部行号复核，除 C1/C2/C3（**已改**）与 K8/D8（行号小偏差，数值无误）外，其余全部一致。**未发现需要驳回 facts 的情形。**

---

## 5. 编译器使用注意

1. **v1 只用 rv=0 机器**：`building-codes-live.json` 全部 60 条 `rotation_variant=0`，**非 belt 建筑的 rv 如何编码到 code 完全没有实机证据**（H2）。`op-templates.mjs:14-16` 已把「请求 rv≠0 直接抛结构化错误」写死。belt 是唯一例外（`beltCode(rv)=1+rv`，1906/1906 实机）。
   - 例外中的例外：`underground_belt`（22/23/24/25）与 `wire`（27-30/52-55）**必须按 rv 取 code**，但二者属 v1 排除范围（见 3.）。
2. **v1 加工机器朝向恒 r=0**（H3，plan §2.3 决策 D1）：本文所有 tile 都是 **rotation=0 局部系**。`rotateSlot()` 已实现并单测（世界槽位 = `rotateLocal(局部槽位, rotation)`），但旋转时 `origin` 位移**未实机验证**，v1 不开。
3. **underground_belt / wire 在 v1 排除范围**（约束 C3/C4）：隧道是跨格非局部连接；电线层 `world-full.json` 根本没 dump（2805 实体无一 `layer=wires`）⇒ 电线层建筑**零实机凭据**。
4. **`getIsReplaceable` 只有 belt 与 wire**（C1）：`belt.js:68-70`、`wire.js:122-124`。其余建筑均无此方法 ⇒「替换」类操作只能作用于这两种。
5. **`getIsRotateable()=false` 的建筑**（可当固定朝向，不必遍历 4 个 rotation）：`trash`（`trash.js:27-29`）、`hub`（`hub.js:31-33`）、`wire_tunnel`（`wire_tunnel.js:47-49`）。其余建筑默认可旋转（`meta_building.js` 默认 true）。
6. **`getAvailableVariants` 的运行时收缩**（按 code 查表不受影响，但「允许放置哪些建筑」会变）：
   - miner：解锁 `reward_miner_chainable`(L11) 后 **只剩 chainable**（`miner.js:57-63`）—— 注意是**替换**而非追加。
   - balancer：**deterministic 模式下 default 与 merger 都不出现**（`balancer.js:117-133`）。
   - painter：double 需 L17；quad 需 L20 **且** `gameMode.getSupportsWires()`（`painter.js:92-105`）。
   - cutter-quad L16；underground tier2 L13；rotater ccw=L7 / 180=L18。
7. **goal_acceptor 与 hub 的区别**：见 §2.9/§2.11 —— hub 4×4/16 入口/不可旋转不可移除/story 目标；goal_acceptor 1×1/单入口/`getIsRemovable` 仅 editor true（`goal_acceptor.js:28-36`），且 processor type 是 `goal` 不是 `hub`。
8. **按 code 查表，禁止假设连续**：59 码散在 1–64，缺 41/56/57/58/59；balancer-splitter=47、transistor-mirrored=60 这类跳号很多。
9. **`unlockLevel` 兜底常量**：**JSON 里没有 `unlockLevel` 字段**（实测 `grep -c unlockLevel = 0`）⇒ `op-templates.mjs:58-70` 的 `UNLOCK_LEVEL_FALLBACK` 生效，并被登记为 spec 缺口（NOTES G2）。
   真值出处：`modes/levels.js`（`STANDALONE_LEVELS`，`:164-366`）+ 各建筑 `getIsUnlocked` 的 `enumHubGoalRewards`。实测 reward→level：
   L1 cutter_and_trash · L3 balancer · L4 rotater · L5 tunnel · L6 painter · L7 rotater_ccw · L8 mixer · L9 merger · L10 stacker · L11 miner_chainable · L12 blueprints · L13 underground_belt_tier_2 · L14 belt_reader · L15 storage · L16 cutter_quad · L17 painter_double · L18 rotater_180 · L19 splitter · L20 wires_painter_and_levers · L21 filter · L22 constant_signal · L23 display · L24 logic_gates · L25 virtual_processing · L26 freeplay。
   ⚠ 兜底表把 belt/hub 记 `lv=1`、`paintMirrored=6`（mirrored 无独立 reward，随 painter L6），与 levels.js 无冲突。但严格说**「解锁」在完成第 k 关那一刻才授予**（`hub_goals.js` `onGoalCompleted` → `gainedRewards`），`isRewardUnlocked` 只读 `gainedRewards`（`:196-211`）⇒ 兜底常量是「第 k 关开始可用」的工程口径，比真实语义早半关。
10. **belt 的 rv→code 唯一权威 = `src/ai/belt-rules.mjs`**：若 JSON 与它冲突，一律以 belt-rules 为准（H1）。实测两者一致（1/2/3）。
11. **slot 匹配判据**：ejector `toDirection` 经 `enumInvertedDirections` 取反 == acceptor `direction` **且** tile 相同（`item_acceptor.js:116-133`）；再检查 `filter`。
12. **JSON `notes[]`（9 条）语义已逐条核过**：方向[0]、坐标系[1]、pins[2]、layer[3]、rotationVariantSlots[4]、unverified 分级[5]、checkGate[6]、cutterSlotOrder[7]、stackerSlotOrder[8] —— 除 D8 行号小偏差外全部正确。
13. **belt 的 JSON `acceptors/ejectors` 只描述 rv=0 的一套**（entry bottom / exit top）：rv1/rv2 的出口**必须**走 `beltVariants` 或 `belt-rules.mjs`，**不可**直接读 `ejectors[0].dir`（那是 top，与 rv1=left/rv2=right 不符）。这是最容易踩的坑。

---

## 6. 开放缺口（交主线程决策）

| 编号 | 缺口 | 现状 | 需要谁 |
|---|---|---|---|
| **G1** | **`BeltComponent.direction` 存档不可读**（序列化字段里没有 direction）⇒ 实机只能靠 rv 反推 | belt-rules 已用 rv 推导并 1906/1906 核验 | MOD-GAPS |
| **G2** | **非 belt 建筑的 rv 编码方向零实机证据**（`building-codes-live` 60 条全 rv=0）。tunnel 22↔23 / 24↔25 谁对应 sender 只有源码 + world-full 计数（91/91 同 rotation 配对）佐证 | v1 硬约束：只用 rv=0（H2） | 需实机补实验（放 rv=1 的 cutter/painter 看 code 是否变） |
| **G3** | **旋转时 `origin` 位移未实机验证**（`components/static_map_entity.js:127-140` 的 `getTileSpaceBounds` 在 90/270 会平移 origin） | v1 强制 r=0（H3）；`rotateSlot()` 已单测但未开 | 需实机放一台 r=90 的 cutter 验槽位 |
| **G4** | **hub 目标形状信号 pin `(0,2)left` 未暴露给 AI 工具链**（`systems/hub.js:37-40` 写了值，dump 读不到 `slots[i].value`） | 编译器只能靠 `goal` 字段拿目标形状 | MOD-GAPS |
| **G5** | **电线层建筑零实机凭据**（`world-full.json` 只 dump regular 层） | v1 排除 wire 族（C4） | 需切 layer 再 dump |
| **G6** | **JSON 缺 `unlockLevel` 字段** ⇒ 用兜底常量。是否把 §5.9 的 reward→level 映射固化进 JSON 待定 | 映射已备好可直接搬 | 主线程 |
| **G7** | **`stride=5`（隧道跨度）与 puzzle 模式 processor ×60** 是否进编译器常量 | §3.3 已列源码值 | 主线程 |
| **G8** | **balancer 轮转 `nextOutputSlot++ % slots` 不是固定映射** ⇒ 求解器若假设「槽0永远先出」会错 | 源码确证（`systems/item_processor.js:358`） | 主线程（v1 未含 balancer） |
| **G9** | **`getAvailableVariants` 运行时收缩**（deterministic 砍 balancer default/merger；miner 解锁 chainable 后隐藏 default）是否建模 | §5.6 已列全，v1 未用 | 主线程 |

---

## 7. 本次校验方法（可复现）

1. **code/variant/rv 全量对拍**：机械解析 28 个 `getAllVariantCombinations` 的 59 条组合，把 `enumXxxVariants`/`enumWireVariant` 的**键→值**代入还原运行时 variant 字符串，再与 JSON `codes[]` 逐条比 `building`/`variant`/`rotationVariant` → 修 C1 前 **2 mismatch**（code 6/48），修后 **0 mismatch，59/59**。
2. **`bundle.pretty.js` 交叉**：提取 59 个 internalId 与 JSON 比集合 → **59/59 完全一致，0 差 0 重**；balancer 连字符值在 `:10059-10061` 二次确认。
3. **实机回灌**：`building-codes-live.json` 60 条 → 按 `building|variant|rv` 查 JSON `codes[]` → **60/60 命中**。
4. **槽位逐变体核**：8 个指定变体全字段核（cutter/quad、stacker、painter×4、mixer、underground_belt×2rv、balancer×5、hub）+ 其余 20 建筑 acceptor/ejector/pin 计数与源码 `Vector` 计数比对 → 全部吻合；pin 计数差全归因于源码共用 `setSlots` 块（K5）。
5. **`world-full.json` 实测复核**：14 组 (type,variant,rv,code) 全对；hub 1 台 c26 @(-2,-2)；balancer 475；belt rv0/1/2 = 1487/223/196；painter 16×29 / 17×15；mixer 24；tunnel **91/91 配对全中**，跨度 ≤5。
6. **引用行号抽查**（全部有效，除 C3/K8/D8）：`config.js:77-113,151` · `hub_goals.js:58-62,107,196-211,358,487-575` · `components/item_acceptor.js:114-133` · `components/item_processor.js:124-141` · `systems/item_processor.js:342-360,367-416,461-463,527-551` · `shape_definition.js:40-45,266-282` · `shape_definition_manager.js:92-128` · `components/wired_pins.js:8-11` · `core/vector.js:20-45,503-520,685-690` · `components/static_map_entity.js:148-198` · `modes/regular.js:80,248` · `modes/levels.js:164-366` · `meta_building.js:10,42-50,143,184-186` · `building_codes.js:43-58,67-90`。

---

## 8. 文件清单

- 本文：`src/ai/machine-spec.md`
- 机器可读底座：`src/ai/machine-spec.json`
  - 本次改动：**C1** balancer variant 字符串（`codes[6]`/`codes[48]` + `buildings.balancer.variants` 两个 key）；**C2** `rateMeta.upgradeLadder.liveWorldLevels`（+ 新增 `formula`/`correctionNote`）；**C3** belt `source.lines` 行号越界。
  - 附带精化：`rateMeta.formulas.painterDouble`/`painterQuad`/`filter`（区分 charge/s 与件/s、filter 无 ItemProcessor）、`rateMeta.multiplierTargets.filter` 与新增 `note`（组映射表）。
  - 校验后规模：28 建筑 / 49 变体 / 59 code / 29 含物品槽 / 45 含任一槽位 / 实机 60/60。
- 只读引用（本次未改动，遵守纪律）：`src/ai/belt-rules.mjs` · `src/ai/op-templates.mjs` · `src/ai/compiler/*` · `research/ai-player/facts/*` · `recon/upstream-full/**` · `recon/bundle.pretty.js`
