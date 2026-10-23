# rotationVariant 修复 —— **两轮**才真正闭环（诚实记录）

> ⚠️ **本文档 v1（2026-10-23 上午）夸大了验证强度，被对抗审查当场抓住。**
> v2 修正一切结论，并给出真正的反例实验。

## v1 的过失（保留记录）

1. **`placeOne` 的 rv 覆盖只是第一半。** 审查（`review/ADVERSARIAL-REVIEW.md` F1）指出：
   `systems/belt.js:63` 把 `updateSurroundingBeltPlacement` 挂在 `entityAdded` 上 ——
   每放置一格带子，**周围一圈**带子的 rv 会被按邻居**重算并覆写**（belt.js:129-175）。
   唯一豁免 = `immutableOperationRunning`（belt.js:169）。游戏原生粘贴是双层包裹
   （`performBulkOperation` + `performImmutableOperation`，`blueprint.js:159`），我们只有第一层。
   ⇒ **rv 传进去了，也可能在粘贴过程中被邻居改写。** 我漏读了这条钩子。
2. **v1 的"实机验证"其实没验证到点子上。** 原始数据 `facts/live/exp-rv-fix.result.json`
   写的是 `"pass": false`（源 9 条带 vs 粘贴 8 条 —— 锚点归一化差一格），`after_total: 2807`（清理残留 2）。
   真正成立的只有"两次粘贴彼此一致"。我把"彼此一致"写成了"与源逐格一致 + 已验证确定"。
   **一次粘贴一致是收敛情形（邻居重算结果恰好等于存储值），不是确定性证明。**
3. 修复（v2，提交 `a35a481`）：粘贴包进 `performImmutableOperation`。
   **反例实验**（`exp-rv-fix3.mjs`）：同一拐角蓝图贴两处 —— 一处干净、
   一处在拐角落点正上方**预置朝上干扰带**（诱导启发式改写）。
   **两处拐角都保持 code=3 rv=2** ✅ —— 这次是真的反例测试。
4. **边界（T3 已知）**：immutable 只保护**粘贴过程本身**。粘贴完成后在旁边再放一格，
   `entityAdded` 仍会按邻居重算那个拐角（源码如此，实测符合预期）。
   ⇒ 布局编译器**不要事后在拐角旁补格子**；需要改动就整块重贴。
5. SZBP1 stride=4 **没存 `originalRotation`**（游戏存档 schema 有这字段），
   而邻居重算以它为基准（belt.js:160）——增量施工时可能走样。【缺口，见 SYNTHESIS §4.5】
6. **蓝图粘贴会静默替换既有带子**（`getIsReplaceable`）——本次研究期间
   一次未清理的粘贴毁掉了真实工厂 6 条带（快照恢复）。【见 INCIDENT-bulk-delete.md 事故二】

## v2 的反例实验（真正的验证，`exp-rv-fix3.mjs`）

```
源拐角: (-28,-161) r=0 rv=2 code=3（竖直进料 L 形的转角）
小蓝图 82 字符（左邻、拐角、右邻 3 格，含拐角）

[CLEAN]    粘贴 @ (12,-157)   applied=3   区域内存在 code=3: ✅
[DISTURB]  粘贴 @ (52,-157)   applied=3   拐角落点正上方预置了 r=0 朝上的干扰带
                                          区域内存在 code=3: ✅

=== 判定 ===
CLEAN   拐角保留: true
DISTURB 拐角保留: true （邻居有朝上干扰带，若无 immutable 屏蔽会被重算成别的方向）
✅ performImmutableOperation 修复有效
```

**为什么这次算数**：v1 只测了"两处粘贴彼此一致"——那是收敛情形（邻居重算恰好得出存储值）。
v2 主动构造了**与蓝图意图相悖的邻居**（干扰带就在拐角上方），若 `updateSurroundingBeltPlacement`
仍在起作用，拐角会被改写；实测**没有**——`immutableOperationRunning` 的豁免生效了。

## v1 实验（保留，作为反面教材）

`exp-rv-fix.mjs` 的原始结果 `facts/live/exp-rv-fix.result.json`：
- `pass: false` —— 源 9 条带 vs 粘贴 8 条带（我的锚点归一化算差了一格，把源区多出的进料带算了进去）
- 但**拐角本身（`r0v2c3`）在两处粘贴中都存在** —— 方向是对的，只是当时无法区分
  "存储值被采用"与"邻居恰好重算出同值"。v2 才能区分。

## 为什么这是关键的一块（v2 措辞）

"离线布局 → 实机落地"现在**有两个都被验证过的机制**：
1. `placeOne` 尊重显式 rv（v1 修复，回归测试覆盖）
2. 粘贴过程屏蔽邻居重算（v2 修复，**反例实验**覆盖）

配合 `facts/building-code-table.md` 的 code 表，布局编译器的落地链是：
```
离线算布局 → 每格 (building, rotation, rotationVariant) → code → SZBP1
  → paste_blueprint（双层包裹）→ 结果对邻居不敏感
```
**已知边界**：T3 显示粘贴**之后**在拐角旁补放一格仍会触发重算（源码如此）。
所以编译器的纪律是"拐角周围要一次性贴全"。

## 回归测试

`test/mod_selftest.mjs`（现 21 条，含本修复的 3 条）：
- `placeOne honours rotationVariant override` / `falls back to auto-orientation` / `paste passes code rv`
- 全套 **106 条断言全绿**（mod 21 + blueprint 7 + rpc 12 + bridge 19 + mcp 47）

## 世界状态

v2 实验后逐 uid 对拍快照：**2805 / 2805，extra 0，missing 0** ✅
（过程中 3 次残留各 1~2 实体，均靠逐 uid 对拍发现并精确删除；
 另有 §6 记录的"事故二"——研究期间某 agent 未清理的粘贴破坏了 6 条真实带子，已快照恢复。）

## 对路线图的更新

`SYNTHESIS.md` 第一批的 **#0（修 placeOne 的 rv 覆盖）已完成并验证**：
- ✅ 修复（约 10 行）
- ✅ 回归用例（3 条）
- ✅ 实机验证（幂等 + 拐角保真）
- ✅ 已提交（`fix(mod): let callers pin a building's rotationVariant`）

**下一步**：用这个修复重做双分支汇合（M4），此时拐角可控 —— 应当一次通过。
