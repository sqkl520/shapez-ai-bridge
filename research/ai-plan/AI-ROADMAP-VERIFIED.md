# 路线图的三条关键结论：独立核实

日期：2026-10-27
被核实对象：`AI-ROADMAP.md`
核实方式：源码行号 + 实机 RPC 实测

---

## 结论 1：`place` 今天就能放任何建筑（含未解锁的）

**规划 agent 的判断正确，已实机验证。**

### 源码依据

`recon/upstream-full/src/js/game/logic.js:61-100` `checkCanPlaceEntity`：
只查三件事 —— 格子碰撞（含 `getIsReplaceable`）、编辑器 `puzzleLocked`、
`prePlacementCheck` 信号。**没有 `getIsUnlocked`**。

解锁检查只存在于 HUD 层（`hud/parts/base_toolbar.js:254`），不拦 RPC。

### 实机验证（当前 L5 存档）

| 建筑 | 解锁等级 | `place` 结果 |
|---|---|---|
| storage | L15 | ✅ `code:21` |
| filter | L21 | ✅ `code:37` |
| wire | L20 | ✅ `code:27` |
| constant_signal | L22 | ✅ `code:31` |
| lever | L20 | 被拒（该格已被占用，不是解锁问题） |

**所以「28 种建筑只覆盖 12 种」这件事，限制的是编译器的规划能力，
不是 `place` 的调用能力。** 这是两条不同的路，不能混为一谈。

---

## 结论 2：`clone()` 做回滚是假回滚

**规划 agent 的判断正确，已核实。**

`recon/upstream-full/src/js/game/entity.js:88-106` 的 `clone()`：

```js
clone() {
    const clone = buildingData.metaInstance.createEntity({...});
    for (const key in this.components) {
        this.components[key].copyAdditionalStateTo(clone.components[key]);
    }
    return clone;
}
```

`copyAdditionalStateTo` 全仓**只有 4 个组件实现**：

```
components/constant_signal.js:21
components/goal_acceptor.js:64
components/lever.js:19
components/static_map_entity.js:86
```

`Belt` / `Storage` / `Filter` / `UndergroundBelt` **都没有实现**（基类是空 `{}`）。

⇒ clone 出来的 storage 是空的、filter 队列是空的、隧道在途货丢失。
用它做撤销 = 撤销后看起来对了、跑起来不对。**这是最隐蔽的一类坑。**

---

## 结论 3：恢复原语应该是 `serialize()`，不是 `clone()`

`recon/upstream-full/src/js/savegame/serializer_internal.js:44-68` `deserializeEntity`：

```js
deserializeEntity(root, payload) {
    const staticData = payload.components.StaticMapEntity;
    const data = getBuildingDataFromCode(staticData.code);
    const entity = data.metaInstance.createEntity({
        root, origin, rotation, originalRotation,
        rotationVariant: data.rotationVariant, variant: data.variant,
    });
    entity.uid = payload.uid;
    this.deserializeComponents(root, entity, payload.components);
    root.entityMgr.registerEntity(entity, payload.uid);
    root.map.placeStaticEntity(entity);
}
```

这就是现成的单实体重建器，**能保住 uid、组件状态、层级**。

`entity.js:78-83` 的 schema：
```js
{ uid: types.uint, components: types.keyValueMap(types.objData(gComponentRegistry), false) }
```

所以 `entity.serialize()` 给的就是完整可恢复状态。

**关键**：这 40 行用的全是实例方法（`serialize` / `deserialize` / `registerEntity` /
`placeStaticEntity`），**不需要 import `SerializerInternal`**，不依赖
`window.shapez` 是否暴露了那个类。这把「依赖未验证导出」的风险降到 0。

---

## 因此，事务层的可行边界是

| 能力 | 可行 | 依据 |
|---|---|---|
| 撤销新增 | 已能做到 | `opBulkDelete` + region 回滚 |
| 撤销删除（保住 uid/组件） | **可以** | `serializer_internal.js:44-68` |
| 撤销修改（组件状态） | 可以，仅限 `getSchema()` 字段 | `serializer_internal.js:80-100` |
| 跨 RPC 真事务（ACID） | **做不到** | 两次 RPC 之间世界在动 |
| 单次 RPC 内原子事务 | **可以，推荐** | 一次调用内无 tick 插入 |

**落地方案要分两段**：

```
形态 A（先做）：act { op:"tx", ops:[...] }
  快照 → 逐条执行 → 任一条硬失败则整体回滚
  这才是能承诺「要么全成、要么全不成」的那一层

形态 B（后做）：rpc transaction {action:"begin"|"commit"|"rollback"}
  必须永远带 atomic:false 和 tick_drift
  它是 savepoint，不是事务
```
