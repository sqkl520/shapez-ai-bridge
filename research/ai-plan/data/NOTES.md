# P2 `data` — 缺口 / 差异 / 对 plan 的异议

> 本包拥有：`src/ai/op-templates.mjs`、`src/ai/world.mjs`、`research/ai-plan/data/**`
> 测试：`node src/ai/op-templates.mjs --test`、`node src/ai/world.mjs --test`、
> `node research/ai-plan/data/op-templates.test.mjs --test`、`node research/ai-plan/data/world.test.mjs --test`、
> `node research/ai-plan/data/run-all.mjs`（一条命令跑全部）、`node src/ai/world.mjs --validate`
> 全部离线，零游戏、零网络（plan §4 第 2 条）。

---

## 一、执行摘要（验收对照）

**一条命令跑全部**：`node research/ai-plan/data/run-all.mjs` → **812 条断言全绿**（含 --validate 与 lint）。

| 验收项 | 结果 |
|---|---|
| 1. 15 条实机 code 逐条 `codeFor(...,r=0,rv=0)` 相等 | ✅ 包测试第 [1] 节，60 条实机记录逐条 + 去重集合 == `[1,7,8,…,20]` |
| 2. 每模板槽位数 == GEOMETRY 表1；`trash`=20；stacker 左=下层/右=上层；painter shape←left/color←top/出→right | ✅ 第 [2] 节（期望值手抄自表1，与内嵌表相互独立） |
| 3. 速率导出含 `stacker:0.25` | ✅ `RATES` + `OP_TEMPLATES.stack.ratePerSec` + `bottleneckOf()` |
| 4. `node src/ai/world.mjs --validate` 与 gen-resources CLI 0 差异 | ✅ seed 43391，实机 resources.json 包围盒（340 chunk / 3284 格）**diff = 0**；另 5 个小区域分区对拍全 0 |
| 5. grep lint：两文件无 `proto/belt-rules` | ✅ 第 [8]/[7] 节代码级断言 + run-all 的 grep 步骤（无命中） |

**超出验收的三项产出**：
1. **P0-spec 落地即适配**（迁移路径 2 走完）：`loadMachineSpec()` 识别真 `machine-spec.json`
   （二级 `variants` 展平 + 字段别名），并交叉验证出**内嵌表槽位几何 vs P0-spec 源码值 0 差异**
   （NOTES 二·补 / G2 / [7b] 节）。变异测试证明这 0 差异是"真比过"不是"没比"。
2. **第二份实机凭据交叉校验**：与 level-11 存档 `world-full.json`（2805 实体）逐键比 code/rv/rot，零冲突（[9] 节）。
   顺带补齐 hub=26（P6 反查 code→kind 要它），并导出 `isV1Emittable`/`crossCheckCodes`。
3. **H2 的证据从"无证据"升级为"注册表证明不存在"**（G1）：三层凭据（实机提取表 + 存档 + 上游
   `getAllVariantCombinations` 源码），P0-spec 的 `hasRotationVariants` 又独立印证了一遍。

---

## 二、开放缺口（交主 Agent）

### G1 ★ 非 belt 建筑的 rv 编码 —— **plan §2.2 迁移路径第 4 条的前提已被源码推翻，但结论仍成立**

plan §2.2:238 说「非 belt 建筑的 rv 位在实机码里怎么编码，**当前无任何证据**」。
本包核查了上游 code 注册机制，证据链比"无证据"强得多：

- code 由 `building_codes.js:41-56 registerBuildingVariant(code, meta, variant, rotationVariant = 0)`
  经 `meta_building_registry.js:42-53` 用每个 meta 建筑的 `getAllVariantCombinations()` 注册；
  查表 key = `metaBuildingId/variant/rotationVariant`（`building_codes.js:87-99`）。
- `grep -rn "rotationVariant:" recon/upstream-full/src/js/game/buildings/` →
  **只有 `belt.js`（rv 0/1/2 → internalId 1/2/3）、`underground_belt.js`（0/1）、`wire.js`（0/1/2/3）
  注册了 rv≠0 的组合**。
  miner/cutter/rotater/stacker/mixer/painter/trash/hub 的组合里**根本不出现 `rotationVariant` 字段**
  （缺省 0）→ 注册表里**不存在**这些建筑的 rv≠0 code。
- 第三条凭据（实机）：level-11 存档 2805 个实体里，**非 belt/非隧道的 `rotation_variant` 恒 0**
  （143 矿机 / 16 切割机 / 44 上色器 / 24 调色器 / 10 垃圾站 / 4 旋转器 / 1 hub，包测试 [9] 节逐条核）。

⇒ 所以「v1 非 belt 只出 rv=0」**照实现**（plan 要求的硬断言已落地为 `RV_ALLOWED` + `codeFor` 拒绝），
但**理由变了**：不是"我们没测到 rv≠0 怎么编"，而是"**上游注册表里那个 code 不存在**"——
游戏侧解码不出来，比"无证据"更强、也更安全（不会有"哪天发现能编"的翻车）。
已写进 `op-templates.mjs` 的 `RV_ALLOWED` 注释，并落成测试。

**仍开放的子集**（本包**故意不猜**）：
- `underground_belt` 确有 code 22(rv=0)/23(rv=1)（存档实机 182 条），但**rv 的语义**无凭据
  （belt 的 rv 语义由 belt-rules 供给，隧道没有）→ 本包 `allowedRvariants("underground_belt") = [0]`，
  rv=1 拒绝，`isV1Emittable = false`。C4 已把它划出 v1 范围，无需补。
- `wire` 在上游走 `rotationVariant` 0-3 表线型（`wire.js:312 arrayWireRotationVariantToType`），
  但**没有任何实机 code 凭据**（level-11 存档里没有 wire 实体）→ 本包不收录 wire code，
  `codeFor("wire",…)` 直接拒绝（`emit:mismatch`），避免"看起来支持"。C3 已划出 v1 范围。

### G2 ★ `machine-spec.json` 已落地（提交 325e436），本包**已适配并识别** —— 迁移路径 2 走完
- P0-spec 交付了 `{version:"1.5.6", game_commit:"ee2279d", buildings:{28 家族×variants}, codes:[59], rates:{...}, rateMeta, codeTableSummary, notes}`。
  它的形态是**二级嵌套** `buildings.<name>.variants.<name>`，与本包预期的扁平列表不同。
- 本包做了**唯一一处**适配（plan §2.2 明令：别改 P0-spec 文件、别 fork）：
  - `SPEC_FIELD_ALIASES` 补齐它的真实字段名（`internalId`=code、`size`=footprint、`acceptors/ejectors`=槽位、
    `tile`=相对格、`verifiedBy`、`hasRotationVariants`）；
  - `specEntries()` 加一条分支**展平二级 `variants`**；`normalizeEntry()` 透出 `verifiedBy/rvSet/source`。
- 结果 `loadMachineSpec('src/ai/machine-spec.json')` → `recognized:true`（包测试 [7b] 节直接读真文件断言）。
- **交叉验证（最有价值的产出）**：内嵌表的槽位几何（15 组合的 acceptors/ejectors 数量+tile+dir）
  与 P0-spec 的**源码核证值逐格一致，0 差异** → GEOMETRY 表1 与本包搬运没写错。
  见 `specGapReport()` 里那条"交叉验证…逐格一致（0 差异）"。
- P0-spec 的 `hasRotationVariants` **独立印证了本包 RV_ALLOWED**（NOTES G1）：
  v1 的 9 个建筑家族里**只有 `belt|default` 注册了 rv≠0**（[0,1,2]），其余全是 [0]；
  隧道/wire 有 rv≠0 但都在 v1 范围外。包测试 [7b] 节逐条核这个集合。
- 覆盖策略按 plan §2.2 + 权威分层（详见 K5）：
  - code：**实机 > spec**（belt 走 beltCode，其余走实机提取表，spec 不同只登记）→ 实测 spec 的 belt internalId=1
    与 beltCode(0) 吻合、其余 code 也与实机提取表吻合 → **0 处 code 差异**；
  - footprint / unlockLevel / 槽位几何：见 G3/G4/K5；
  - ratePerSec：见 **G10**（新发现，单位口径不同）。

### G3 机器解锁等级：P0-spec **没有** `unlockLevel` 字段 → 全用本包兜底常量
- 实测：`machine-spec.json` 全文无 unlockLevel/unlock_level/level/requiredLevel 任一字段
  （只有 `notes` 里叙述性提到 reward 名）。→ `loadMachineSpec` 登记一条 gap：
  "machine-spec 无 unlockLevel 字段 → 用 UNLOCK_LEVEL_FALLBACK 兜底"。
- ⇒ plan §1.5 **V10-unlock-report** 说的「用 `machine-spec.unlock_level` 算不可用清单」目前**拿不到该字段**，
  V10 得改用本包的 `UNLOCK_LEVEL_FALLBACK`（已导出，测试 [7] 节锁住值）。
  这条**不是本包能补的**（缺的是等级门控数据，不是几何），建议：要么 P0-spec 后续加 `unlockLevel`
  到每条 variant 记录，要么主 Agent 认可 V10 直接用本包兜底表。
- 兜底常量本身（plan §2.2:221 只给 6 个，本包补齐其余）：`cutQuad=16`（源头
  `human-strategies.md §2.1` L16 → `reward_cutter_quad`，与 plan §1.5 V10 行一致）、
  `rotateCCW=7`、`rotate180=18`、`paintDouble=17`、`paintQuad=20`、`mineChainable=11`、
  `paintMirrored=6`、`trash=1`、`hub=1`。
  ⚠️ 下游两个坑：
  - **`rotateCCW=7` ≠ `rotate=4`**：ccw 是独立 reward（`reward_rotater_ccw`），与同建筑 default 不同级。
    plan §2.2 只写"rotate=4"，容易被当成整个 rotater 家族都在 L4。
  - **`paintQuad=20`** 来自 `reward_wires_painter_and_levers` → 同时需要 wire 层 → C3 之下 v1 范围外
    （模板标了 `v1Blocked:true`，`isV1Emittable("painter","quad")===false`）。

### G4 `paintDouble` footprint `[2,2]`：**已被 P0-spec 源码核证实**（不再是"未核对"）
- 内嵌表原取 `[2,2]`（从上游 `painter.js:51-52 getDimensions(double)→Vector(2,2)` + slots 出现 `(0,1)` 推）。
  P0-spec 落地后 `machine-spec.json` 的 `painter.double.size` 也是 `[2,2]`、`painter.quad.size=[4,1]` →
  **两份独立来源吻合**，本包 `footprint` 无差异（`loadMachineSpec` 的 footprint 比对 0 命中）。
- ⇒ 这条从"待实机核对"降级为"源码双证一致"；仍**未实机**跑过（在 v1 之外），真要产出仍需 P7 复核。

### G5 `world.mjs` 采用"复刻"而非"生成期跑 CLI 落 fixture"（plan §1.2 留给 P2 二选一的决策）
选 (a) 复刻：
- `exp-e2e.mjs:32-89` 那段是**已验证**的内联实现（实机 3002/3002 一致，`facts/offline-map-reproduction.md`），
  搬运成本低于维护一份生成期 fixture 管线；
- 编译器运行时要**任意坐标**的 O(1) 查询（`tileResource`）与**任意区域**搜索（`findResource`），
  fixture 只能覆盖预生成区域，P3 选址/重规划会撞墙；
- 等价性由 `--validate` 锁：spawn `gen-resources.mjs` CLI 逐格对拍，**改错算法立刻红**。
- 文件头与注释里标了行号来源（`gen-resources.mjs:17-210` / `exp-e2e.mjs:32-89`）。
- ⚠️ 复刻里刻意保留了两处**上游的"不对"**，不是本包的 bug（各自做过变异测试）：
  1. **不对称边界判断** `y >= 0 && y <= 16`（`gen-resources.mjs:132` 明写"原样复刻"）：
     会往 `l[x][16]` 写越界一格。**实测：把 `<=` 改成 `<` 后对拍仍 0 差异** ⇒ 这个越界格
     在**两侧**都不会被读回（CLI 与 `resourcesInRegion` 都只遍历 `ly < 16`），
     所以它是**行为惰性**的、不是承重逻辑。本包把这越界格收进 `_extraRow`（首写优先，
     与上游 `if (!lower[x][y])` 同语义），既不谎称修好、也不污染读值。
     ⇒ 结论：这条**不需要**测试来锁（锁了也是空断言），只在注释里说明别"顺手修正"成
     语义不同的东西即可。
  2. **RNG 消耗顺序**（★ 这条是承重的，有变异测试证据）：`patch()` 先消耗
     `nextIntRange(patchX)`、再 `nextIntRange(patchY)`，**即便随后被 overrideX/overrideY
     覆盖也已经消耗**（`gen-resources.mjs:110-115`）；`generateColorPatch` 的 `rng.choice`
     也先于 patch 消耗（`:147`）。
     ⇒ 变异测试：把这两行改成 `overrideX !== null ? overrideX : rng.nextIntRange(...)`
     （即"不再浪费随机数"）→ `--validate` **立刻 70 格差异**。已用测试锁住。
  3. `pickSubShape` 依赖 weights 对象**键插入顺序** rect,circle,star,windmill（`:185`）——
     同样照抄，别重排字面量。

### G6 非方形占地的旋转 origin 位移未实现（照 plan D1 拦住，不是遗漏）
`static_map_entity.js:127-141`（plan/redteam:143 引）在 rot=90/180/270 时会位移 origin，**实机未验证**。
本包：`rotateCell()` 只在 `footprint` 为**方形**时做旋转，非方形 + rot≠0 **一律抛错**
（`out-of-scope:rotated-machine`）。`worldSlots(cutter, 90)` 有测试证明会抛。
⇒ 未来若要支持旋转 2×1 机器，**必须先补实机实验**（P7 的时间片），届时改 `rotateCell` 一处。
方形机器已实现并测（rotater 1×1 / hub 4×4 的 rot=90/180/270 槽位对拍）。

### G7 ★ `belt-rules.rotateLocal` 对非 90 倍数角度是**截断**，而同文件的 `angleToDir` 是**量化** —— 语义不一致
```js
rotateLocal("top", 45)  → ORDER[(0 + (45/90|0)) % 4] = "top"     // 45° 当 0° 用（|0 截断）
angleToDir(45)          → ORDER[Math.round(45/90)%4]  = "right"  // 量化到最近象限
```
同一文件、同一"把角度变方位"的任务，两个答案。**任何 `rotation` 来源不纯净的地方（LLM 填的参数、
obs 反推、单位混淆）都会静默拿到错方位，而不是拿到错 code 或报错。**
- 本包**没改** `belt-rules.mjs`（禁改文件），而是加了 `assertQuadrantAngle()` 前置校验：
  `codeFor / rotateSlot / rotateCell / worldSlots / assertV1Rotation` 一律先拒绝非象限角。
  → 静默错变成显式错。
- ⚠️ **建议主 Agent 转给 P0-verify / P4**：`solveTurn()` 返回的 `{rotation, rotationVariant}` 内部
  也是走 `rotateLocal`，但它自己只产出 0/90/180/270，所以当前**不可达**；真正的风险在
  **外部输入**（obs 的 `r` 字段、蓝图 `rot`、LLM 参数）。若 P4/P5 直接用 `rotateLocal` 吃外部角度，
  会复现这个坑。要么它们也加象限校验，要么 `belt-rules` 里把两者统一（属禁改文件，需主线程决定）。

### G8 hub 的实机凭据等级要说清楚（避免下游误读 ⬜）
GEOMETRY 表1:23 给 hub 打 ⬜"未测"。那句话说的是**"把带子直接连进 hub 槽位"没实机跑过**。
但 level-11 存档里 **hub 实体本身是实机观测的**：唯一一台，`code=26, r=0, rv=0, 4×4`
（`facts/live/world-full.json` 直读，包测试 [9] 节逐键比 `SAVE_CODES`）。
⇒ 本包把两件事分开标：`verifiedOnLive: false`（**槽位几何**未实机测，承表1）
+ `codeVerifiedOnLive: true`（**code/占地**已实机观测）。P5 的 V4-slot-alignment 连 hub 时
仍应按"未实机验证"处理。

### G9 trash 的 rot：上游 `getIsRotateable()=false` ⇒ 恒 r=0，**plan §2.2 未覆盖这点**
`building-codes-live.json` 把 trash 在 4 个朝向下都摆了一遍（code 都=20），容易被读成"trash 可旋转、
四边全收所以等价"。上游实情：`trash.js:27-29 getIsRotateable() → false`、`hub.js:31-33` 同。
`meta_building.js:258-262` 在 false 时**强制返回 `{rotation:0, rotationVariant:0}`**。
实机印证：存档里 10 台 trash + 1 台 hub **全部 r=0**，而 painter/cutter/mixer/rotater/miner/belt
都出现过非 0 朝向。
⇒ `assertV1Rotation("trash", 180)` 现在**抛错**（而不是早期草稿里的"放行"）；导出 `ROTATABLE` 表。
这条对 P5 的 V1-occupancy 有实际影响：算 trash 包围盒时**不该考虑旋转分支**。

### G10 ★ P0-spec 的 `rates` 单位口径是 **charges/s**，与 GEOMETRY 表2 的 items/s 不同 —— V7 吞吐判定的坑
适配 P0-spec 时逐字段比速率，发现它的 `rates{}`（按 `processor` 名索引）与内嵌 `RATES`（表2）
**不是同一个量纲**，且对**多件/charge 的变体**差一个倍数：

| 建筑 | P0-spec `rates` | 换算（`rateMeta.formulas`） | 表2 items/s |
|---|---|---|---|
| painter | 0.333 | 每 charge 出 1 件 | 0.33 ✅ 同 |
| stacker | 0.25 | 每 charge 出 1 件 | 0.25 ✅ 同 |
| **painterDouble** | **0.25** | `inputsPerCharge 3`、每 charge 出 **2** 件 → 0.25 charges/s = **0.5 件/s** | 表2 未列 |
| **painterQuad** | **1.0** | 每 charge 一次上 **4** 色 → 4 件/s | 表2 未列 |

- 对 v1 的 10 个 op（表2 覆盖、每 charge 出 1 件）两者数值恰好相等 → **本包保留表2 值、差异仅登记**
  （painter 0.33 vs 0.3333… 只是圆整，`loadMachineSpec` 的速率分支按 `V1_OPS` 判权威）。
- 对 `paintDouble`/`paintQuad`（表2 没给、内嵌是借 painter 0.33 的占位）→ 用 spec 补值 0.25 / 1.0，
  **但 `why` 里明确标注"spec 口径是 charges/s、该变体每 charge 出多件、件/s 需换算"**。
  ⇒ `resolveTemplates()` 返回的 `paintDouble.ratePerSec` = **0.25 charges/s**，不是 0.5 件/s；
  **P5 的 V7 若拿它按"件/s"判吞吐会低估 painterDouble**（虽然 painterDouble 在 v1 之外，暂不可达，
  但字段暴露给下游就该说清）。
- ⚠️ 本包**不做换算**（不发明解释）：只把 spec 原值 + 口径注释透出，换算规则交给 V7 / 主 Agent 定。
  若主 Agent 认为本包应统一成"件/s"，改一处 `loadMachineSpec` 速率分支即可（已集中）。

---

## 二·补 — P0-spec 落地后的交叉验证结论（本包最大产出）

适配真 `machine-spec.json` 后跑出来的**两份独立来源的一致性**（都不是本包自证的，是数据对数据）：

| 交叉项 | 内嵌表来源 | P0-spec 来源 | 结果 |
|---|---|---|---|
| **15 组合的槽位几何**（acceptors/ejectors 数量+tile+dir） | GEOMETRY 表1（实机核证） | buildings/*.js 源码读 | ✅ **逐格一致，0 差异** |
| **code**（belt 之外 14 个组合） | building-codes-live.json 实机提取 | `internalId` | ✅ 吻合，0 差异 |
| belt code | beltCode(rv)=1+rv（1906 实机） | `beltVariants{0,1,2}.code` = 1/2/3 | ✅ 吻合 |
| **RV_ALLOWED**（谁能取 rv≠0） | 三层证据推理 | `hasRotationVariants`（源码注册表） | ✅ v1 家族里**只有 belt** 有 rv≠0 —— 独立印证 G1 |
| footprint `[2,2]`/`[4,1]` | painter.js 推 | `painter.double/quad.size` | ✅ 吻合（G4 升级） |
| ratePerSec | GEOMETRY 表2 items/s | `rates{}` charges/s | ⚠️ **口径不同**（G10），v1 的 10 op 数值恰好相等 |

⇒ 见 `node src/ai/op-templates.mjs --gaps`（前 3 条就是这些结论），或包测试 [7b] 节（直接读真文件断言）。

---

## 三、对 plan 的异议（照实现，不改别人文件）

### K1 plan §1.3（P3）「把 `exp-e2e.mjs:93-102 hubEntries()` 这条表**搬进自己文件**」—— 建议改为 import 本包
本包已把它归一供给：`hubEntriesWorld(origin)`（`op-templates.mjs`）。
plan 让 P3 "搬进自己文件"的动机是"不 import exp-*"（实验脚本不是库），这点完全成立；
但**同一条表在 P3、P4、P5 各抄一份**就成了三份真值 —— 与本项目的"单一真源"纪律（belt-rules 事故、
C5「单一真源」）直接冲突。plan §1.2 明说 P2 是"几何真值供给方"，hub 16 入口就是几何。
⇒ 本包提供 + 用**解析 `exp-e2e.mjs` 源码**的方式核对它（包测试 [11] 节，不是照抄我自己的输出）。
建议 P3 直接 `import { hubEntriesWorld }`，plan §1.3 那句相应作废。**不改 plan 文件**，等主线程裁决。

### K2 plan §2.2 的 `OpTemplate.op` 枚举缺 `trash` / `belt` / `hub`，但 §2.1 的 `kind` 枚举有
`CompiledPlan.entities[].kind` 含 `trash|belt|hub`（plan §2.1:190），
而 `OpTemplate.op` 枚举（§2.2:217）只有 10 个 op。P6 反查 code→kind 要覆盖 20/1/26。
⇒ 本包把它们放进 `AUX_TEMPLATES`（与 `OP_TEMPLATES` 分开，**op 枚举成员严格等于 §2.2 的 10 个**，
测试锁住），合并视图 `ALL_TEMPLATES` 供 P6 反查。
不影响 §2.2 契约；下游要知道 `opByName("trash")` 可用而 `OP_TEMPLATES.trash === undefined`。

### K3 plan §2.2:232「该文件**只给各建筑的 default rv**」—— 措辞易误读
`building-codes-live.json` 的 `rotation_variant` 恒 0 **包括 belt 自己**（belt 的 4 条都是 rv=0 → code=1）。
所以"belt 的 rv1/rv2 → code 2/3"**不来自这个文件**，来自 belt-rules（1906 条真实带子）。
plan 的结论（"code 的 rv 位由 P2 用公式推导，不许假设可从该文件直读")是对的，
但"只给 default rv"这个说法会让人以为其它建筑的 rv 位只是"没记录"（而 G1 说明它根本不存在）。
⇒ 本包措辞改成：该文件给的是**每 (building,variant) 在 rv=0 下的 code**，且 belt 的 rv≠0 由 belt-rules 供给。

### K4 `mustDiscardUnused` 对所有加工 op 取 `true` 会让 V9 对"唯一输出的机器"也报错（轻微）
plan §2.2:227 的字段是 per-template 的布尔。事实是：**只要输出槽没接走就得接 trash**（陷阱表 #7），
与"是不是唯一输出槽"无关（M4-SUCCESS 里矿机→带→trash 也是这个规则）。
⇒ 本包把除 trash/belt/hub 外全部设 `true`，并**额外导出 `wasteRoles`**
（cutter 的 `right` 在 `----CuCu` 这类场景是注定废弃的那一路）。
建议 P5 用 `wasteRoles` 判"哪些输出必须显式接 trash、哪些是可选的第二路"，
`mustDiscardUnused` 只当"这台机器有没有丢弃义务"的总开关。**没改 plan**，只是补了个更细的字段。

### K5 `loadMachineSpec()` 的返回值形状 plan 没定义，本包定了（下游需按此消费）
plan §1.2 只给了函数名。本包签名：
```js
loadMachineSpec(file?) → { templates, diffs[], gaps[], recognized:boolean, source:string|null }
```
- `diffs[i] = {op, field, embedded, spec, kept, why}` —— **逐字段**记差异（plan §2.2 迁移路径 2 要求）。
- 权威优先级写死，避免各包自行判断：
  - `code`：**实机数据 > machine-spec**（belt 尤其：`beltCode(rv)` 驳回一切，H1）
  - `footprint` / `ratePerSec` / `unlockLevel`：**spec 覆盖内嵌**（并记差异）
  - `inputs/outputs 槽位几何`：**GEOMETRY 表1 权威**，spec 不同 → 保留内嵌 + 记差异（**不覆盖**）
    理由：槽位是"实机已核"的几何（M1b/M2a/M3），spec 是源码推测；plan §1.2 也写"几何真值以 GEOMETRY 表1 为准"。
    plan §2.2 那句"用它的值覆盖内嵌表"在这里做了**有限让步**——已在 `why` 里写明，等主线程裁决。
- `resolveTemplates()` 带缓存（多次调用不重复读盘），P3/P4/P5 应统一走它，别各自 `readFileSync`。

### K6 `findResource` 的 `region` 必须是**必传**（plan §1.2 写的签名是必传，本包加硬）
plan 签名 `findResource(seed, shape, {x0,y0,x1,y1})`。世界无限 → 无界搜索不可行。
本包把它做成结构化错误（缺 region → `WorldError / no-resource-in-range`），并加了
`regionAround(center, radius)` 方便 P3 选址。**没有**给"默认全域"的隐式行为（那会变成静默全表扫描）。

---

## 四、两份实机凭据的交叉校验（本包新增，plan 未要求）

`MACHINE_CODES`（15 条，来自 `building-codes-live.json` 专用提取实验）
与 `SAVE_CODES`（level-11 存档 `world-full.json` 直读）**独立**，逐键比：

| | 提取表（`MACHINE_CODES`，14 键） | 存档（`SAVE_CODES`，11 键） | 一致 |
|---|---|---|---|
| 共有键（7） | miner=7, cutter=9, rotater=11, mixer=15, painter=16, painter-mirrored=17, trash=20 | 同 | ✅ 零冲突 |
| 存档独有（3） | — | balancer=4, hub=26, underground_belt=22（rv1→23） | 收录，`isV1Emittable=false` |
| 提取表独有（7） | miner-chainable=8, cutter-quad=10, rotater-ccw=12, rotater-180=13, **stacker=14**, painter-double=18, painter-quad=19 | 存档里没有 | ⚠️ **stacker=14 只有一份凭据**（level-11 工厂没 stacker） |
| belt | 不比对（`MACHINE_CODES` 刻意不含 belt） | 存档 code 1/2/3 = `beltCode(rv)` | ✅ belt 的唯一权威是 belt-rules（H1）；提取表里 belt 的 4 条都是 rv=0→code 1 |

⇒ `codeFor` 是**世界解码器**（P7 读回 475 台 balancer / 182 条隧道要能解），
`isV1Emittable` 是**产出权限**（P5 的 V8 用它）。两者分开，否则 P7 的落盘对拍解不了存档。

---

## 五、怎么跑

```bash
node research/ai-plan/data/run-all.mjs                 # 一条命令跑本包全部 L0（含 --validate）
node src/ai/op-templates.mjs --test                    # 自证（表自身一致 + 行为断言）
node research/ai-plan/data/op-templates.test.mjs --test # 验收（对着原始凭据文件重核）
node src/ai/world.mjs --test
node research/ai-plan/data/world.test.mjs --test
node src/ai/world.mjs --validate                       # 与 gen-resources CLI 逐格对拍（应 0 差异）
node src/ai/world.mjs --validate 43391 --chunks        # 另与实机 resources.json 对拍
node src/ai/op-templates.mjs --gaps                     # 打印运行时 spec 缺口清单
grep -n "proto/belt-rules" src/ai/op-templates.mjs src/ai/world.mjs   # lint：应无命中
```
