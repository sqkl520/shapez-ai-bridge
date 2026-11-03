# P6：找到了绕过游戏自动定向的办法 —— `tx` 漏了 `immutable`

> 2026-11-03。上一轮（`P5-FACING-VS-AUTODIR.md`）的结论是
> 「`opts.facing` 是个正确但无法兑现的能力，因为游戏会按邻居覆盖带子方向，
> 我改不了」。**这一轮推翻了它** —— 出口一直都在，只是 `tx` 没接上。

---

## 一、上一轮的结论错在哪

上一轮我读到过这个事实但没继续查：

> `AI-CONTROL-STATUS.md:36` — 「rv 由游戏按邻居自动算，且只在放置那一刻算一次」
> `CONTRACT-MACROS.md:511` — 「`place{r:90}` 得到 `code=1` 直带」

我据此判断「游戏行为，改不了」。**错在没去读游戏让不让关掉这个重算。**

上游 `systems/belt.js:165-190`：

```js
if (
    !this.root.immutableOperationRunning &&          // ← 就是这里
    (targetStaticComp.rotation !== rotation || newDirection !== targetBeltComp.direction)
) {
    // 重算并覆盖调用方的意图
}
```

而 `logic.js:186-204` 有现成的开关：

```js
performImmutableOperation(operation) {
    this.root.immutableOperationRunning = true;
    const returnValue = operation();
    this.root.immutableOperationRunning = false;
    return returnValue;
}
```

**只要在 `immutableOperationRunning` 期间放置，游戏就不重算。**

---

## 二、mod 里早就有这个能力，只有 `tx` 没用

`shapez-ai-bridge.js:1996` 的 `runGuarded(root, fn)` 同时管 bulk 与 immutable，
而且**刻意不嵌套**（上游 `logic.js:190` 对重入是 assert 失败，不是无害的）：

```js
runGuarded(root, fn) {
    const needBulk = !root.bulkOperationRunning && ...;
    const needImmutable = !root.immutableOperationRunning && ...;
    if (!needBulk && !needImmutable) return fn();
    const wrapped = () => (needImmutable ? logic.performImmutableOperation(fn) : fn());
    return needBulk ? logic.performBulkOperation(wrapped) : wrapped();
}
```

`paste_blueprint` 早就走这条路（`:4266`）。

而 `opTx` 里是：

```js
for (let i = 0; i < ops.length; ++i) {
    const res = await this.performAction(op);   // ← 没有 runGuarded
```

**只有 `tx` 漏了。**

### 为什么之前一直没暴露

绝大多数 tx 是「放带子 / 删带子」，游戏按邻居重算出来的方向**通常**和我们要的
一致（都顺着已有链路）。只有「刻意把某格扭成非自然方向」时才会输 ——
而那正好是修 `BELT_HANDOFF_REJECTED` 这种场景。

---

## 三、真机验证

同一个操作，加 `runGuarded` 前后：

```
改前 (4,-8): r=0 rv=0 entry=bottom
目标 op: {"op":"place","building":"belt","x":4,"y":-8,"r":0,"rotationVariant":0}
真跑 ok=true applied=2
改后 (4,-8): r=180 ...                    ← 被游戏覆盖

── 加了 runGuarded 之后 ──
改后 (4,-8): r=0 rv=0 entry=bottom        ← 保住了
accepts() 判那处 handoff：✅ 通了
```

修复后跑批量实验：

```
[round4] 130 ops, dry_run 130/130 → 可执行
[round4] 真跑 ok=true applied=130

跑前: {"RuRuRuRu":3, "CuCuCuCu":1}
跑后: {"RuRuRuRu":19, "CuCuCuCu":16}
```

铜产量在持续累积（多轮下来 1 → 21 → 32）。

---

## 四、但它收敛不了：世界本身有 2 个结构死锁

修了 4 轮之后，问题数**稳定在 78 处不再减少**。查根因：

```
汇合点 (1,-16) 有 2 个上游: 10692@(2,-16) 11147@(1,-17)
汇合点 (1,-11) 有 2 个上游: 11155@(1,-12) 11167@(0,-11)
总汇合点数: 2
```

**带子只有一个 `entry`，而这两个位置有两个上游在推货。**

给 `(1,-11)` 设 `entry=top`（满足 `(1,-12)`），`(0,-11)` 那条就永远不满足；
反过来也一样。改哪一方都会把另一方弄坏 —— 这是**结构死锁**，
每轮修它都会翻回去，形成无限循环。

这不是工具的问题，也不是模型的问题 —— 是那个世界的布局本身错了
（两个带子流汇到同一格，必须有一个往别处去，或者中间加 balancer）。

---

## 五、这一轮的产出

| 产出 | 状态 |
|---|---|
| `tx` 补上 `runGuarded`（immutable 语义） | ✅ 真机验证通过 |
| `opts.facing` 现在**真的能兑现**了 | ✅ 上一轮做出来、这一轮才生效 |
| 铜产量 | ✅ 从 1 涨到 32（持续累积） |
| 铜送进 hub | ❌ 未达成（被 2 个结构死锁挡住） |

---

## 六、一个值得记的方法论错误

上一轮我在文档里写「这是游戏行为，我改不了」，然后把它推给了「下一轮」。

**但出口一直是有的，就在同一个文件里（`runGuarded` 在 1996 行，`opTx` 在 3386 行）。**

教训：当判断「外部系统不允许我做 X」之前，先 grep 一遍**自己代码里有没有
现成的绕过手段**。这个仓库里已经踩过「`$ore` 让模型猜坐标」、
「`remove_machine` 根本不存在」这两次同类问题 —— 每次都是「以为做不到，
其实只是没接上线」。

---

## 七、下一轮

1. **2 个结构死锁**要先解决。可行方向：
   - 让 `(1,-11)` / `(1,-16) 中的一个上游改道（接到别处）
   - 或者在汇合点插一台 balancer（它有 2 个输入口）
   - 后者更符合 shapez 的玩法，但需要 `insert_machine` 能替换掉那一格带子
2. 修完死锁后，跑完整链路看铜能否进 hub。
3. 这一轮的 `runGuarded` 修复**值得单独回归测试** —— 目前只有真机验证，
   没有单元测试钉住「tx 必须跑在 immutable 语义下」。
