# 实验 H7：蓝图完整性（**结论已修正 —— 见文末**）

> ⚠️ **本文档的原始结论是错的。** 保留原文以记录研究过程；**正确的结论见文末"修正"节**。
> 修正依据：`facts/ROOT-CAUSE-rotationVariant-override.md`

**问题**（对抗审查提出的最关键质疑）：
`belt.js:161` 的自动定向只看邻居，那"用蓝图一次性粘贴"会不会因为粘贴顺序而算错拐角？

**原始答案（错误）**：不会。蓝图不依赖自动定向——它显式携带 `rot` 与 `rotationVariant`。

## 实测（`research/ai-player/exp-belt-order.mjs`）

造一条 L 形产线（矿机朝右 → 3 格水平带 → 拐角 → 3 格垂直带），导出蓝图，在 160+ 格外粘贴：

```
★ 原地产线：                      ★ 粘贴产物：
  (-23,-183) r=90 rv=0             (57,-100) r=90 rv=0
  (-24,-183) r=90 rv=0             (56,-100) r=90 rv=0
  (-23,-183) r=90 rv=1  ←拐角      (57,-101) r=90 rv=1  ←拐角（保留了！）
  (-23,-184) r=0  rv=0             (57,-102) r=0  rv=0
  ...                              ...

归一化对比：完全一致（逐格 r 与 rotationVariant 都相同）
粘贴 applied=7 failed=0
```

## 为什么（源码机制）

- **`belt.js:161 computeOptimalDirectionAndRotationVariantAtTile`** 是**玩家手放带子时**的辅助
  （决定鼠标放置那一下取什么形状）。
- **蓝图粘贴走的是另一条路**：`blueprint` 记录的是每格的 **`code`（含 variant/rotationVariant）+ `rotation`**，
  粘贴时**直接指定**（我们的 `opPasteBlueprint` 就是 `placeOne(root, meta, x, y, rot, variant)`）——
  完全不调用自动定向。

**这解释了一件事**：开发期"拐角铺错"的坑只发生在 `place_path`（逐格放、走自动定向），
**不影响蓝图路径**。

## 对布局编译器的意义（**原文观点，已被修正**）

| 路线 | 拐角可靠性 | 适用 |
|---|---|---|
| 蓝图（`paste_blueprint`） | ⚠️ **原始结论说"完全确定"——已修正为"取决于邻居/顺序"** | 需先修 `placeOne`（见修正节） |
| `place_path` + 自动定向 | ⚠️ 依赖邻居存在与顺序 | 只用于简单直线或微调 |

**修正后的建议**：布局编译器仍应生成蓝图（**一次调用**、**可在任意位置落地**这两个好处是真的），
但**必须配合 `placeOne` 的 rv 覆盖修复**，否则拐角不可控。

## 顺带确认的事实（这部分仍然成立）

- 拐角格的实际取值示例：`r=90, rotationVariant=1`（左转）—— 与 `belt.js` 的 `variant:1 = 左转` 一致。
- 导出的蓝图长度：一条 7 实体的小产线 = **102 字符**（SZBP1）。
- 粘贴坐标锚点 = 导出区域的**最小角**（`blueprint.mjs` 的 `w:[minx,miny]`）。

---

## ⚠️ 修正（研究后期发现，本文的原始结论不成立）

**原始结论**："蓝图完整保留了 r/rotationVariant，所以粘贴是确定的。"

**为什么它是错的**：我当时的实验**只观测了结果**，没有检验机制。
后来在做双分支汇合（M4）时连续 5 次失败，才回去读 `src/mod/shapez-ai-bridge.js` 的 `placeOne`：

```js
placeOne(root, meta, x, y, rotation, variant) {       // ← 没有 rotationVariant 参数！
    let optimal = { rotation: rot, rotationVariant: 0 };
    if (meta.computeOptimalDirectionAndRotationVariantAtTile) {
        optimal = meta.computeOptimalDirectionAndRotationVariantAtTile({...});  // ← 总是重算
    }
    root.logic.tryPlaceBuilding({
        rotation: optimal.rotation,
        rotationVariant: optimal.rotationVariant,      // ← 用的是重算结果
        ...
    });
}
```

**真相**：
- 蓝图**确实保存了** code（含 rv）——这一点原实验没错。
- 但**粘贴时并不使用**它：`placeOne` 把 rv 交给游戏的自动定向算法重算。
- 原实验"通过"是因为**粘贴顺序恰好让邻居先就位**（`paste_blueprint` 按蓝图数组顺序循环，
  而导出时也是同一遍历顺序）——**是运气，不是保证**。

**正确的结论**：
| 断言 | 状态 |
|---|---|
| 蓝图保存 r/rotationVariant | ✅ 成立（原实验证明） |
| 粘贴时使用蓝图的 rotationVariant | ❌ **不成立**（`placeOne` 无此参数，总是重算） |
| 粘贴结果确定 | ❌ **不成立**（取决于粘贴顺序与邻居状态） |

**修法**（见 `facts/ROOT-CAUSE-rotationVariant-override.md`）：
给 `placeOne` 加可选的 `rotationVariant` 参数，粘贴蓝图时传入 —— 约 10 行改动。

**这条自我纠错本身是方法的胜利**：一个"通过"的实验，如果它通过的原因不是它声称的原因，
那它其实没通过。**只有解释清了"为什么能行"，结论才可信。**
