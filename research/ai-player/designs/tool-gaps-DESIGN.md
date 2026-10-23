# 设计：工具层缺口的具体修法（`SYNTHESIS.md §4` 的实现方案）

> `SYNTHESIS.md §4` 列了 5 条**实测踩到的坑**（不是理论风险）。本文给出每一条的
> **协议改动（具体 JSON）+ 实现位置（文件:行号）+ 向后兼容性 + 测试方法**，
> 使其能被一个工程师直接开始实现。
>
> 行号基准（撰写时）：`src/mod/shapez-ai-bridge.js`（工作树版，含未提交的 dry_run 改动）、
> `src/bridge/bridge.mjs`、`src/mcp/server.mjs`、`docs/PROTOCOL.md`、上游源码 `recon/upstream-full/`。
> 上游引用格式：`文件:行号`（1.5.6 @ ee2279d）。

---

## §4.0 `placeOne` 的 rv 覆盖 —— 已修，补文档化

### 现状（已实现，无需再写代码）

- **修复**：`placeOne(root, meta, x, y, rotation, variant, rotationVariantOverride = null)`
  —— `src/mod/shapez-ai-bridge.js:787-828`。传数字 → 强制使用；传 `null`（默认）→ 走
  `computeOptimalDirectionAndRotationVariantAtTile` 自动定向（行为不变）。
- **粘贴链路**：`opPasteBlueprint` 从 code 反查并传入 —— `src/mod/shapez-ai-bridge.js:1556-1564`
  （`info.rotationVariant !== undefined ? info.rotationVariant : null`）。
- **回归**：`test/mod_selftest.mjs` 3 条断言（"placeOne honours rotationVariant override" 等，
  见 `facts/RV-FIX-verified.md`）；实机幂等验证已完成（同蓝图两处粘贴逐格一致）。
- **提交**：`e27f815 fix(mod): let callers pin a building's rotationVariant`（已入 main）。

### 对协议的影响（要写进 `docs/PROTOCOL.md` 的部分）

1. **蓝图粘贴语义变更（行为澄清，非破坏性）**：
   §6 应加一段："粘贴时，每格的 `rotationVariant` 从 `code - baseCode` 反推并**直接采用**
   （不再由邻居派生）。因此**蓝图粘贴是位置无关、顺序无关的幂等操作**——
   这是离线生成蓝图、实机确定性落地的契约基础（`facts/RV-FIX-verified.md`）。
   ⚠️ 在 e27f815 之前，拐角格的 rv 由邻居即时计算，粘贴顺序会影响结果（H7 的'保真'曾是巧合）。"
2. **`place` / `place_path` 行为不变**：两者仍走自动定向（邻居派生），
   §5 表格的对应行加注："`place`/`place_path` 的带子弯道由邻居派生（`belt.js:161`）——
   **铺带顺序重要，拐角格应在邻居就位后再放**。需要完全确定时用蓝图。"
3. **错误语义**：无需新错误码。rv 覆盖失败不产生新错误（游戏对非法 rv 会拒绝放置 → 2002）。

### 测试

- 已有 3 条 mod_selftest 断言（`test/mod_selftest.mjs`）。
- **补一条协议级测试**（`test/mod_rpc_selftest.mjs`）：断言 `paste_blueprint` 传下的
  `rotationVariant` 与蓝图 `code` 一致（stub `tryPlaceBuilding` 捕获参数）。
- 实机回归（已有脚本可复跑）：`research/ai-player/exp-rv-fix.mjs`。

---

## §4.1 `bulk_delete` 的 `dry_run` / `only_uids` 白名单（最高频坑——实测 4 次）

### 现状

- **`dry_run` 已在工作树实现（未提交）**：`src/mod/shapez-ai-bridge.js:1175-1202`（dry_run 分支）、
  `:879`（`actionSpecs().bulk_delete.fields` 已含 `"dry_run"`）；
  `docs/PROTOCOL.md` 已加 §5 表格行与"删除前先核对"警示段；
  `test/mod_selftest.mjs` 已加 3 条断言（21 条全绿）。
- **`only_uids` 尚未实现** —— 本设计补全。

### 协议改动（最终形态）

**入参**（`region` 与 `only_uids` **二选一**，同时给出报 2001）：

```jsonc
{"op":"bulk_delete", "region":[x0,y0,x1,y1], "layer":"regular|wires|all", "dry_run":true}
{"op":"bulk_delete", "only_uids":[13207,13208,13341], "dry_run":true}
```

**出参**（`dry_run` 与真实删除统一格式，便于"先核对清单、再原样执行"）：

```jsonc
// dry_run:true —— 只报告
{"ok":true, "op":"bulk_delete", "dry_run":true,
 "would_delete": 3, "by_type": {"belt":2, "cutter":1},
 "items":[{"uid":13207,"x":10,"y":-4,"type":"belt","rotation":90}, ...],
 "tick": 20654.28}

// 真实删除 —— 逐 uid 回报结果（含失败明细，不再只有计数）
{"ok":true, "op":"bulk_delete",
 "applied": 3, "failed": [{"uid":13341,"x":12,"y":-4,"reason":"rejected"}],
 "deleted_uids":[13207,13208,13341], "tick": 20654.28}
```

设计理由：
- `only_uids` 就是 `INCIDENT-bulk-delete.md` 里建议的"配合 place/place_path 返回的 uid 做精确回滚"
  ——与 §4.2 配成一对（**建 = 返回 uids；拆 = only_uids**），这是"事务语义"的两半。
- `deleted_uids` 让调用方能**立即**核对"删的正是我建的"，无需再对拍快照（现有 4 次事故全
  靠事后逐 uid 对拍发现）。
- `only_uids` 里出现不存在的 uid 不报错、进入 `failed`（幂等回滚：部分已被删时仍可重跑）。

### 实现位置

| 改动 | 位置 |
|---|---|
| `actionSpecs().bulk_delete.fields` 加 `"only_uids"` | `src/mod/shapez-ai-bridge.js:879` |
| `opBulkDelete` 头部：校验"`region` 与 `only_uids` 恰好给一个"（两个都给/都不给 → 2001） | `src/mod/shapez-ai-bridge.js:1148-1156` |
| `only_uids` 分支：把 `toDelete` 的收集逻辑从"扫 region"改为"按 uid 查表"（先建 `uid → entity` Map，一次线性扫，与现有 `toDelete` 收集复用同一循环） | `src/mod/shapez-ai-bridge.js:1164-1173` 前插入 |
| 真实删除分支补 `deleted_uids` 收集 | `src/mod/shapez-ai-bridge.js:1204-1215` |
| **桥接只读模式放行 `dry_run`**（dry_run 不改世界，应属读操作） | `src/bridge/bridge.mjs:313-322`（`checkReadOnly` 的 act 分支加特判：`op==="bulk_delete" && params.dry_run===true` → 放行） |
| MCP 描述与 schema 更新 | `src/mcp/server.mjs:315-347`（`shapez_action` description 里补 `bulk_delete{region|only_uids, dry_run?}`）与 `docs/PROTOCOL.md §5/§9` |
| 协议文档 | `docs/PROTOCOL.md:119-131`（已有 dry_run 段，补 `only_uids` 与 `deleted_uids`） |

### 向后兼容性

- `region` 单独使用：**行为完全不变**（`deleted_uids` 是新增字段，旧调用方忽略即可）。
- `dry_run` 已是纯新增（缺省 false）。
- 只读模式放行 `dry_run` 是**放宽**：任何在只读模式下依赖 `dry_run` 返回 1004 的测试需更新
  （检索确认：现有测试无此依赖）。
- MCP 的 `additionalProperties: true`（`src/mcp/server.mjs:347`）→ 新字段无需改 MCP 校验。

### 测试方法

1. **单测（stub root，模式同 `test/mod_selftest.mjs:399-448`）**：
   - `only_uids` 只删白名单（区域内外混合数据 → 断言删除集合）；
   - `region`+`only_uids` 同给 → 2001；都不给 → 2001；
   - 不存在 uid → 进 `failed` 且不抛；
   - `dry_run` 下 `deleted_uids` 不存在（没有真删）。
2. **实机验收（一次，走 `test/live_bridge.mjs` 或 `play.mjs action`）**：
   ```
   ① 在远离工厂处建 3 格带 → 记 uids
   ② bulk_delete {region: <比实际大 2 格的框>, dry_run:true} → 人工核对 items 恰好 3 条
   ③ bulk_delete {only_uids: <上面 3 个>, dry_run:true} → would_delete=3
   ④ bulk_delete {only_uids: <3 个>} → applied=3, deleted_uids 一致
   ⑤ obs 该区域 → 0 实体；再 only_uids 重跑 → applied=0, failed=3（幂等）
   ```

---

## §4.2 `place_path` 返回全部 uid（现在只有 `first_uid`）

### 协议改动

```jsonc
// 之前
{"ok":true, "op":"place_path", "applied":8, "failed":[], "first_uid":13207, "tick":...}
// 之后（新增 uids，保留 first_uid）
{"ok":true, "op":"place_path", "applied":8, "failed":[],
 "first_uid":13207, "uids":[13207,13208,...,13214], "tick":...}
```

- **uids 与 applied 严格同长**、按**铺放顺序**（即 from→to）。`failed` 格不进 uids。
- 路径上限 5000 格 → uids 最多 5000 个整数（≈25 KB JSON），可接受；
  **不设开关**（"总是返回"比 `return_uids:true` 少一个调用方会忘的坑）。
- 与 §4.1 配对：`delete {op:"bulk_delete", only_uids:r.uids}` 即精确回滚。

### 实现位置

- `opPlacePath`：`src/mod/shapez-ai-bridge.js:1085`（`let firstUid = null;`）→ 改为
  `const uids = [];`，循环里 `:1092-1093` 改为 `if (entity) { applied++; uids.push(entity.uid); if (firstUid === null) firstUid = entity.uid; }`；
  返回对象 `:1107-1114` 加 `uids`。
- 文档：`docs/PROTOCOL.md:127` 表格行补"返回 `uids`（全部成功放置的 uid，顺序=铺放顺序）"；
  `docs/PROTOCOL.md:141-151` 的 ActionResult 示例加字段。
- MCP：`src/mcp/server.mjs` 无需改（动作结果原样透传）。

### 向后兼容性

纯新增字段；`first_uid` 保留（旧调用方 `research/ai-player/exp-*.mjs` 全部继续工作）。

### 测试方法

1. 单测（stub）：`performBulkOperation` + `tryPlaceBuilding: () => ({uid: ++seq})`，
   断言 `uids.length === applied === len`、顺序单调；中间格被占（部分失败）时
   `uids.length === applied` 且不含失败格。
2. 实机：`place_path` 8 格 → 断言 `uids.length=8`；`bulk_delete{only_uids:uids}` → `applied=8`；
   实体数回到基线（对照 `facts/live/world-full.json` 的 2805 基线）。

---

## §4.3 `obs` 增 `include_belt_items`（带内物品 / 堵塞）——改动最"重"的一条

### 数据来源（源码核证）

带内物品的唯一权威来源是 `BeltSystem.beltPaths`：
- **访问路径**：`root.systemMgr.systems.belt.beltPaths` —— 已核证的两处真实调用：
  `hud/parts/interactive_tutorial.js:37`、`belt_path.js:321`（`root.systemMgr.systems` 是公开模式）。
- **每个 `BeltPath` 的字段**（`belt_path.js:26-34` schema）：
  | 字段 | 类型 | 语义 |
  |---|---|---|
  | `entityPath` | `Entity[]` | 构成这条路径的带子（含地下带），**顺序 = 流动方向**（`belt_path.js:408-427` 的 integrity check 逐个验证 `findFollowUpEntity` 链） |
  | `items` | `[nextDistance, item][]` | 头部=最新进入、尾部=最接近交付口；`nextDistance` 是"到前一个物品/出口的距离" |
  | `spacingToFirstItem` | number | 路径起点 → 首个物品的距离；**空带时 == `totalLength`**（integrity check `belt_path.js:453-461`） |
  | `totalLength` | number | `computeTotalLength()`（`belt_path.js:1117-1123`；直带格=1.0、弯道格=0.78，`components/belt.js:70-71`） |

### 堵塞判定（源码给出的精确定义）

`belt_path.js:126-128`：
```js
canAcceptItem() { return this.spacingToFirstItem >= globalConfig.itemSpacingOnBelts; }
```
`globalConfig.itemSpacingOnBelts = 0.63`（`core/config.js:86`，已核证）。

**⇒ 堵塞的精确条件：`spacingToFirstItem < 0.63`**（此时该路径**拒绝任何新物品**，
上游 ejector 的 `tryAcceptItem` 失败 → 逐级回压）。这不区分"入口挤满"还是"出口无人收"，
但对 AI 的诊断来说两者都需要关注——**因此 mod 端同时给 `items` 计数即可**：
- `spacing_to_first < 0.63` → **该段已堵**（= `canAcceptItem() === false`）；
- `items === 0 && 上游有矿机在喷` → **饥饿**（该判定由 agent 端结合上游实体做，mod 不做派生）。

**分层遵循 `SYNTHESIS.md §3` 的裁决**："mod 端只加原始字段（堵塞/占用）+ agent 端做派生视图"——
所以 **mod 输出原始数字**（`spacing_to_first` / `items` 数 / `total_length`），
**`full` 布尔值与 load 百分比由 agent 端算**（阈值常量在 agent 端有一处定义）。

### 协议改动

**入参**（`validateObsRequest` 已知字段集合 +2）：
```jsonc
{"op":"obs", "region":[x0,y0,x1,y1], "include_belt_items":true, "max_belt_paths":200}
```
- `include_belt_items` 缺省 false（不改变现有观测体积与性能）。
- `max_belt_paths` 缺省 200、上限 2000；超限 → 按与 region 相交的路径数截断并给 `belt_traffic_truncated:true`。

**出参**（`obs` 顶层新增字段；`region` 过滤语义 = "路径的任一格落在 region 内"）：
```jsonc
"belt_traffic": [
  { "head": [172,-41],          // entityPath[0] 的 origin（上游端，流动起点）
    "tail": [172,-48],          // entityPath[last] 的 origin（下游端，朝向接受者）
    "len": 8,                   // entityPath.length（带子格数）
    "total_length": 8.0,        // 连续长度（弯道 0.78，可小于 len）
    "items": 5,                 // 带内物品数
    "spacing_to_first": 0.0,    // 原始值（agent 端判 full：< 0.63）
    "sample": ["----RuRu","----RuRu","----RuRu"]   // 头 3 个物品的 copyable key（≤3）
  }
],
"belt_traffic_truncated": false
```

物品的 stringify 用**已有的** `itemToShortKey(item)`（`src/mod/shapez-ai-bridge.js:714-736`）——
它对 ShapeItem 返回 `getHash()`（实测裸字符串如 `"CuCuSuSu"`），对 ColorItem 返回颜色名
（实测序列化形如 `{"$":"color","data":"blue"}`，`facts/live/exp-remote-belt-3.result.json`）——
两边都归一成字符串，agent 端不必知道序列化细节。

### 实现位置

| 改动 | 位置 |
|---|---|
| `validateObsRequest`：已知字段加 `include_belt_items`/`max_belt_paths`；返回结构加对应项 | `src/mod/shapez-ai-bridge.js:572-622` |
| 新方法 `beltTrafficSnapshot(root, region, maxPaths)`（约 40 行）：读 `root.systemMgr.systems.belt.beltPaths`，用 `path.entityPath[i].components.StaticMapEntity.origin` 取格、按 region 过滤、映射成上表结构 | 插入 `src/mod/shapez-ai-bridge.js:713`（`itemToShortKey` 之后） |
| `observe()` 挂载：`if (req.include_belt_items) { out.belt_traffic = this.beltTrafficSnapshot(root, effectiveRegion, req.max_belt_paths); }` | `src/mod/shapez-ai-bridge.js:541-544`（`include_resources` 分支旁） |
| `"features"` 数组加 `"belt_items"`（能力探测） | `src/mod/shapez-ai-bridge.js:259-270`（hello features） |
| 文档 | `docs/PROTOCOL.md §4`（ObsRequest/观测示例）与 §8"观测体积"段 |
| MCP schema | `src/mcp/server.mjs:282-312`（`shapez_observe` 加两个属性） |

**性能注**：`beltTrafficSnapshot` 只遍历 `beltPaths` 元数据与 `items.length`，
**不触碰渲染**；2000 路径 × 平均 20 物品 ≈ 常数级毫秒。region 缺省（全图）时
`effectiveRegion` = 实体 bbox，可能包含数百条路径——默认 `max_belt_paths=200` 兜底。

### 向后兼容性

纯新增 opt-in 字段；缺省关闭 ⇒ 旧调用方零感知。mod 与 bridge 无需同版本升级
（bridge 透传 params，不校验字段——`src/bridge/bridge.mjs` 的转发无字段白名单）。
老 mod + 新 bridge：调用带 `include_belt_items` → 老 mod 报 2001"unknown obs field"
（这是显式的、可发现的失败，符合协议"未知字段报错"原则）。

### 测试方法

1. 单测（stub beltPaths，模式同 mod_selftest）：构造 2 条 path（一条 `items=[]`,
   `spacingToFirstItem=totalLength`；一条 `spacingToFirstItem=0.1`，3 个物品），断言：
   - `items` 计数与 `sample` 长度正确；
   - `region` 过滤命中/未命中；
   - `max_belt_paths` 截断 + `belt_traffic_truncated`。
2. **实机验收**（决定性，复刻 M1b）：建 矿机+带（8 格）→ `step 2000` →
   `obs {region, include_belt_items:true}` → 断言该 path `items > 0` 且 `sample[0]` 与
   资源形状一致；再对 level-11 真实存档 `obs` hub 区域 → 与 `play.mjs traffic`（§4.6 离线解码）
   **交叉对拍**：同一路径的 items 数在两条通道下一致（这是最强验证——两条独立实现互证）。

---

## §4.4 `place_path` 退化段（from==to）的处理

### 现状与理由

- 现状：报 2001（`src/mod/shapez-ai-bridge.js:1061-1063`）；本研究**踩过 4 次**
  （M4 系列 ×3 + `bench_b3`；`exp-m4-fullchain.mjs` 里已有 `placeSeg` 包装器绕过）。
- **建议：允许（= `place` 一格）**。理由（逐条有据）：
  1. **契约本来就该允许**：§5 写的是"轴对齐直线铺满（**含端点**）"——单格是长度 1 的合法直线，
     `from==to` 只是 `len=1` 的退化情形，不是非法输入（与 `dx!==0 && dy!==0` 的**真非法**不同）。
  2. **调用方负担**：布局编译器的路径生成器会**自然产出**零长段（M4 教训：`placeSeg` 包装器
    是每个调用方都要重写的样板）。工具应承担过滤，而非把防线推给每个调用方。
  3. **静默风险可控**：零长段没有方向歧义——**若传了 `r` 用 `r`，否则用 0（朝上）**，
     与 `place` 缺省一致；文档写明。不存在"方向写反被吞掉"的情形（方向写反的前提是两格不同）。
  4. **兼容方向是放宽**：旧的"2001 → 走备选路径"逻辑不受影响（不再触发而已）。
- 不选"报错 + 文档标注"的原因：它把一次**布局生成器的常规输出**变成每个调用方的
  异常处理路径，而这正是 M4 系列浪费时间最多的一类摩擦（`MILESTONE-M4-partial-and-pitfalls.md` 陷阱 #3）。

### 协议改动

```jsonc
// 之前
{"op":"place_path","building":"belt","from":[5,-2],"to":[5,-2]}  →  error 2001
// 之后（等价于 place {building:"belt", x:5, y:-2, r:0}）
{"ok":true,"op":"place_path","applied":1,"failed":[],"first_uid":13207,"uids":[13207],"tick":...}
```
- `r` 语义：显式 `r` 采用；缺省 0（**不是** 2001）。
- 文档同步：`docs/PROTOCOL.md:127` place_path 行加注"单点路径（from==to）合法，等价于 place 一格（r 缺省 0）"。

### 实现位置

- `src/mod/shapez-ai-bridge.js:1061-1063`（`if (dx===0 && dy===0) throw ...`）→
  删除该 throw；紧随其后的 `rot` 推导在 `dx===0&&dy===0` 时会落进 `else rot = 0`
  （`:1076-1079` 的 `dy>0 / dx` 分支——实际执行到 `else` 分支得 0，符合设计）——
  **仅需在 `len>5000` 检查前加一行注释**说明退化段语义。
- 无需动循环体：`len=1` 时循环天然只跑 `i=0`。

### 向后兼容性

- 行为放宽。**唯一要更新的**：`test/mod_selftest.mjs` 若有断言"同点报 2001"需改为新语义
  （当前检索：现有断言只测 diagonal→2001，`test/mod_selftest.mjs:331-340`，**无冲突**）。
- 研究脚本的 `placeSeg` 包装器可保留（无害），新代码不必再写。

### 测试方法

单测断言：`from==to` → `applied=1`、不抛错、`uids=[uid]`；带 `r:90` → 传给
`tryPlaceBuilding` 的 `rotation===90`；对角仍 → 2001。

---

## §4.5 新增工具 `play.mjs traffic`（离线存档解码带内物品）

### 为什么是"封装"而非"发明"

方法**全程实证**（H5b + M1b/M2a/M3/M4 的全部物流验证都靠它）：`save_now` → 读存档 `.bin` →
`decode_full.cjs` 解出全量 JSON → `dump.beltPaths[].items`。本设计把它固化为命令。

### ★ 先解决一个分发问题

`recon/decode_full.cjs` 在 **`recon/`（.gitignore 排除，不得随分发）**——新工具**不能依赖它**。
但该文件本身是干净的（零游戏代码，只 require `../src/shared/lz-string.cjs`）。
**做法**：把解码逻辑提取成 `src/shared/save-decode.cjs`（零依赖，逐行搬 `decode_full.cjs` 的
`decompressInt`/`decompressObjectInternal`/`decodeSave`），`recon/decode_full.cjs`
改为 3 行 shim（`module.exports = require("../src/shared/save-decode.cjs")`），研究脚本不变。

### 命令设计

```
node src/agent/play.mjs traffic [--region x0 y0 x1 y1] [--top N] [--json] [--file <save.bin>]
```

- 缺省：先 `save_now`（等完成，协议 §3）→ 读 `%APPDATA%/shapez.io/saves/savegame-<id>.bin`
  （目录推导与 `src/bridge/bridge.mjs:133-141 getSavesDir()` 相同，含 mac/linux 回退）。
- `--file`：跳过 `save_now`，直接解码给定文件（离线分析、CI 用）。
- 输出（人读表格 + `--json` 结构化）：

```
path @ (172,-41)→(172,-48)  len=8  items=5  head_spacing=0.00  [LOADED]
    ----RuRu  ----RuRu  RuRuRuRu
path @ (-27,-189)→(-27,-184) len=6  items=4  head_spacing=2.40  [flowing]
    blue blue blue blue
...
summary: 483 paths with items / 521 total; 17 saturated (head_spacing<0.63); 3 starving(empty,upstream miner)
```

- 物品提取：`z[1]?.data || String(z[1])`（实测颜色物品形如 `{ $:"color", data:"blue" }`，
  形状物品是裸字符串；`research/ai-player/exp-remote-belt-3.mjs:111` 已用此方式）。
- uid→坐标：`obj.dump.entities`（**实测**实体列表在 `dump.entities`，
  `dump.entityMgr` 只有 `nextUid`——见 `exp-remote-belt-3.mjs:87-97 uidToPos()`，直接搬）。
- `full`/`LOADED` 判定用 §4.3 的同一定义（`spacing_to_first < 0.63`）：**这意味着
  `traffic` 与 `obs include_belt_items` 共用一份 `beltLoad()` 工具函数**（放 `src/ai/traffic.mjs`），
  两条通道口径必须一致（见下测试）。

### 实现位置

| 改动 | 位置 |
|---|---|
| 提取解码器 | 新建 `src/shared/save-decode.cjs`（内容=现 `recon/decode_full.cjs:1-29`）；`recon/decode_full.cjs` 改 shim |
| 轨迹分析纯函数（uidToPos / pathSummary / beltLoad / regionFilter） | 新建 `src/ai/traffic.mjs`（从 `exp-remote-belt-3.mjs` 提取，输出结构化对象） |
| CLI 子命令 | `src/agent/play.mjs`（模式表 `:298-351` 加 `traffic` 分支 + usage 行） |
| 文档 | `README.md` 工具表 + `docs/PROTOCOL.md §11.6`（新节：离线观测通道，注明"非 RPC 方法，属于 agent 侧工具"） |

### 向后兼容性

纯新增子命令。`decode_full.cjs` 变 shim 后研究脚本无需改（`require` 结果相同，可加
`test/` 里一条断言锁定"shim 与原实现输出一致"——用 `facts/live/exp-remote-belt-3.result.json` 当夹具）。

### 测试方法

1. **离线单测**：对 `snapshots/ai-research-base.bin`（若存在）或任一 `.bin.backup` 跑
   `--file`，断言输出 schema（paths/items 字段齐全、计数>0）——**不需要游戏**。
2. **交叉对拍（决定性）**：实机 `obs {region, include_belt_items:true}` vs `traffic --region 同区`
   ——同一区域、同一 tick 附近的两次读数应一致（items 数允许有 1-2 个的时序差，
   用 `step 0` + 立即 `save_now` 收紧）：
   ```
   ⚠️ 判据：路径条数必须严格一致；items 数允许 ±2 且必须给出对拍记录。
   ```
3. 回归：`node test/save_decode_selftest.mjs`（新）：解码 `savegame-...bin.backup`（测试夹具）
   → 断言 `obj.dump.map.seed === 43391`、实体数 2805（level-11 基线，
   与 `facts/live/world-full.json` 一致）。

---

## 附：实现顺序与依赖

```
批次 1（半天）：§4.4 退化段（1 处删 throw + 测试）  ← 最小、立刻消除最高频摩擦
批次 2（半天）：§4.2 uids（10 行） + §4.1 only_uids（40 行）  ← 事务语义两半同时落地
批次 3（1 天） ：§4.3 include_belt_items（mod 40 行 + 测试） + §4.5 traffic（提取 + CLI）
批次 4（15min）：§4.0 的文档化（PROTOCOL §5/§6 注释段）
```

**全部完成后，`SYNTHESIS.md §4` 的 5 条（4.0-4.4）归零，且 §4.5 是净新增能力。**

## 未决项（诚实清单）

| 项 | 状态 | 怎么验 |
|---|---|---|
| `shapez.globalConfig` 在 mod 内可用性 | 【待验】（bundle.pretty.js:843 有导出声明，但未实机读） | 实机 `console.log(typeof shapez.globalConfig)`；不可用则 mod 侧 fallback 常量 `0.63`（config.js:86 已核证），agent 侧不依赖 mod 判定 |
| `obs include_belt_items` 与 `traffic` 的 items 数严格相等 | 【待验】 | 交叉对拍（§4.5 测试 2）；允许 ±2 的时序差需实测定界 |
| `only_uids` 对 wires 层实体的行为 | 【推断】layer 过滤沿用现有逻辑即可 | 单测加 `layer:"all"` + wires 实体用例 |
| `max_belt_paths` 缺省 200 是否够 | 【推断】level-11 实测有 521 条路径但大部分为空 | 实机统计；必要时按"有物品的路径优先"排序再截断 |
