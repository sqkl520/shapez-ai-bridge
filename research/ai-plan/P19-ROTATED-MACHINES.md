# P19 —— 旋转机器：从"永久禁用"到真机跑通，level 6 打成 73%

日期：2026-11-09
前置：用户贴了一张 `Cu------ 0/270` 的图，说「看的火大」。这一轮把那个 0 变成了完成。

---

## 1. 起点：世界在造别的东西

真机诊断（level 6，`Cu------`，134 实体）：

```
冗余度 0%：161 条带子逐条删除全都会断下游
到 hub 69/118 (59%)，死带子 49
死带子源头: rotater×33  miner×6  cutter×2  balancer×2
```

hub 存储的分布才是关键证据：

```
CuCuCuCu  1680      ← 原料在送
----CuCu  1756      ← 第一刀产物在送
Cu----Cu  27823     ← 第二道工序产物堆着
Cu------     0      ← 目标形状从未产出
```

**四道工序只做了两道。** 配方是：

```
CuCuCuCu ─mine→ ----CuCu ─cut→ Cu----Cu ─rotate→ Cu------ ─cut→
```

缺点是最后那道 `cut`。补一台 cutter 就够 —— 听起来很简单。

---

## 2. 为什么补不上：一个判据写了两遍，我修了一遍

`replace_run` 要往一条**往下流**的线上插 cutter，需要 `rotation=180`。

第一次尝试：

```
out_of_scope: cutter 在流向 "bottom" 下需要 rotation=180，v1 只放 r=0 的机器
```

那个限制的理由是「旋转机器的槽位换算仍是 observed 级假设」。我先去真机验证那个假设：

```
place cutter r=180 rv=0     → 游戏原样保留 r=180
place belt r=180 喂进去      → 游戏没报错、没改方向
与 insert_machine(facing:'bottom') 算出的槽位一致（in=上、out=下方两格）
```

假设成立。于是放开限制。但放开之后仍然放不下，报：

```
precondition_failed: cutter 的输入槽 primary 在计划执行后没有任何供料方
```

**而物理上货正好从那个方向喂进来。** 查下去发现是**同一个判据在三个地方各写了一遍**：

| 位置 | 写的是什么 | 影响 |
|---|---|---|
| `connect.mjs#machinePorts` | `if (rec.r !== 0 && !ROTATION_FREE.has(type)) return {}` | 旋转机器无端口 |
| `remove.mjs#makeContext` | `if (rec.r !== 0) { 空表 + rotatedOutOfScope }` | 推演时旋转机器无端口 |
| `remove.mjs` 合成实体 | `r: 0` 写死 | 推演里造出来的机器永远朝 0 |

三处我只修了第一处就开始测，于是每次都失败、每次都以为是自己参数给错了。

**这是本项目第 N 次因为「同一判据在两处各写一遍」浪费时间。**
真正的修法是让端口只有**一个**来源：`portSlots()` 从 spec 快照按 r 旋转。
另外两处直接删掉判断，走同一条路。

---

## 3. 第四个 bug：footprint 不随旋转展开

修完端口之后 `replace_run` 能选出卖点了，但真机上货还是不动。再查：

```
cutter origin=[-1,-12] rot=180
cells (footprint): [[-1,-12],[0,-12]]     ← 向右展开
```

**2×1 的机器在 r=180 时应该向左展开** `[[-1,-12],[-2,-12]]`。

`footprintAt` 只有 `origin + (dx,dy)`，不处理旋转。后果链条是静默的：

1. footprint 画错 ⇒ 机身占了 `origin` 和 `origin+(1,0)`
2. 输入槽按 `portCellOf`（那个**是**转了的）算出 `origin+(0,-1)`，与机身对不上
3. 游戏里货喷向 `origin`，机器第二格却在另一边 ⇒ 货堵在输入槽
4. 表现：hub 里目标形状 0 个，中间产物暴涨

修法与 `portCellOf` 共用同一份 `rotate90`。

---

## 4. 第五个坑：cutter 的 left/right 与配方里的 half 是**反的**

修完前面四处，货终于流了，但 hub 收到的还是 `----CuCu` 而不是 `Cu------`。

游戏源码 `shape_definition_manager.js#shapeActionCutHalf`：

```js
const rightSide = definition.cloneFilteredByQuadrants([2, 3]);
const leftSide  = definition.cloneFilteredByQuadrants([0, 1]);
return [rightSide, leftSide];       // ← slot 0 是右半
```

`process_CUTTER` 里 `requiredSlot: i`，所以 **slot 0 = 右半、slot 1 = 左半**。

而 `op-templates` 把 slot 0 命名为 `left`、slot 1 命名为 `right`：

```js
eq("cutter 输出 (0,0)top=left / (1,0)top=right", …)
```

**两套命名正好相反。** 配方里写 `cut(right)` 指的是「保留右半」，而项目的 `right` 端口对应 slot 1 = 左半。

所以第一次装 trash 时装在了要保留的那一半上。实测反证：

```
trash 装在 out0 → hub 收到 ----CuCu, Cu------ = 0
trash 装在 out1 → hub 收到 Cu------, delivered 35
```

这个命名冲突还没修（改接口代价大），但已经在两处加了警告注释。
**它是下一个该还的债。**

---

## 5. 结果

```
改前: Cu------ 0/270  (0.0%)
改后: Cu------ 197/270 (73.0%)   ← 跑完剩余的关卡后 hub 升到 level 7
```

真机验证的完整链路：

```
矿机 → cutter(第1刀) → rotater → 右行 → cutter(第2刀) → out0 → hub
```

---

## 6. assess() 在真机上直接崩（顺带修的）

```
TypeError: Cannot read properties of undefined (reading 'belt')
    at upgradeGaps (assess.mjs:95)
```

升级等级在两个位置：真机 obs 是 `goal.upgrade_levels`，归一化后是 `obs.upgrades`。
`assess()` / `capacityOf()` 吃原始 obs 却按归一化形态读。

它没被早发现是因为 `capacityFor()` 先走 `obsForAssess` 归一化了 —— 那条路把 bug 挡住了。

**`assess.mjs` 之前完全没有测试。** 这就是它能崩在真机上而所有测试全绿的原因。补了 10 项。

顺带发现 `headline` 从不说瓶颈是哪个机器（`capacity.bottleneckDetail` 明明算好了）。
现在摘要第一位就是 `瓶颈 cutter，利用率 62%`。

---

## 7. 冗余度那个数字是错的

P18 §3 写的「L11 有 265/2107 可安全单删（12.6%）」是**错的**。
它算的时候 `makeContext` 还有 `if (rec.r !== 0) 空端口表`，
于是 4 台 r=90 rotater 的 `starved-machine` 判不出来，一批本该算出后果的带子被误算成"干净可删"。

修完端口后重算：

```
L4   161 条 → 0
L5   158 条 → 0
L11 2107 条 → 0      ← 从 265 掉到 0
按连通段整段删：0/365
```

抽样核对过，报出来的后果都是真的（「机器 uid=10227 的输入槽 in0#0 只剩 (-7,11) 供料」）。

**所以结论要改口径**：这个度量在所有已知世界里都是 0 —— 不是测不出区别，
而是这些工厂确实没有冗余。成熟工厂的每条带子都在某个环节上，单删必断，这是事实不是缺陷。

它的用途因此变了：回答「**这个场景该不该删**」而不是「**模型删得好不好**」。
恒为 0 恰恰说明 P14 / P17 / P18 三轮「让模型多删」的实验从一开始就没有可测的效应 ——
那三轮的证伪现在有了更硬的解释。

---

## 8. 测试

584 全绿（573 + 新增 11）。

新增：
- `connect.test.mjs` R180-1..6：r=180/90/270 的端口几何，含「上游带子的 exit 必须等于 OPP[输入面]」这条真机断过的判据
- `assess.test.mjs` A1..A10：两种 obs 形态必须给出同一组结论
- `redundancy.test.mjs` R7 改口径 + R7b（保证「报 0」不是瞎报）

---

## 9. 下一个该做什么

1. **cutter 的 left/right 命名债**（§4）。它已经让我装反一次 trash，
   而且模型看到的宏卡片也是这套反的命名 —— 迟早会误导它。
2. **level 7 是 `CrCrCrCr`，需要 painter，而世界里一台都没有。**
   69 格红矿在等着。
3. 产能仍是瓶颈：`瓶颈 cutter，利用率 62%`，铜矿 108 格只用了 1 格。
