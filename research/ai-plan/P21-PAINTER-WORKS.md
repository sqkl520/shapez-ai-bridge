# P21 —— painter 通了的真正原因：输出没接带子

日期：2026-11-10
前置：P20 记录 level 7 卡在 `CrCrCrCr 0/300`，painter「能放下但不消费」，并怀疑是解锁问题。

**结论先说：painter 一直是对的。它不消费是因为输出端没有带子，产物堵在出口。**
P20 里我排查的三个方向（解锁、槽位几何、颜料类型）**全部正常**。

---

## 1. 真机证据

```
debug_items 的 ejectors：
  [53,23] CrCrCrCr progress 1     ← painter 早就在产出！
  [52,25] CuCuCuCu progress 1
  [54,21] red      progress 1
```

`CrCrCrCr` 就挂在 painter 的出口上等着，而 `55,23`（它的 out cell）是空的。

接上 76 格带子到 hub 之后：

```
CrCrCrCr 26/300  →  89/300  →  level 7 完成，hub 升到 level 8 (RbRb---- 0/480)
```

---

## 2. 为什么两轮都没看出来

`debug_items` 的输出我一直在看 `paths`（带子上的货），**没看 `ejectors`**。

而 `paths` 只列**有带子的路径**。painter 的输出格空着 → 不进 `paths` →
在那一屏里painter 就像"什么都没做"。

真正该看的是 `ejectors[]`：它列**每台机器的每个输出槽当前拿着什么**。
`[53,23] CrCrCrCr` 这一行从第一次测试就该出现，我看了几十次 `paths` 都没翻到它。

**教训**：`debug_items` 有三个数组（`belts` / `ejectors` / `underground`），
判断"某台机器在不在工作"必须看 `ejectors`，只看 `paths` 会漏掉所有
"产出了但堵在出口"的情况 —— 而那正是最常见的失败形态。

---

## 3. 真正的 blocker 其实是两个 connect bug

排查过程中撞到两个真 bug，都不是 painter 的问题：

### 3.1 `connect` 的 r≠0 端点闸（第五份重复判据）

```js
if (rec.r !== 0 && !ROTATABLE_ONLY_IF_MACHINE.has(rec.type)) return out_of_scope
```

理由是「旋转机器的槽位偏移需 P2 的 origin 位移表，v1 没有」。
**P19 已经实现了那个表**（`portSlots` 按 `rotate90` 转 tile、`rotateLocal` 转 dir），
真机验证过 cutter r=180 能产货。这道闸是同一件事的**第五份**判断，
修完前四份才轮到它。

真机现场：红矿机 r=180 在 `54,21` 要接 painter 的 color 口，被它拒成 `out_of_scope`。

### 3.2 `verifyChain([])` 把空链判成错误

红矿机 `54,21` 往下喷，painter 的 color cell 正是 `54,22` —— **零距离**，
正确的路径就是 0 格带子。但 `verifyChain` 判 `!cells.length → ok:false`，
于是 `connect` 报 `internal: 生成的路径几何不自洽（第 chain 处）：空链`。

**一个正确且最短的连接被自己的自证层拒掉。**

修法：非数组仍是错（调用方传错），空数组是对的（不需要铺）。

---

## 4. 两条旧测试的前提过期了

`connect.test.mjs` 和 `connect_rotated_belt.test.mjs` 里有三条测试主张：

```
"verifyChain 负例⑥：空链必须红（不许把什么都没生成当成功）"
"护栏：机器 r≠0 仍然必须被拒（不能顺手把机器也放开）"
"护栏：to 是旋转机器也仍须被拒"
```

它们都是**基于"v1 没有旋转机器槽位表"这个已修的前提**写的。
现在改成断言新行为（空链 ok / r≠0 能连），并在注释里写清为什么翻案 ——
否则下一个人会以为是有人顺手放宽了限制。

---

## 5. painter 的权威几何（实测，与游戏源码一致）

`default` variant：

| 端口 | 位置（相对 origin） | 货流方向 |
|---|---|---|
| shape 进 | `(0,0)` 的左邻格 | 从左 |
| color 进 | `(1,0)` 的上邻格 | 从上 |
| out | `(1,0)` 的右邻格 | 往右 |

`mirrored` variant 只改 color：**从下**。

配套约束（游戏源码 `painter.js` + `item_processor.js`）：
- `inputsPerCharge = 2`，在 `updateVariants` 里设（不是构造参数）
- `tryTakeItem` 保证每个 acceptor slot 只收一个
- acceptor 的 `filter`：shape 口只收 `ShapeItem`（`_type="shape"`），
  color 口只收 `ColorItem`（`_type="color"`）
- 红矿矿脉由 `map_chunk.internalGenerateColorPatch` 生成 `COLOR_ITEM_SINGLETONS[color]`
  = **ColorItem**，所以矿机压在红矿上产的确实是 pigment 不是 shape

---

## 6. 这一轮加的诊断

- `debug_rewards` —— 读运行时 `gainedRewards`（**结论：`reward_painter: true`**）
- `debug_building_unlocked` —— 直接调 `meta.getIsUnlocked(root)`
  （**结论：painter/belt/miner/cutter/rotater/balancer/trash 全 true，
  mixer/stacker 为 false，tunnel 为 null**）
- `decodeSaveFile().rewarded` —— 从存档读推导结果，不必重载

三个都证明解锁没问题。**它们是必要的排除**，但真正的原因是 §1 那一行 ejector。

---

## 7. 下一步

level 8 是 `RbRb----`（钌 + 蓝色颜料）×480。配方：

```
RuRuRuRu ─mine→ RuRu---- ─cut→ color:blue ─mineColor→ RbRb---- ─paint/blue→
```

blue 矿只有 19 格（`obs.resources` 里 `blue:19`），要确认矿脉位置和可接性。

现在 painter 的路子完全通了，这一关应该是搭第二条 painter 线的事，
而不是再排查一轮。

---

## 8. 测试

624 全绿（618 + 新增 6）。
