# 半成品世界自修实验 —— 报告

> 2026-10-31。目标：造一个「差最后 3 格带子」的世界，让 loop 自己发现并修好。
> 这是阶段 2 的正面验证：不是「模型能不能规划」，而是「闭环能不能发现缺口、选中动作、修好」。

---

## 一句话结论

**loop 的诊断、意图、动作选择全部正确，但到目前为止一次都没修成。**
挡路的东西从「三个结构性堵点」降到「一个布线算法的能力边界」。

这条路走通了两件事（都是真 bug，已修），也把最后那道墙精确地量出来了。

---

## 实验设计

拿那份**真出货过**的 44 实体方案（`--miners 3`，无隧道，极性 right→hub），
砍掉 cutter 的 **right 槽（产品 `RuRu----`）** 到 hub 那条链的**最后 3 格**
（`(1,-5)` `(1,-4)` `(1,-3)`，全是 r=180 的带子）。

于是世界处于这个状态：

| 部件 | 状态 |
|---|---|
| 3 台矿机 | 正常在产 `RuRuRuRu` |
| balancer | 正常汇流 |
| cutter | 正常在切 |
| **产品侧链** | **断在 `(1,-6)`**，货堆在那里，到不了 hub |
| 废料侧 | cutter left → trash 正常 |
| hub | `stored_shapes["RuRu----"]` 不涨 |

实测确认：跑 600 tick 后 `stored_shapes` 里**所有形状的增量都是 0**。货确实堵住了。

---

## loop 每次的表现（这是最有价值的部分）

### 诊断：每次都完全正确

```
[PROCESSOR_REQUIRED] this stream carries RuRuRuRu, which the recipe turns into the
                     next shape with cut; the factory has 1 cutter(s) but none of them
                     is on this stream
[NO_PRODUCTION]      窗口内 RuRu---- 产出 0（delivered 0/70）
[DEAD_END]           出口方向 bottom 的那一格上没有实体（货会堆在这里）
```

`DEAD_END` 那条**精确命中断点**：`(1,-6)` 朝 bottom 喷到 `(1,-5)` 空地。

### 意图：每次都说对了

第 2 轮模型的 `say` 原文：

> The only belt run that ends in mid-air is the exit of the existing cut line;
> **route it into the hub so the cut product finally gets delivered.**

### 动作：也确实选对了

```json
{"macro":"connect","args":{"from":{"$ref":"B34"},"to":{"$ref":"H1"}}}
```

`B34` = 断点那条带子，`H1` = hub。**端点、方向、宏，全对。**

---

## 挡路的三件事（按发现顺序）

### ① `connect` 把「机器只支持 r=0」误伤到带子 —— **已修** `70d1cfc`

`connect.mjs` 有两处早退（`connect()` 的 `out_of_scope` + `portsOf()` 开头）。
这条限制的理由是「旋转**机器**的槽位偏移需 origin 位移表」，但代码没区分类型。

带子的方向完全由 `(rotation_variant, r)` 决定，任何 r 都合法：

```
beltExit(0,0)=top   beltExit(0,90)=right   beltExit(0,180)=bottom   beltExit(0,270)=left
```

而断点 `(1,-6)` 恰好是 **r=180**。于是：

```
out_of_scope: from 指向的 belt rotation=180；v1 只支持 r=0
```

**一条完全正确的计划被能力缺口挡死。** 修法：`belt` / `underground_belt` 豁免。

### ② 「必须换动作」剔错宏 —— **已修** `70d1cfc`

`countFingerprint()` 在同一世界诊断第 2 次出现时强制换动作，剔的是 `lastMacros`
（整轮计划里的**所有**宏）。但一轮里**排在前面的宏失败时，后面的根本没执行**
（`planToTxOps` R1：一条宏失败 ⇒ 一条 op 都不生成）。

实测：第 1 轮 `[replace_run, connect]`，`replace_run` 因 `out_of_scope` 被拒，
`connect` 一次都没跑。第 2 轮把两个一起剔 ⇒ 候选变成
`["insert_machine","trash_unused","extend_line"]` —— **正确答案 `connect` 出局**。

修法：新增 `lastExecutedMacros`，只在 plan 全绿（即将进 tx）时填；plan 被拒时清空。

### ③ `connect` 的布线搜不出路径 —— **未修，这是当前的天花板**

修完 ①② 之后，loop 第 2 轮干净地调 `connect(B34 → H1)`，宏接受了端点，
然后失败在**路径搜索**：

```
occupied: 所有候选路径都被挡住；第一处冲突在 (-3,-8)（self-overlap）
tried: 842
```

`self-overlap` 是**路径自己**的格重复（它自己的走法成环），不是撞到旧实体。

**842 条候选路径全部穷尽，没有一条成立。**

---

## 关键验证：这个场景是**有解**的

我独立测了 `allow_replace`：

```
默认            : ok=false  occupied  self-overlap at (-3,-8)  tried=842
allow_replace   : ok=true   cells=6
先方式 shortest : ok=false  occupied  self-overlap at (-3,-8)  tried=842
```

路径是 6 格：

```
(1,-7) → (0,-7) → (0,-6) → (0,-5) → (0,-4) → (0,-3)
```

而这 6 格里**只有 1 格有既有带子**：

| 格 | 原本 |
|---|---|
| `(1,-7)` | belt uid=10537 ← 必须覆盖这格才能转向 |
| 其余 5 格 | 空地 |

它选的是 hub 的 **entry 8**（`(0,-3)`）。

**所以：这个缺口是「布线算法不会走『覆盖那一格才能转弯』的路径」，不是无解。**

### 阳性对照（agent 自己加的）

手动用 `connect` + `allow_replace:true` 修好这个世界：

```
before: 45 实体, delivered 32, RuRu---- 32
after : 45 实体, delivered 38, RuRu---- 38
```

**hub 确实收到了货。** 这条把「世界能修好」钉死了 —— 差的只是 loop 能否自己走对那 842 条里的一条。

---

## 完整因果链

| 环节 | 状态 |
|---|---|
| 观察世界 | ✅ 正常 |
| 诊断断点 | ✅ **正确**（`DEAD_END` 精确命中 `(1,-6)`） |
| 选择动作 | ✅ **正确**（`connect`） |
| 解析端点 | ✅ 修 ① 后正常（`B34` → `H1`） |
| **布线搜路径** | ❌ **842 条全撞，缺 `allow_replace`** |
| 写世界 | 未到达 |
| 验证 | 未到达 |

---

## 为什么不是「模型笨」

三条独立证据：

1. 它的 `say` 每轮都准确描述了该做什么（「route it into the hub so the cut product
   finally gets delivered」）
2. 它选的宏和端点都对
3. **同样的动作、同样的参数，加一个 `allow_replace` 就成功了**（阳性对照）

失败在**我们给的宏能力**，不在它的判断。

---

## 候选的下一步（三条路，各有取舍）

### A. 让 `connect` 在「无解时才考虑覆盖」，而不是要求调用方预先开

现在 `allow_replace` 是**调用方**的安全阀。这个开关不该模型随手开（它会静默删 uid）。
但可以让 `connect` 在**842 条全撞**之后，再试一轮「只允许覆盖 1 格」的搜索，
并把那一格作为 `warnings` 报出来，由 loop 决定要不要接受。

- 好处：修掉真正的缺口，模型不用知道 `allow_replace`
- 风险：`connect` 从「绝不删东西」变成「可能删 1 格」，语义变松

### B. 保留 `allow_replace` 由调用方开，只改 prompt

在 `legal values` 里告诉模型这个开关存在、以及它会删东西。
让模型自己判断「这里值得覆盖一格」。

- 好处：改动小，安全语义不变
- 风险：把「会不会删错」的判断交给模型，而它看不到那格上是什么

### C. 改实验：砍掉的是「不转弯就能接上」的那几格

现在是砍 3 格后剩下的断点需要**转向**才能到 hub。如果砍的是让断点**正对** hub
入口的格数，`connect` 不需要覆盖任何东西就能接上。

- 好处：能验到「闭环走通」这件事本身
- 风险：这是把难度调低，不能证明「能处理真实改造场景」

---

## 诚实边界

- **只测了这一个断点形态**（朝下、需转向、hub 在上方）。
- **没跑真实的 `tx`**：所有失败都在 plan/宏阶段，`tx` 一次都没发出。
- **没验证 C 方案的可行性**：不确定「正对 hub 的砍法」是否真的不需要覆盖。
- 阳性对照是我手动调的宏，不是 loop 自己做的。
- 这一轮**没有产生任何一次 `outcome=success`**。

---

## 本轮修掉的东西（都是真 bug）

| commit | 内容 |
|---|---|
| `70d1cfc` | `connect` 对带子 r≠0 的误伤（两处）+ 「换动作」剔错宏 |
| `5c9507c` | 隧道等级门控（L4/L5 上它是非法建筑） |
| `1a51af2` | 升级瞬间 delta 变负 + 槽位格查找只按 origin |
| `0ee1c88` | `debug_items` 缺 region + flow 终点停在带子上 |

测试：**220 passed / 0 failed**。
