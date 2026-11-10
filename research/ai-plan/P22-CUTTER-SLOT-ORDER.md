# P22 —— cutter 的 slot 0/1：源码推理输给真机两次

日期：2026-11-10
前置：P21 把 painter 跑通了（level 7 完成，hub 升到 level 8 `RbRb----` ×480）。
这一轮搭蓝钌线，被 `slot 0/1` 的映射坑了两轮。

---

## 1. 决定性证据

`debug_items` 的 `ejectors` 在**同一个 cutter 上同时列出两个槽**：

```json
[
  { "cell": [24,-41], "slot": 0, "item": "----RuRu" },   ← slot 0 = 后半
  { "cell": [24,-41], "slot": 1, "item": "RuRu----" }    ← slot 1 = 前半
]
```

行为验证（两次独立）：

| 把哪个槽接进 painter | hub 里出现什么 |
|---|---|
| `slot 1`（项目叫 `right`） | **`RbRb----`** ← 目标形状 |
| `slot 0`（项目叫 `left`）  | `----RbRb` ← 后半上色，错的 |

接上 `slot 1` 之后：`RbRb---- 2/480 → 14 → 64 → 209`（稳定产出）。

---

## 2. 上一轮的结论是怎么错的

P19 我写的是「slot 0 = 右半、slot 1 = 左半」，并把它写进了
`op-templates.mjs` 的长注释、`trash_unused` 的参数描述、和一条测试。

依据是源码推理：

```
shape_definition_manager.js#shapeActionCutHalf:
    const rightSide = definition.cloneFilteredByQuadrants([2, 3]);
    const leftSide  = definition.cloneFilteredByQuadrants([0, 1]);
    return [rightSide, leftSide];        // 先右后半

item_processor.js#process_CUTTER:
    const cutDefinitions = ...shapeActionCutHalf(inputDefinition);
    for (let i = 0; i < cutDefinitions.length; ++i)
        payload.outItems.push({ item: ..., requiredSlot: i });
```

⇒ 「slot 0 拿的是 `rightSide`」⇒「slot 0 = 右半」。

**读起来无懈可击，但实际行为相反。**

可能的解释：`ItemEjectorComponent.setSlots` 的槽位顺序与 `cutDefinitions`
的下标**不是同一个编号空间**（游戏里 ejector 的 slot 索引可能按世界方位排序，
而不是按 `requiredSlot` 的数值）。我没有继续挖到那一步就停了 —— 挖源码的成本
已经远高于"两台 cutter 各接一个槽试一次"。

---

## 3. 这一轮因此浪费了什么

- 第一次接线：`out0` → painter，产 `----RbRb`，误以为是路径没通
- 第二次：交换成 `out1` → painter，但当时 `25,-41` 是死胡同（自己刚铺的一格带子挡住了），
  所以还是没产出，又误判了一次
- 第三次：修好路径以后才看到 `RbRb----` 出现

**如果第一次就直接看 `ejectors` 里两个槽的 item，一次就能定案。**
这和 P21 的教训是同一个：`debug_items` 的三个数组里，`ejectors` 是
「机器当前拿着什么」的唯一来源，`paths` 只讲带子。

---

## 4. 顺带修的两个 connect bug

### 4.1 第五份 r≠0 判断

```js
if (rec.r !== 0 && !ROTATABLE_ONLY_IF_MACHINE.has(rec.type)) return out_of_scope
```

理由是「旋转机器的槽位偏移需 P2 的 origin 位移表，v1 没有」。
**P19 已经实现了那张表**（`portSlots` 按 `rotate90` 转 tile），真机验证过
cutter r=180 能产货。这道闸是同一件事的**第五份**判断。

真机现场：红矿机 r=180 要接 painter 的 color 口，被拒成 `out_of_scope`。

### 4.2 `verifyChain([])` 判成错误

红矿机 `54,21` 往下喷，painter 的 color cell 正是 `54,22` —— **零距离**，
正确路径就是 0 格带子。但 `verifyChain` 判 `!cells.length → ok:false`，
报 `internal: 生成的路径几何不自洽（第 chain 处）：空链`。

改成：非数组仍是错（调用方传错），空数组是对的。

---

## 5. 这一轮的完整产线（level 8）

```
钌矿机 4,-41 (r=90 右喷)
  → 19 格直线 →
cutter 24,-41 (r=90)
  ├─ slot 1 (25,-40) → 41 格 → painter 37,-10 的 shape 口
  └─ slot 0 (25,-41) → trash（丢掉后半）
蓝矿机 38,-12 (r=0 上喷) → 5 格 → painter 的 color 口 (38,-11)
painter 37,-10 → out (39,-10) → 50 格 → hub
```

painter 的 color 口在**上方**（`default` variant）；`mirrored` 会改成下方。

---

## 6. 三次踩坑的共同模式

| 轮次 | 症状 | 真因 |
|---|---|---|
| P20 | painter 不消费 | **输出没接带子**（产物堵在出口） |
| P21 | 新 painter 不消费 | 同上（输出接了才通） |
| P22 | 产 `----RbRb` 不是 `RbRb----` | **slot 0/1 接反** |

三个都不是"哪里算错了"，而是**没有观测到该观测的地方**：
前两个该看 `ejectors`，第三个该看 `ejectors` 里的 `slot` 字段。

---

## 7. 测试

624 全绿。

改的三处（都是把错的结论翻案 + 写清为什么）：
1. `op-templates.mjs` cut 模板的长注释
2. `trash_unused` 的 `outlet` 参数描述
3. 钉住槽位顺序的那条测试的注释

---

## 8. 下一步

`RbRb----` 需要 480，当前 209。产能可能不够 —— 一台 painter 的速率是 0.33/s，
480 个要 24 分钟游戏时间。可能要加第二台 painter 或者提升上游供给。
