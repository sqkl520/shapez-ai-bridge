# 带子拓扑的三条实机规则（源码 + 实测双向确认）

日期：2026-10-27
来源：`recon/upstream-full/src/js/game/` 源码 + 本机实机探测

这三条解释了为什么"看起来该通的线不通"，也是 `gates.mjs` 的 G7/G8 能成立的前提。

---

## 规则 1：带子只接收与它行进方向相同的货，**没有侧向输入**

`recon/upstream-full/src/js/game/belt_path.js:246`：

```js
const beltAcceptingDirection = targetStaticComp.localDirectionToWorld(enumDirection.top);
if (ejectSlotWsDirection === beltAcceptingDirection) {
    return { entity: targetEntity, acceptor: ... };
}
```

能接货的唯一条件是：**上游喷射方向 == 下游带子的行进方向**。

推论（很多人会踩）：

- 一条向右走的带子**不会**接收从上方竖直落下来的货
- 想让货从侧方汇入，必须让侧方那条带子**转成同一行进方向**，而不是"接上"
- 我在试验存档里放过 `(9,-11) r=90`（向右）指向 `(10,-11) r=0`（向上），
  实测 `boundAcceptor = null` —— 就是因为方向不同，不是位置不对

## 规则 2：拐角的形状由**邻居当时是否在场**决定，放置后不会自动重算

`recon/upstream-full/src/js/game/buildings/belt.js:160-250`
`computeOptimalDirectionAndRotationVariantAtTile`：

- 它调 `root.logic.getEjectorsAndAcceptorsAtTile(tile)` 查邻居
- 看到下方有 ejector → 走直线
- 看到左/右有 ejector 且另一侧没有、且下方没有 → 转弯
- 看到左/右有 acceptor → 转向那一侧（源码注释自己都写着
  `NOTICE: This makes the belt prefer side turns *way* too much!`）

**关键：这个函数只在放置那一刻运行一次。** 之后邻居再变，它不会回头重算。

（`_updateSurroundingBelt` 会在邻格变动时重算**周围**的带子，但实测不可靠 ——
L4 那次事故正是"贴完之后又被翻成直带"。）

### 执行顺序

所以铺一条带拐角的线，**必须从下游往上游放**：

```
正确：先放终点的直带 / hub 入口 → 再放拐角 → 最后放源头
错误：先放源头 → 再放拐角（拐角看不到下游 acceptor，退化成直带）
```

实测对照：

| 顺序 | 结果 |
|---|---|
| 先 `(10,-11)` 后 `(9,-11)` | `(10,-11)` 保持 code=1 直线，`(9,-11)` 的货进不去，堵 |
| 先 `(10,-10)`、`(9,-11)` 都就位，再放 `(10,-11)` | 仍是 code=1 —— **这条也不可靠** |

结论：**`place` 不能可靠地产生指定 rv 的转角。要精确的转角，用蓝图粘贴**
（蓝图携带 `code = 1 + rv`，`paste_blueprint` 直接采用）。

## 规则 3：`code = 1 + rotationVariant`，入口恒为局部 bottom

`src/ai/belt-rules.mjs`（1906 条实机带子验证过）：

```js
beltEntry(rv, rotation) = rotateLocal("bottom", rotation)
beltExit(rv, rotation)  = rotateLocal(EXIT_LOCAL[rv], rotation)
EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" }
code = 1 + rv
```

三条实机校准（铜线）：

| 格子 | r | code | 实测连接 | 规则判定 |
|---|---|---|---|---|
| `(-8,-13)` | 0 | 3 (rv=2) | 下方来 → 向右去 | entry=bottom, exit=right ✓ |
| `(-1,-13)` | 90 | 3 (rv=2) | 左方来 → 向下去 | entry=left, exit=bottom ✓ |
| `(-1,-3)` | 180 | 1 (rv=0) | 上方来 → 向下去 | entry=top, exit=bottom ✓ |

**这三条规则与 `belt-rules.mjs` 100% 吻合，不存在"理论对、实机不对"的情况。**
之前的困惑全部来自规则 1 和规则 2（方向必须同向、拐角必须贴对）。

---

## 对工具的直接影响

1. **`place` 的 `r` 参数不足以表达转角。** 它只设 rotation，rv 由邻居猜。
   需要精确拓扑时用 `paste_blueprint`。
2. **G7/G8 的判据建立在规则 1 之上** —— "每格的实际前驱方位必须等于声明的 inDir"，
   正是 `belt_path.js:246` 那条等式的反向陈述。
3. **编译器生产的蓝图天然满足这些规则**（它显式携带 rv，见 `emit.mjs`），
   所以问题只出在"人手拼 layout"或"用 `place` 逐格搭"的场景。
