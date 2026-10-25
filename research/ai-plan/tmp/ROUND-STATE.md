# 2026-10-26 · 一轮自我纠错：我的读数全是假的

## 一句话

这一轮最重要的产出不是新功能，是**发现我过去几小时的所有测量都建立在一个冻结的时钟上**。
而冻结是我自己造成的。

---

## 1. 事故链

我在测「L3 产线真实吞吐」时调了 `set_speed fast_forward` 想让测试快一点。
之后 `obs.tick` 永远停在 `10190.8`，`act.step` 返回 `ticks_run: 0`，
但 `place` / `delete` 都返回 ok。

三种现象组合起来无法从外部区分，我先后猜错四个方向：
- 窗口最小化 → 恢复窗口，无效
- 页面不可见 → `pageVisible: true`，无效
- 有对话框打开 → ESC 关掉一个对话框，仍无效
- root 已销毁 → 依然能放置实体，不成立

加诊断 RPC 之后一次定位。

## 2. 根因（两层，都在游戏侧）

### 2.1 `globalConfig.fastForwardSpeed` 从未定义

```js
// recon/upstream-full/src/js/game/time/fast_forward_game_speed.js:10
getTimeMultiplier() { return globalConfig.fastForwardSpeed; }   // undefined
```

```js
// recon/upstream-full/src/js/game/time/game_time.js:94
this.logicTimeBudget += deltaMs * multiplier;   // NaN
while (this.logicTimeBudget >= effectiveDelta)  // NaN >= x 恒假
```

预算变 `NaN` → 逻辑 tick 永远不跑 → `timeSeconds` 冻结。
切回 `regular` 也救不回来（`NaN + 任何数 = NaN`）。

### 2.2 只有 `regular` 注册进了序列化工厂

```js
// recon/upstream-full/src/js/game/game_speed_registry.js:4-8
export function initGameSpeedRegistry() {
    gGameSpeedRegistry.register(RegularGameSpeed);
    // Others are disabled for now
}
```

`paused` 和 `fast-forward` **不可序列化**。一旦它成为当前速度又被存档，
读档时报：

```
serialization verify failed: Invalid class id: fast-forward (factory is gamespeed)
```

游戏随后判定 `Savegame is corrupt and can not be restored.`
—— 界面上只说「存档损坏」，数据其实完好。

## 3. 教训：诊断工具撒谎比没有工具更糟

`debug_items` 读带子物品，连续错了两次：

1. `BeltPath.items` 的元素是 `[距离, 物品]` 的 **pair**，不是物品。
   我把 `items[i]` 直接交给 `getAsCopyableKey()`，返回 null →
   永远报告「带上一个物品都没有」。
2. 就算取到 `pair[1]`，也不能按 `items[i] ↔ entityPath[i]` 对应。
   **物品不是一格一个**：按距接受端的累计距离排布，间距 `itemSpacingOnBelt = 0.63`。
   7 格直带装 12 个物品是正常状态（=堵死），硬对格子会让超出格数的物品全变 null。
3. 直带每格有效长度 1.0，转弯 0.78（`components/belt.js:6,70-72`）。

我据「带子是空的」这个假读数，判断过产线正常。

## 4. 修了什么

| 改动 | 作用 |
|---|---|
| `set_speed` 查 `gGameSpeedRegistry.hasId` | 未注册的速度直接 2002 拒绝，世界进不了坏状态 |
| `set_speed` 校验 `getTimeMultiplier()` 是有限正数 | `NaN` / `0` 也拒绝 |
| 预算被污染时归零 | 已坏的世界能救回来 |
| `step` 推进 0 tick 时抛 2002 | 「世界死了」不能再伪装成「命令成功」 |
| `debug_loop` | 一次读出所有门控条件 |
| `debug_log` | 截获游戏 console（环形 300 条），反序列化失败的原文在此 |
| `debug_speed_registry` | 看哪些速度真的注册了 |
| `repair_save` | 把存档里未注册的速度 id 改回 regular，先备份，走游戏自己的序列化 |
| `resources` | 读地下矿点分布（格数 / bbox / 每行连续段） |
| `debug_items` 修正 | pair 解析 + 累计距离反算格子 |

`repair_save` 还踩了一个：salt 是 `globalConfig.info.file`，
不是 `globalConfig.file.info.file` —— `read_write_proxy` 用的是
`accessNestedPropertyReverse(globalConfig, ["file","info"])`，
从数组尾部往回走。写错一个层级得到的校验和永远对不上。

## 5. 修好之后的真实读数（这才是第一次实测）

L4 存档 `cf469f75`，8 台矿机：

| 形状 | 实测 | 理论 | 达成率 |
|---|---|---|---|
| `RuRuRuRu`（4 矿机） | 1.20 /s | 1.6 /s | 75% |
| `----CuCu`（4 矿机经切割） | 0.50 /s | 0.8 /s | 62% |

**地图上有多少矿？**

```
CuCuCuCu   54 格
red        48 格
RuRuRuRu   44 格
green      39 格
总计      185 格
```

用了 8 台矿机，且全部挤在两小片：
- 铜 `(-10..-7, 4..5)`
- 钌 `(2..5, -8)`

**这就是用户说的「看起来在玩，其实什么都没建」的量化版本。**

## 6. 铜线的结构性缺陷

`boundAcceptor === null` = 这条带子的末端没有出口。实测：

```
path 0: len=7 items=6  [-10,3]..[-10,-3]  ← 死路
path 1: len=7 items=5  [-9,3]..[-9,-3]   ← 死路
```

`(-10,4)` 和 `(-9,4)` 两台矿机产出的铜永远堆在带子上，进不了 balancer。
4 台矿机里只有 2 台的产量真正汇流。

对照：
```
y= 5   (-8)M (-7)M
y= 4   (-10)M (-9)M (-8)belt (-7)belt
y=-3   (-10)belt (-9)belt/3 (-8)BALANCER (-6..-3)belt →
```

`(-9,-3)` 是 `code=3`（直线），没有转向 → 它继续往上？不，它往上走完了。
带子是向上的（`r=0`），所以 `(-10,-3)` 和 `(-9,-3)` 的下一格是 `(-10,-4)` / `(-9,-4)`，
那里什么都没有 → 断头。

而 `(-8,*)` 和 `(-7,*)` 两列正常汇入 balancer `(-8,-3)`。

**所以这 4 台矿机实际上是 2+2 并联，只有 `(-8)` 那一列在给 hub 供货。**
左边两台是纯粹的浪费。

## 7. 下一步（按重要性）

1. **先别加新东西，先让 L4 这一关真的过。**
   `RuRu----` 需要把 4 台钌矿机 → 切割机 → hub，现在缺切割机。
   而现有钌线占了那 4 格矿。做法不是推倒，是**在线上插一个 cutter**。
2. **增量改造能力**（一直缺的那个）：读出已有拓扑，在第 N 格断开，
   插入一个工序，再接回去。这是「旧厂永不拆，它是升级供应链」的最低要求。
3. **让每台矿机都接到主线**：现在编译器会产出死路，说明 `place.mjs`
   的布线校验没有覆盖「每条带子必须有 acceptor」。
   这是一个应该能在离线阶段就报错的硬约束，不该等到实机才看出来。
