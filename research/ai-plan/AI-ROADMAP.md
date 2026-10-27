# AI 操控 shapez：可执行路线图（2026-10-27）

> 输入：`AI-CONTROL-GAPS.md` 的四项短板 + 本轮已修的 4 项。
> 方法：只读源码（`recon/upstream-full/src/js/`）+ 只读 RPC（`status`/`obs`/`production`）。
> 约束：本轮不做任何写操作。所有「完成判据」写成可直接跑的命令或可观测数字。

---

## 0. 一个必须先纠正的前提（影响后面所有判断）

**「28 种建筑只覆盖 12 种」这件事，只限制编译器，不限制 `place`。**

- `place` 的建筑表来自**运行期游戏注册表**：`src/mod/shapez-ai-bridge.js:1199-1232`
  （`shapez.gMetaBuildingRegistry.getEntries()` → `table.byId`），解析在 `:1531-1548`。
  也就是说 `place storage` / `place filter` / `place wire` **今天就能调**，只要 (a) 名字对得上，
  (b) 别的地方不拦。
- `src/ai/op-templates.mjs` 是**编译器的数据包**（文件头 `:31-41` 写明：P3 placer / P4 router /
  P5 validator / P6 emitter 的几何与 code 全从这里取）。它只有 19 条（`EMBEDDED` 从 `:250` 起，
  `AUX` 从 `:375` 起，`OP_TEMPLATES` 在 `:491`，`ALL_TEMPLATES` 在 `:501`）。
  **它缺条目 = 编译器不能规划/发射这条线，不等于调不动这个建筑。**

第二个相关事实：**`place` 目前不受解锁等级限制。**
`logic.tryPlaceBuilding` → `checkCanPlaceEntity`（`recon/upstream-full/src/js/game/logic.js:61-100`）
只查三件事：格子碰撞（含 `getIsReplaceable`）、编辑器 puzzleLock、`prePlacementCheck` 信号。
**没有 `getIsUnlocked`**。解锁检查只存在于 HUD 层（`hud/parts/base_toolbar.js:254`）。
所以 L5 存档里 RPC 现在就能放 storage/filter/wire。

这不是 bug 也不是漏洞，是一个**必须显式做出的产品决定**：

| 选项 | 含义 | 建议 |
|---|---|---|
| A. 保持「god mode」，在 `status.features` 里声明 `unlock_bypass: true` | AI 可以造任何建筑，但**造出来在真人视角是"作弊"** | 保留，但必须写进协议文档 |
| B. 在 `opPlace` 里加 `getIsUnlocked` 校验，未解锁 → 2002 + `unlock_level` | 与真人完全同构，但 L5 阶段能测的建筑仍是那 12 种 | 作为 `strict_mode` 开关 |

**结论：建筑覆盖的优先级问题，本质不是"放不放得下"，而是"编译器能不能把产线规划到它上面"。**
下面的 §2 按这个口径排。

---

## 1. 事务层：能不能做？（明确判断）

### 1.1 结论先行

| 能力 | 可行性 | 依据 |
|---|---|---|
| 游戏自带 undo / revert | **不存在** | 全仓 grep `undo\|Undo\|revert\|Revert` 命中 **0**。`logic.js` 只有 `tryPlaceBuilding` / `tryDeleteBuilding`（`:117-133` / `:209-226`），无反向操作 |
| 撤销**新增**（删除自己加的） | **已能做到** | `opBulkDelete`（`bridge:2064+`）+ `gates.mjs:1295` 的 region 回滚。已知局限写在 `gates.mjs:1300-1345`（只能区域删、region 混入旧实体就拒、靠 tick drift 判完整性） |
| 撤销**删除**（凭快照重建） | **可以，且能保住 uid / 组件 / 层级** | `recon/upstream-full/src/js/savegame/serializer_internal.js:44-68` 就是现成的单实体重建器 |
| 撤销**修改**（组件状态，如 storage 里存了多少） | **可以，但只覆盖 `getSchema()` 里的字段** | `entity.js:78-83` 的 schema 是 `components: keyValueMap(objData(gComponentRegistry))`；`deserializeComponents`（`serializer_internal.js:80-100`）逐组件回灌 |
| 跨 RPC 的 `begin`/`commit`/`rollback` 作为**真事务** | **做不到** | 游戏主循环在两次 RPC 之间继续跑：`gates.mjs:1355-1366` 实测 10 次回滚里 tick 漂移常态 0.025~0.067 游戏秒，最长接近 1 秒。带子在动、storage 在填、hub 在收货 |
| 单次 RPC 内的**原子事务**（快照→执行→失败回滚） | **可以，推荐做成这个** | 一次调用内无 tick 插入；`performBulkOperation`（`logic.js:170-182`）已提供"屏蔽中间重算"的批语义 |

**一句话：** 你的 `transaction{begin/commit/rollback}` 方案**能做，但语义要改**。
它不能是数据库事务，只能是一个 **世界结构级的 savepoint / undo point**。
真正需要原子性的场景（一次贴 200 格，第 137 格失败）应该走**单调用内的 `transaction{ops:[...]}`**，
失败自动回滚——这才是能给出「要么全成、要么全不成」承诺的那一层。

### 1.2 恢复原语：为什么是 `serialize()` 而不是 `clone()`

**不要用 `entity.clone()`。** `entity.js:88-106` 的 clone 只调
`copyAdditionalStateTo`，而全仓**只有 4 个组件实现了它**：
`static_map_entity.js:86`、`constant_signal.js:21`、`goal_acceptor.js:64`、`lever.js:19`。
`Belt`、`Storage`、`Filter`、`UndergroundBelt` 的 `copyAdditionalStateTo` 都是空实现
（基类 `component.js:25` 是 `{}`）。
⇒ **clone 出来的 storage 是空的、filter 队列是空的、隧道里在途的货掉了。**
用它做撤销 = 撤销之后工厂看起来对了、跑起来不对。这是最隐蔽的一类坑。

**正确原语**（三条都已在源码里）：

1. `entity.serialize()` → 完整的 `{uid, components:{StaticMapEntity:{...}, Storage:{storedCount,storedItem}, Filter:{pendingItemsToLeaveThrough,...}, ...}}`
   （`entity.js:78-83` + `savegame_serializer.js:33-46` 的 `serializeEntityArray`）
2. `metaInstance.createEntity({root, origin, rotation, originalRotation, rotationVariant: data.rotationVariant, variant: data.variant})`
   —— `rotationVariant/variant` **从 code 反查**，`serializer_internal.js:48-60` 就是这么做的
3. `entity.components[id].deserialize(payload.components[id], root)` 逐组件回灌
   （`serializer_internal.js:80-100`），然后 `registerEntity(entity, payload.uid)` + `map.placeStaticEntity(entity)`
   —— `registerEntity(entity, uid)` 支持显式 uid（`entity_manager.js:64-93`，dev 下还会断言 uid 不冲突 `:70-73`）

这份逻辑**不需要 import `SerializerInternal`**：把 `serializer_internal.js:44-68` + `:80-100`
的 40 行抄进 bridge 即可，用的全是实例方法（`serialize` / `deserialize` / `registerEntity` / `placeStaticEntity`），
不依赖 `window.shapez` 里有没有暴露 `SerializerInternal`。**这一点很关键——它把"依赖未验证的导出"的风险降到 0。**

### 1.3 哪些状态**不在**序列化里（必须显式重建，否则撤销"部分成功"）

| 状态 | 存在哪 | 序列化？ | 重建办法 |
|---|---|---|---|
| `Belt.assignedPath` | `components/belt.js:57`（注释明写 *not serialized*） | ❌ | `systems/belt.js:423 recomputeAllBeltPaths()`；路径数据本身可 `serializePaths()`/`deserializePaths()`（`belt.js:74-105`） |
| `BeltPath.items`（带子上在途的货） | `belt_path.js:76` | ✅（`BeltPath.serialize`，`serializePaths` 会带） | 想保住就得连 `beltPaths` 一起快照；不想保就 `recomputeAllBeltPaths()` 接受"在途货清零" |
| `Wire.linkedNetwork` / `WireTunnel.linkedNetworks` / pin `linkedNetwork` | `wire.js` 组件 | ❌（运行时） | `systems/wire.js:155 recomputeWiresNetwork()` |
| `nextUid` | `entity_manager.js:44-48`（schema 只有这个字段） | ✅ | 快照 `root.entityMgr.nextUid`，回滚后取 `max(nextUid, maxRestoredUid+1)` |
| hub 库存 / 等级 | `root.hubGoals` | ✅ 但不在实体里 | 事务若可能扣费（`paste_blueprint charge:true`），必须把 `storedShapes` 一起快照 |
| 地图 chunk 的缓存 | `map_chunk.js` | — | `placeStaticEntity`/`removeStaticEntity` 会写 chunk（`map.js:234-262`），回滚走同一对函数即可 |

**⇒ 完整快照 = `{entities[], beltPaths[], nextUid, hubStoredShapes}`。**
L5（180 实体）下实测量级：单实体 JSON 约 200~400 B，整包 **60~90 KB**，一次 RPC 内拍/存无压力。
L30 万实体级别会到 MB 级——那时再退化成「只快照事务区间内的 uid」（见 1.4 的 P1 优化）。

### 1.4 建议的落地形态（两段，不要合成一个）

```
# 形态 A（先做，2~3 天）：单调用原子事务
act { op:"tx", ops:[ {op:"place",...}, {op:"delete",...}, ... ] }
  → 内部：快照 → performBulkOperation(逐条执行) → 任一条硬失败则整体回滚 → 返回 {applied, rolled_back, failures, diff}
  → 硬失败定义：2001/2002/2003（game_rejected 也算）；1003/1004 立刻中止

# 形态 B（后做，跨 RPC savepoint，明确标注"非原子"）
rpc transaction { action:"begin"|"commit"|"rollback", id? }
  begin  → 快照，返回 {tx_id, entity_count, tick}
  commit → 丢弃快照，返回 diff（新增/删除/修改各多少）
  rollback → 按 uid diff 回滚，返回 {restored, destroyed, modified, skipped[], tick_drift}
  → 响应里必须永远带 `atomic:false, tick_drift:<秒>`，让调用方知道这段时间世界在动
```

回滚算法（形态 A/B 共用）：

1. `cur = 当前 entities 的 uid → serialize()`；`snap = 快照`
2. `added = cur - snap` → `tryDeleteBuilding` 逐个（**不走 region**，避免误伤；这正是 `gates.mjs:1332` 卡住的地方）
3. `removed = snap - cur` → 先校验目标格全空（`map.getLayerContentXY`，`layer` 取自 `meta.getLayer()`，
   `meta_building.js:217`），任一格被占 → 该实体记 `skipped` 并**整体判回滚失败**（不要"能恢复几个算几个"，
   那会造出半个工厂）
4. `common` 且 `serialize()` 不等 → 逐组件 `deserialize` 回灌（这一步能救回"被 paste 覆盖掉的旧实体"，
   前提是第 3 步已把它重建出来）
5. 收尾：`nextUid` 修正 → `recomputeAllBeltPaths()` → `recomputeWiresNetwork()`（若有 wire 实体）
6. 返回 `diff` + `skipped[]`；`skipped.length > 0` ⇒ `ok:false`（回滚不完整必须响亮）

**不要做的事**：不要用 region 删除做回滚。`gates.mjs:1300-1345` 已经用血写明了：
新实体和旧实体混在同一 bbox 时，region 回滚只能拒，而"最需要回滚的场景"恰好就是那个场景。

### 1.5 无法消除的边界（写进协议，别让调用方误以为有 ACID）

- **时间不可回滚。** 回滚后 `tick` 一定前进了，带子上的货、hub 已交付数、production 统计不会退。这是物理事实。
- **跨 RPC 事务期间，第三方系统会改世界。** 例如 `BeltSystem` 挂在 `entityAdded` 上重算邻居 rv
  （`systems/belt.js:63,117-210`，唯一豁免是 `immutableOperationRunning`，`:169`）。
  所以形态 B 的 begin 之后如果只放了一格就 commit，邻居带的 rv 可能已经被改了 —— 这属于"世界在动"，不算事务失败。
- **`block` / `constant_producer` 在正常模式不可删/不可得**（`buildings/block.js:30`、`constant_producer.js:34`
  的 `getIsRemovable` 都只返 `root.gameMode.getIsEditor()`），别把它们纳入事务覆盖范围。

### 1.6 事务层完成判据（可执行）

```bash
# T1 撤销删除：删 12 格带子 → rollback → 逐实体比对
node -e "…place 12 belt…; delete 12; tx rollback"
#   判据：obs 的 entity_count 前后相等；12 个 uid 的 {code,rotation,rotationVariant,layer} 与删除前逐一相等
#   （uid 必须相同，否则只是"看起来一样"）

# T2 原子性：一个 tx 里第 7 条非法 → 整体无副作用
#   判据：entity_count 前后相等 且 obs 里那 6 格全空

# T3 状态还原：storage 里塞 5 件 → 删 storage → rollback
#   判据：obs 该 storage 的 stored_count == 5（不是 0）

# T4 带子在途货：4 格带上跑货 → 删中间一格 → rollback
#   判据：beltPaths 恢复后 path 数与删除前相等（items 允许丢，但必须如实报 lost_items）
```

---

## 2. 16 个缺失建筑：哪些真能提升能力

判据只有一个：**加上它之后，AI 能造出以前造不出的什么东西。**
「能放」不算（§0 已说明今天就能放），「能规划」才算。

### 2.1 分层结论

| 层 | 建筑 | 判定 | 理由（源码） |
|---|---|---|---|
| **P0 必补** | `storage` | ✅ 真提升 | 唯一能**缓冲**的元件，且有 2 进 2 出（`storage.js:56-108`）。AI 现在没有任何"等货/攒批/削峰"手段，只能靠带子当队列。解锁 **L15**（`modes/levels.js:275-278`） |
| **P0 整包** | `wire` `wire_tunnel` `constant_signal` `lever` | ✅ 真提升（**必须一起补**） | 这是**控制平面**。单个 `wire` 只是装饰，但 `constant_signal` + `filter` 组合出「按形状分流」——AI 目前做不到任何条件路由，只能靠拓扑硬连。解锁：wire/lever **L20**（`:313-318`）、wire_tunnel 同 L20、constant_signal **L22**（`:327-333`） |
| **P0.5** | `filter` | ✅ 真提升，但**单独补毫无意义** | `systems/filter.js:55-60`：`if (!network || !network.hasValue()) return false;` —— **没有信号网络的 filter 连一件货都不收**。它必须排在 wire+constant_signal 之后 |
| **P1** | `logic_gate` `transistor` | ⚠️ 有条件提升 | 只做信号布尔运算，消费端只有 filter/display。没有它们，filter 只能由 constant_signal 静态设一个形状；有了才能"按条件切换"。解锁 **L24**（`:341-348`） |
| **P1** | `display` | ⚠️ 弱提升 | 1×1 输出设备（`display.js:34-55`）。对 AI 的真实价值是**在游戏内可见**（人机共视/截图核对），不是新增产能。解锁 **L23** |
| **P2** | `analyzer` | ⚠️ 弱提升 | 需 L25，且 obs/production 已经把"线上是什么形状、多快"全给了。它只补"把形状读成信号"这一环，属于自适应工厂的必要件但非当前瓶颈 |
| **P2** | `comparator` | ❌ 当前无收益 | L25，只做信号比较；没有虚拟处理器/复杂逻辑时无处发力 |
| **P3** | `virtual_processor` | ❌ 当前无收益 | L25，语义是"跑用户程序"。要补得连程序文本的读写/编辑一起做，工作量远超其它 15 个之和 |
| **出范围** | `block` | ❌ 不做 | `block.js:30` `getIsRemovable` 只返编辑器；正常模式既不可删也不可点选 |
| **出范围** | `constant_producer` | ❌ 不做 | `constant_producer.js:34` 同上，编辑器/谜题专用 |
| **不补** | `reader`（belt reader） | ❌ 不做，RPC 更强 | `production` RPC 已经给 `produced_per_sec` / `delivered_per_sec` / 切片（实测本档 L5：`RuRuRuRu 1.117/s`）。读者机测的是同一样东西，精度还更低 |

> 一句话总结优先级：**storage 一个人就是一个台阶；wire 族是一整层楼，但必须四件一起进（wire+wire_tunnel+constant_signal+lever），filter 是这层楼的第一个房间。**

### 2.2 每个推荐项的几何真值位置 / 工作量 / 解锁等级

**结构参照**：`op-templates.mjs` 一个条目（以 `balance` 为例，`:406-427`）是
`{op, building, variant, code, unlockLevel, footprint, inputs[], outputs[], ratePerSec, mustDiscardUnused, wasteRoles[], verifiedOnLive, codeVerifiedOnLive?, kind, note?}`，
**12~22 行**；再加 `codeFor` 的 `MACHINE_CODES` 一行（`:138` 起）、`RV_ALLOWED` 一行（`:113-118`）。
所以单建筑 ≈ **20 行数据 + 1 条自测 + 1 条实机验证**。

| 建筑 | op 名（建议） | 几何真值来源 | footprint | 槽位摘要 | code | 解锁 | 工作量 |
|---|---|---|---|---|---|---|---|
| storage | `store` | `buildings/storage.js:40-42`（2×2）、`:56-108` | 2×2 | ejector top @(0,0)(1,0)；acceptor bottom @(0,1)(1,1)；WiredPins left/right @(0,1)(1,1) | 21 | L15 | **0.5 天**（条目 + `stored_count` 进 obs） |
| wire | `wire` | `buildings/wire.js:40-95`（8 个 internalId）、`:97-99`（1×1）、`:114`（layer=wires） | 1×1 | 无物品槽；`WireComponent`，rv 0/1 表朝向 | 27-30, 52-55 | L20 | **1 天**（8 个 rv 组合 + layer 语义） |
| wire_tunnel | `wireTunnel` | `buildings/wire_tunnel.js:16-23, 51-57` | 1×1 | `WireTunnelComponent`，不可旋转 | 39 | L20 | **0.3 天** |
| constant_signal | `constSignal` | `buildings/constant_signal.js:17-20, 42-65` | 1×1 | 1 个 WiredPins ejector；**值可变**（`components/constant_signal.js:21` 有 copyAdditionalStateTo） | 31 | L22 | **0.5 天** + 需要"怎么设值"的 op（`set_signal`） |
| lever | `lever` | `buildings/lever.js:14-17, 35-56` | 1×1 | 1 个 WiredPins；布尔 toggle | 33 | L20 | **0.3 天** |
| filter | `filter` | `buildings/filter.js:38-39`（2×1）、`:58-108` | 2×1 | acceptor bottom @(0,0)；ejector top @(0,0) + right @(1,0)；WiredPins left @(0,0) | 37 | L21 | **1.5 天**（几何 0.5 + 编译器"分流节点"0.5 + 闸 0.5） |
| logic_gate | `logicGate` | `buildings/logic_gate.js:44-80`（4 个 internalId 32/34/35/36）、`:81-82` | 1×1 | 2 进 1 出 WiredPins，4 种算子 | 32,34,35,36 | L24 | 1 天 |
| transistor | `transistor` | `buildings/transistor.js:25-40`、`:54-55` | 1×1 | 2 进 1 出（data/control），2 个变体 38/60 | 38, 60 | L24 | 0.5 天 |
| display | `display` | `buildings/display.js:14-17, 34-52` | 1×1 | 1 个 WiredPins acceptor | 40 | L23 | 0.3 天 |

**关键依赖链（必须按这个顺序，否则返工）：**

```
storage (L15)  ──────────────────────► 独立，可先做
wire + wire_tunnel + lever (L20) ─────► constant_signal (L22) ──► filter (L21，实际按奖励顺序在 L20 之后)
                                                              └─► logic_gate + transistor (L24) ─► comparator/analyzer (L25)
```

⚠️ **顺序坑**：奖励表里 filter 在 **L21**、constant_signal 在 **L22**（`levels.js:320-333`）。
也就是说玩家拿到 filter 时**还没有 constant_signal**，只能用 lever 的布尔值（pass-all / reject-all）。
真正"按形状分流"要等到 L22。**这决定了 filter 的验收闸必须用 constant_signal 设值，不能只靠 lever 蒙混过关。**

---

## 3. 可执行路线图（按"AI 能多做哪些事"排序，不按难度）

排序原则：**先让 AI 敢动手（可回滚）→ 再让它看得见变化（增量观测）→ 再让它能表达更多产线（建筑）→ 最后才是自动化闭环。**

### 阶段 0：基线固化（0.5 天，无依赖）

- **交付物**：把本轮 4 项修复写成回归闸 `G9-load-root` / `G10-rv-selfcheck` / `G11-concurrent-12` / `G12-screenshot-region`，
  加进 `src/agent/gates.mjs` 的 `runGates`。
- **完成判据**：
  - `node src/agent/gates.mjs --self-test` 退出码 0，打印的用例数从 193 → ≥ 200。
  - `G11`：并发 12 个 `place` 后 `obs.stats.total` 增量 == 12（不是 ≥1）。
  - `G10`：`place belt r=90 rv=1` 返回 `mismatch:false && actual.code==2`。
- **依赖**：无。

### 阶段 1：事务（**最高优先，因为它是"敢试"的前提**）（3~4 天）

- **交付物**：
  1. `op:"tx"`（形态 A，单调用原子）—— `bridge` 内新增 `opTransaction` + `snapshotWorld` / `restoreWorld`
  2. `rpc transaction`（形态 B，savepoint，响应永远带 `atomic:false`）
  3. `op:"delete_uid"`（按 uid 删，补上 `gates.mjs:1332` 卡住的那块）
  4. 协议文档写明 1.5 的三条边界
- **完成判据**（全部可跑）：
  - §1.6 的 T1~T4 全绿，**且 T1 要求 uid 逐一相同**。
  - 形态 A：一个 200 条的 tx 里第 137 条非法 → `obs.entity_count` 前后严格相等，返回 `rolled_back:true, restored:<n>`。
  - 形态 B：begin → 删 3 格 → rollback → 3 个 uid 回来，`skipped:[]`，`tick_drift` 如实 > 0。
  - 回滚耗时：180 实体档 `< 150 ms`（用 `tx.rollback_ms` 自报，跑 10 次取 p95）。
- **依赖**：无（恢复原语已在源码里，见 §1.2）；但 `delete_uid` 必须先于回滚算法落地。

### 阶段 2：增量观测（"只告诉我变了什么"）（2~3 天）

- **交付物**：
  1. `obs` 新增 `since:<tick|token>` 参数 —— 返回 `{added[], removed_uids[], changed[]}`，只给增量
  2. 服务端维护一个 ring buffer（建议 4096 条 / 覆盖最近 200 游戏秒），满了就降级为 `full_required:true`
  3. `obs` 里实体条目补 `stored_count`（storage 用）、`signal`（wire 用）—— 否则补了 storage 也看不见它存了什么
- **完成判据**：
  - 180 实体稳定档：`obs?since=<t>` 的响应字节数 **< 全量 obs 的 10%**（实测全量 `max_entities:2000` 是 ~30 KB）。
  - 一次 `paste_blueprint` 50 格后，`obs?since` 的 `added.length == 50` 且 `removed_uids.length == 0`。
  - `obs?since` 在 ring buffer 过期时返回 `full_required:true` 而不是静默给空数组（**静默给空 = AI 会以为世界没变**）。
- **依赖**：与阶段 1 并行（都改 bridge，但函数不重叠）。

### 阶段 3：建筑真值（storage 先行，wire 族整包）（4~6 天）

- **交付物**：
  1. `op-templates.mjs` 补 `store`（1 条）+ wire 族 5 条（wire/wireTunnel/constSignal/lever/filter），全部带 `unlockLevel` 与 `verifiedOnLive:false`
  2. 新 op `set_signal`（给 constant_signal / lever 设值）—— **没有它，filter 无法被验收**
  3. 编译器支持"分流节点"（`filter` 作为 condition 节点）；`storage` 作为 buffer 节点
- **完成判据**：
  - `node src/ai/op-templates.mjs --test` 全绿，`ALL_TEMPLATES` 从 19 → 25 条，`crossCheckCodes` 无冲突。
  - 实机：`place storage` → `place belt` 两条进 → `obs` 能看到 `stored_count` 随 tick 增长到上限。
  - 实机：`wire`(L20) 铺 3 格 → `constant_signal` 设为 `RuRuRuRu` → `filter` 接上 → 混合输入中只有 `RuRuRuRu` 从 top 出、其余从 right 出（**用 `obs` 的实体位置变化证明，不靠截图**）。
  - 反向闸：同一条线**不设信号**时必须 `stored_count` 恒 0（证明 2.1 里"filter 无网络不工作"这条真值被代码承认）。
- **依赖**：阶段 2 的 `obs.stored_count`（否则无法验收）；阶段 1 的 `tx`（否则搭错线没法回滚）。

### 阶段 4：结构化错误 + 下一步（1~2 天）

- **交付物**：统一错误信封
  ```json
  { "code": 2002, "code_name": "game_rejected",
    "detail": "cannot place belt at (3,4)",
    "blocker": { "uid": 4127, "type": "belt", "rot": 90, "removable": true },
    "next": [ {"op":"delete","x":3,"y":4}, {"op":"place","building":"belt","x":3,"y":4} ] }
  ```
  覆盖 `place` / `delete` / `paste_blueprint` / `bulk_delete` 四类拒绝。
- **完成判据**：
  - 对每一类拒绝（占用 / 不可删 / 越界 / 蓝图 0 落地 / 材料不足），`next` 数组非空且**把 `next` 原样回灌能成功**（写成一条自动闸 `G13-next-action`：取 `error.next[0]` 执行 → 必须 `ok:true`）。
  - `describeTileOccupant`（`bridge:2040`）已经有一半信息（uid/type/rot），把它提升成结构化字段而不是字符串。
- **依赖**：阶段 1（`error.next` 里会出现 `delete_uid`）。

### 阶段 5：闭环（可选，视是否需要"无人值守"）（3 天+）

- **交付物**：`watch {until, max_ticks}` 返回"满足条件的那一刻的增量 obs"，替代 `step + obs` 的两跳。
- **完成判据**：一次 `watch{until:"hub_delivered_increased"}` 的往返数 = **1**（现在是 2+），且返回值里 `diff.delivered_delta > 0`。
- **依赖**：阶段 2。

**总工期**：阶段 0~4 ≈ **11~16 人日**；阶段 1 单独可交付，且在它完成前不建议让 AI 做任何大规模 paste。

---

## 4. 下一轮该派哪些 agent

要求：非平凡任务先规划、再并行 ≥5 个专家。下面是清单，**按依赖分三波**。

### 第一波（可并行 5 个，互不阻塞）

| # | 角色 | 输入 | 产出 | 验收标准 |
|---|---|---|---|---|
| A1 | **事务核心工程师** | §1.2 的三条原语 + `serializer_internal.js:44-68,80-100` | bridge 新增 `snapshotWorld`/`restoreWorld`/`opTransaction`/`opDeleteUid` | T1~T4 全绿；uid 逐一相同；回滚 p95 < 150ms |
| A2 | **序列化还原专家**（与 A1 强耦合，先跑半天给 A1 交接口） | `entity.js:78-106`、`components/{storage,filter,belt,underground_belt}.js` | 一份「哪些组件状态能/不能还原」的实测矩阵 + `restoreEntity(payload)` 独立函数 | 能对 storage/filter/belt/tunnel 各造一个带状态的实体，serialize→destroy→restore 后逐字段相等 |
| A3 | **建筑真值工程师** | `buildings/storage.js`、`wire.js`、`wire_tunnel.js`、`constant_signal.js`、`lever.js`、`filter.js` | `op-templates.mjs` 新增 6 条 + `set_signal` op 设计 | `node src/ai/op-templates.mjs --test` 全绿；`ALL_TEMPLATES` 19→25 |
| A4 | **增量观测工程师** | `bridge` 的 `observe()`/`validateObsRequest`（`:1367-1404`）、`captureDiffBaseline`（`:2328`） | `obs since` + ring buffer + `full_required` 降级 | 增量响应 < 全量 10%；过期时 `full_required:true` |
| A5 | **错误契约工程师** | `bridge:2040` `describeTileOccupant`、全部 `rpcError` 调用点 | 统一错误信封 + `next[]` | `G13-next-action` 闸：回灌 `next[0]` 必须成功 |

### 第二波（依赖第一波，2 个）

| # | 角色 | 输入 | 产出 | 验收标准 |
|---|---|---|---|---|
| A6 | **编译器接线** | A3 的模板 + `src/ai/compiler/{place,emit,validate}.mjs` | 编译器能规划 storage buffer 与 filter 分流节点 | 编译一条"混合输入 → 按形状分流 → 各自入 hub"的线，`gates --apply` 全绿 |
| A7 | **回归闸守门人** | A1/A4/A5 的产出 | `gates.mjs` 新增 G9~G13 | `--self-test` ≥ 200 例全绿；任何一条闸在故意破坏下必须变红（红队验证） |

### 第三波（1 个，收口）

| # | 角色 | 输入 | 产出 | 验收标准 |
|---|---|---|---|---|
| A8 | **端到端验收** | 全部 | L5 存档上一条完整链路：`tx begin` → 建 6 条带 + 1 storage + 1 filter + 1 constant_signal → 跑 60 tick 看到分流 → `tx rollback` 回到起点 | 回滚后 `obs` 的 uid 集合与开始前**完全相等**；`production` 的 `delivered_total` 不回退（时间不可回滚是预期） |

**依赖顺序（明确）：**

```
A2 ──(接口)──► A1 ──► A6 ──► A8
A3 ──────────────► A6
A4 ──► A3(验收)  ──► A8
A5 ◄── A1(delete_uid)
A7 全程跟跑，最后一波前必须全绿
```

**并行度**：第一波 5 个同时开；A2 必须在 A1 动手前给出 `restoreEntity` 接口（半天），否则 A1 会自己写一套、返工。
**不要**让 A1 和 A2 各自实现一遍恢复逻辑——这是本轮最容易产生的重复劳动。

---

## 5. 三条最容易踩的坑（来自本轮源码核对）

1. **用 `entity.clone()` 做撤销 = 假回滚。** `copyAdditionalStateTo` 只有 4 个组件实现（`component.js:25` 是空基类），
   storage 的内容、filter 的队列、隧道里的在途货全都丢。必须走 `serialize/deserialize`。
2. **filter 单补无用。** `systems/filter.js:55-60` 没有信号网络直接 return false。任何"补 filter"的任务如果不带
   `constant_signal` + `wire`，做出来的东西一件货都不收，会被误判成"几何错了"。
3. **region 回滚在"新旧实体共格"时必然失败**（`gates.mjs:1300-1345` 已用实测写明）。
   按 uid 删不是优化，是正确性问题。

---

## 附：本轮用到的源码锚点（便于复核）

| 主题 | 位置 |
|---|---|
| 放置 / 删除 / 可放判定 | `game/logic.js:61-100`、`:117-133`、`:140-164`、`:209-226` |
| 批量 / 不可变批 | `game/logic.js:170-182`、`:188-203` |
| 实体注册（显式 uid） | `game/entity_manager.js:64-93`、`:99-101`、`:199-216`、`:222-240` |
| 实体 schema / clone | `game/entity.js:78-83`、`:88-106` |
| 地图静态实体读写 | `game/map.js:234-245`、`:251-262` |
| 单实体重建（恢复原语） | `savegame/serializer_internal.js:44-68`、`:80-100` |
| 存档序列化顺序 | `savegame/savegame_serializer.js:33-46`、`:127-142` |
| 带子路径 | `systems/belt.js:74-105`、`:423-475`；`components/belt.js:54-57` |
| 电线网络重算 | `systems/wire.js:155-171` |
| filter 依赖信号 | `systems/filter.js:55-60` |
| 解锁等级 | `modes/levels.js:266`(L14)、`:275-278`(L15)、`:313-318`(L20)、`:320-325`(L21)、`:327-333`(L22)、`:335-348`(L23/24)、`:350-356`(L25) |
| 解锁只在 HUD 拦 | `hud/parts/base_toolbar.js:254` |
| 建筑层 | `game/meta_building.js:217` |
| bridge 建筑表 | `src/mod/shapez-ai-bridge.js:1199-1232`、`:1531-1548` |
| bridge 现有回滚 | `src/agent/gates.mjs:1295-1370` |
