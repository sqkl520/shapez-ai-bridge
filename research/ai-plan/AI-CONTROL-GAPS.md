# AI 操控能力的短板盘点（2026-10-27）

目标不是"打通关卡"，而是**让 AI 能更好地操控 shapez**。
本文记录现阶段实测到的能力缺口，按"对 AI 能做什么的制约"排序。

---

## 已有能力

### 读（12 个 RPC）
```
status  obs  debug_items  debug_loop  debug_log  resources  production
world_info  debug_canvas_api  debug_app_state  list_saves  game_setting
```

### 写（15 个 op）
```
place  place_path  delete  bulk_delete  paste_blueprint  export_blueprint
set_speed  step  await  camera  save  load  new_game  upgrade  noop
```

### 验证层
`src/agent/gates.mjs`：G2' 同源自洽 / G-1 时钟 / G3 净空 / G4 落地 /
G6 行为 / G6b 连通 / G7 逐格流向 / G8 链划分。193 条自测。

### 截图
按 `region` 离屏渲染，不画 HUD，可跳过 hub 面板。

---

## 短板 1（已修）：加载假成功

**症状**：`new_game` / `load_save` 回 `ok:true`，但 world 没建起来，
`status.in_game` 一直 false，只能重启进程。

**根因**（这次查实了）：

`core/state_manager.js:58`
```js
moveToState(key, payload = {}) {
    if (window.APP_ERROR_OCCURED) {
        console.warn("Skipping state transition because of application crash");
        return;          // ← 静默返回，什么都不做
    }
```

游戏崩过一次后，`APP_ERROR_OCCURED` 被置真，**之后所有状态切换都被静默跳过**。
而 `InGameState` 的 `onRender` 也检查它（`states/ingame.js:431`）：
```js
if (window.APP_ERROR_OCCURED) { return; }   // 不渲染、不加载
```

所以"切到 InGameState 但什么都没发生"的直接原因就是这个标志。

**修法**：
1. 判据从 `currentState.getKey() === "InGameState"` 改成 **`this.root` 非空**
   —— root 只由 `gameStarted` 信号注入，是"world 真的建好了"的唯一权威判据
2. 超时时调 `debugAppState()` 报出根因，并区分两种失败：
   - `APP_ERROR_OCCURED=true` ⇒ 重试无用，必须重启进程
   - 没崩但 root 不来 ⇒ 加载卡住，可以重试

**新增 RPC** `debug_app_state`，暴露：
```
state_key  ingame_stage(s1..s10)  root_present  app_error_occurred
state_manager_keys  savegame  page_visible  focused  loading_overlay_attached
```

**实测验证**：加载成功后 `state=InGameState stage=s10_gameRunning root=true crashed=false`。

---

## 短板 2：`place` 表达力不足

**症状**：`place` 传 `r` 放不出指定 rv 的转角。

**根因**：带子的弯道变体由 `computeOptimalDirectionAndRotationVariantAtTile`
（`buildings/belt.js:160-250`）按**放置那一刻的邻居**猜，之后不重算。

实测：

| 操作 | 结果 |
|---|---|
| `place belt r=0` @ `(10,-11)` | code=1（直带） |
| `place belt r=90` @ `(10,-11)` | code=1（**还是直带**） |
| 先放邻居再放它 | 仍 code=1 |
| `paste_blueprint` code=2 | code=2 ✓ 真正的转角 |

**已有内部能力**：`placeOne(..., rotationVariantOverride, ...)` 支持指定 rv，
只是 `opPlace` 没暴露。

**修法**（进行中）：给 `place` 加 `rotationVariant` 字段，并在返回里带
`requested` / `actual` / `mismatch`，放完读回实际 code 自证。

---

## 短板 3：没有事务 / 撤销

游戏**没有 undo 系统**（搜遍源码无 `undo`）。mod 层也没有。

现状：记录 before 快照 → 失败时按 uid 删回去。局限：
- 只能撤销"新增"，不能撤销"删除"和"修改"
- 跨多个 RPC 没原子性
- 回滚本身可能失败

**这是 AI 操控的核心短板**：要敢做实验，就得能可靠地退回去。
现在的"能回滚"只覆盖一半情况。

---

## 短板 4：游戏能力有大片没暴露

游戏有 **28 种建筑**，`op-templates.mjs` 只覆盖 **12 种**：

```
覆盖：  balancer belt cutter hub miner mixer painter rotater stacker trash underground_belt
缺：    analyzer block comparator constant_producer constant_signal display filter
        goal_acceptor item_producer lever logic_gate reader storage transistor
        virtual_processor wire wire_tunnel
```

缺的里面按价值排：

| 建筑 | 价值 | 说明 |
|---|---|---|
| **storage** | 高 | 缓冲/吞吐整形，AI 做"等货"逻辑必需 |
| **filter** | 高 | 按形状分流，多目标工厂的基础 |
| **transistor / logic_gate / comparator** | 中高 | 逻辑网络，能做出自适应工厂 |
| **wire / constant_producer / lever** | 中 | 信号网络，动态控制 |
| **display / reader / analyzer** | 中 | 读状态、做反馈 |
| **virtual_processor** | 低（当前） | 复杂产线才需要 |

这些不在 `op-templates` 里，意味着**布局编译器和 gates 的判据都不知道它们存在**，
`obs` 能读到（`type` 是游戏 id），但没有任何几何/槽位真值。

---

## 短板 5：观测是拉取式，不是事件驱动

游戏本身有信号系统（`hub_delivered_increased` / `level_increased` / `entities_changed`），
`await` 能等。但观测仍是"全量拉 180 个实体"。

AI 做"放一个 → 看效果 → 再放"的循环时，每步都要全量拉一遍。
没有"只告诉我变了什么"的接口。

---

## 短板 6：错误信息不带可执行的下一步

`place` 失败回 `cannot place belt at (x,y)` + `describeTileOccupant` 的 hint。
但没有结构化的"这格被谁占、它是什么类型、能不能删"。

对于 AI 来说，"能不能删"是个可判定的问题（看那格的实体类型和 uid），
应该直接给出来而不是让调用方再查一次。

---

## 优先级建议

按"修好之后 AI 能多做哪些以前做不到的事"：

1. **事务/撤销**（短板 3）—— 决定 AI 敢不敢做实验
2. **建筑覆盖**（短板 4）—— 决定 AI 能造什么
3. **`place` 精确性**（短板 2）—— 决定 AI 能不能做精细调整
4. **加载可靠性**（短板 1，已修）—— 决定 AI 能不能反复切换存档
5. **事件驱动观测**（短板 5）—— 效率优化，不是能力边界
6. **结构化错误**（短板 6）—— 体验优化

---

## 附：一个被纠正的概念错误（来自独立审查）

我一直以为「切割机切一刀，两个输出槽各出一半」。**这是错的。**

`systems/item_processor.js:367-389`：

```js
process_CUTTER(payload) {
    const inputItem = payload.items.get(0);
    const cutDefinitions = this.root.shapeDefinitionMgr.shapeActionCutHalf(inputDefinition);
    const ejectorComp = payload.entity.components.ItemEjector;
    for (let i = 0; i < cutDefinitions.length; ++i) {
        ...
        payload.outItems.push({ item: ..., requiredSlot: i });   // ← 两半都 push
    }
}
```

**每个输出槽的产出速率 = 输入速率**，不是一半。

实机印证（当前存档）：
```
RuRu---- 0.367/s
----RuRu 0.367/s     ← 两个槽速率相同
```

所以产能估算要改：一台 0.4/s 矿机喂切割机，两个槽各出 0.4/s，
70 个目标约 **175 秒**，不是我之前算的 350 秒。

**这类错误的共同点是**：我用"直觉上的守恒"代替了读源码。
切一刀得到两半，直觉会说"各一半"；但游戏实现是"输入一件，输出两件"。
