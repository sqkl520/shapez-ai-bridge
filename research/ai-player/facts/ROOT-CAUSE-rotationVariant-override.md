# 🎯 根因定位：`placeOne` 覆盖 rotationVariant（可修，且是 MergE 失败的真正原因）

## 发现

`src/mod/shapez-ai-bridge.js:782-807` 的 `placeOne()`：

```js
placeOne(root, meta, x, y, rotation, variant) {
    const rot = this.normalizeRotation(rotation);
    let optimal = { rotation: rot, rotationVariant: 0 };
    try {
        if (meta.computeOptimalDirectionAndRotationVariantAtTile) {
            optimal = meta.computeOptimalDirectionAndRotationVariantAtTile({   // ← 总是调用
                root, tile: origin, rotation: rot, variant, layer: meta.getLayer(),
            });
        }
    } catch (e) { /* 保住默认值 */ }
    const entity = root.logic.tryPlaceBuilding({
        origin,
        rotation: optimal.rotation,             // ← 用游戏算的，不是调用方给的
        rotationVariant: optimal.rotationVariant, // ← 同上
        originalRotation: rot,
        building: meta, variant,
    });
    ...
}
```

**函数签名里根本没有 `rotationVariant` 参数** —— 它**永远**由 `computeOptimalDirectionAndRotationVariantAtTile`
（即 `belt.js:161` 的邻居派生算法）决定。

## 这解释了所有现象

### 1. 为什么 M4/汇合实验的拐角总是不对
`paste_blueprint` 从蓝图里读出 `rot` 传给 `placeOne`，但 **`rotationVariant` 被丢弃**，
改由"当前邻居"重算。当粘贴顺序不确定（或邻居尚未就位）时，
**拐角会算成直带或反向弯** —— 与本研究的观察完全一致。

### 2. 为什么 H7（蓝图保真实验）却"通过"了
H7 里我粘贴的是一条 L 形产线，**粘贴时邻居是逐格出现的**，
而 `paste_blueprint` 的循环顺序恰好是蓝图数组顺序（= 导出的遍历顺序），
所以最后一次放置时邻居已就位 —— **碰巧算对了**。
**但这是运气，不是保证**（H7 的结论需要修正为"在特定顺序下保真"）。

⚠️ **因此 `facts/blueprint-integrity-EXPERIMENT.md` 的结论要降级**：
它证明了"蓝图里保存了 rv"，但**没有**证明"粘贴时会用蓝图的 rv"。
**真相是：rv 每次都被重算。** 这是本次研究的一个**自我纠错**。

### 3. 与 code 表的关系
蓝图存的是 `code`（含 rv），但我们粘贴时**只用了 `code` 查 (building, variant)**，
**没用 code 里的 rv** —— 而是重新算。这就是断链点。

## 修法（明确、小改动）

**给 `placeOne` 加可选的 `rotationVariant` 参数；粘贴蓝图时传入蓝图里的值。**

```js
// 修改后
placeOne(root, meta, x, y, rotation, variant, rotationVariantOverride = null) {
    const rot = this.normalizeRotation(rotation);
    let optimal = { rotation: rot, rotationVariant: 0 };
    if (rotationVariantOverride !== null) {
        optimal = { rotation: rot, rotationVariant: rotationVariantOverride };   // ← 尊重调用方
    } else {
        try { if (meta.computeOptimalDirectionAndRotationVariantAtTile) optimal = ...; } catch {}
    }
    ...
}

// opPasteBlueprint 里：从 code 反推 rv 并传入
const info = table.byCode[code];
const rvFromCode = code - info.baseCode;      // belt: code - 1，或直接从表里查
const entity = this.placeOne(root, info.metaInstance, a.x + dx, a.y + dy, rot, info.variant, rvFromCode);
```

**兼容性**：`place`/`place_path` 不传第 7 参 → 行为完全不变（自动定向）。
只有 `paste_blueprint` 用新参数 → 蓝图变成"完全确定"的落地方式。

## 对路线图的影响

**这是一条高价值的、很小的修改**（约 10 行），但它：
1. **把蓝图从"大概能行"变成"完全可控"** —— 布局编译器的输出终于可靠。
2. **解决了 M4 的汇合障碍**（不需要隧道、不需要重放拐角）。
3. **让"离线生成蓝图"真正闭环**（配合 `facts/building-code-table.md` 的 code 表）。

**建议**：这应该是**第一批**要做的改动（比求解器更小、更关键）。
一旦完成，布局编译器的"落地"环节就通了。

## 待办（按顺序）

1. ✅ code 表（已提取，`facts/building-code-table.md`）
2. ⬜ **改 `placeOne` 支持 rv 覆盖**（本节，约 10 行）
3. ⬜ 加 `test/mod_selftest.mjs` 的回归用例（验证 rv 被尊重）
4. ⬜ 重新验证 H7（这次是真的）
5. ⬜ 用蓝图重做 M4 汇合 → 应当**一次通过**

## 诚实说明

这条根因是**在 M4 连续失败 5 次之后**才找到的，而且**推翻了此前 H7 的结论**。
这正是对抗性验证的价值：**如果一个结论没有解释"为什么能行"，它可能就是运气。**
H7 当时"通过"了，但它通过的原因（粘贴顺序碰巧对）**不是**它声称的原因（蓝图携带 rv）。
