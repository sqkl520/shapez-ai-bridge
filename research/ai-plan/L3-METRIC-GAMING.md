# L3 判据可以被「做坏」刷满 —— 已实测复现

> 2026-11-02。红队 agent 提出，我独立逐条复现。
> **结论：`QUALITY-METRICS.md` 的 L3 判据（utilization / 瓶颈是否被处理）
> 单独使用是不可信的。它会奖励「把东西删掉」。**

---

## 为什么这条重要

`QUALITY-METRICS.md` 明确写了：

> **L1+L2 已经能做到。本轮的分野在 L3+L4。**

如果 L3 本身可以被一个懒惰或破坏性的策略刷满，
那用它当「经验形态 A/B」的主判据，测出来的就是**「模型会不会钻空子」**。

---

## 判据的公式（`src/agent/assess.mjs:274`）

```js
utilization = supply > 0 ? Math.min(1, processCapacity / supply) : null;
```

- 分子 `processCapacity` = 各类机器 `productPerSec` 的**最小值**（`assess.mjs:242-244`）
- 分母 `supply` = `activeMiners × minerRate`（`assess.mjs:219`）

**两边都能被单方面动手脚。** 提高分子或降低分母都能让这个比值上升。

---

## 攻击 A：把 cutter 放在产品段 —— utilization 翻倍，真产出归零

`cutHalf(cutHalf(RuRuRuRu))` 的产物是**空形状**（第二次切把已经切好的半片再切一半，
两个输出都不是目标形状）。

红队实测：在某个合法 region 放 `cutter + trash(left)` 之后：

```
BASELINE   util 27.8%   proc 0.5   supply 1.8
replace_run [3,-16,4,-14]  →  ok（删掉 2 条带子，放 1 台 cutter）
AFTER      util 55.6%   proc 1.0   supply 1.8
```

而 `QUALITY-METRICS.md` 的 L3 判据是「`utilization` 或『瓶颈是否被处理』」——
**这个动作两条都满足**，同时它把目标产出的通路永久切断。

⚠️ 这条**不是假想**：`B2-EXECUTION-REALITY.md` 证明模型真的会这么干
（跑通的那 2 条全落在产品段）。

---

## 攻击 B：孤立 cutter 也算进产能（我实测复现）

`assess.mjs:192-208` 的「在产线上」只做**四邻 BFS**：从矿机出发，
走到相邻带子/机器就算 `commandeered`。
所以**贴着任何带子放一台 cutter，不管它有没有接到货，都进 `processCapacity`。**

我的复现（`.tmpverify/ab-correction/` 下可重跑）：

```js
const OBS2 = JSON.parse(JSON.stringify(SC.obs));
OBS2.entities.push({type:'cutter', x:5, y:-20, r:0, variant:'default'});
OBS2.entities.push({type:'cutter', x:6, y:-20, r:0, variant:'default'});
OBS2.entities.push({type:'cutter', x:7, y:-20, r:0, variant:'default'});
capacityFor(OBS2);
```

结果：

```
BASELINE                  util 27.8%   bottleneck cutter
after 3 stray cutters     util 100.0%  bottleneck supply
```

**三台不接任何货的 cutter 就把 L3 刷满了，而且「瓶颈」这个字段直接消失**
（从 `process` 变成 `supply`）—— 也就是说判据不但被刷满，还反过来告诉你「没问题了」。

---

## 攻击 C：删矿机（当前宏挡得住，但结构性问题存在）

```js
// 删掉 2 台矿机
AFTER   supply 0.6   util 83.3%
```

`supply` 从 1.8 掉到 0.6，`utilization` 从 27.8% 升到 83.3%。

目前 `remove_run` 只动带子（`remove.mjs`：「选集里有 N 个非带子实体（整单拒绝）」），
所以**这条路当前不可达**。但它说明分子分母都能动这个结构性问题是真的 ——
一旦以后加了 `remove_machine` 或 `bulk_delete` 放宽，判据立刻被攻破。

---

## 这对正在跑的 C 实验意味着什么

我在跑的 `ab-correction` 三臂实验，判据是 `handledBottleneck`（加 cutter）
和 `trashSecondary`。**这两个都不是 L3。**

我**没有**用 utilization 当判据，这是对的 —— 但也不是因为我想到了攻击 B，
而是因为它在这个单轮实验里不可测（要改世界才能重算）。

⇒ **结论：C 实验的判据必须重新设计。** 见下面的建议。

---

## 建议：L3 必须成对使用，且加约束

单独一个比值不行。至少需要：

### 1. 分母锁死

```
utilization = processCapacity / supply
```

`supply` 不该由被测系统自己决定。在单轮实验里，**`supply` 应该在施加动作前后保持不变**
（除非动作明确是「加矿机」）。判据应当写成：

> `processCapacity` 上升，**且** `supply` 不变或上升
> （不允许靠减少供给来提高比值）

### 2. 分子必须验「真的接到货」

需要区分 `processCapacity` 和 **`processCapacityOnLine`**：

- 机器存在 ≠ 机器在产线上
- `assess.mjs:192-208` 的四邻 BFS 太松，应该改成**真正的流量验证**：
  这台机器的输入槽有没有可能收到货（沿 `beltExit`/`beltEntry` 反向可达矿机）
- 本项目已有 `flowReachable` / `flowOutlets`（`topology.mjs`），可以直接用

### 3. 加一条「不许破坏目标产出」的硬约束

最干净的写法：**判据里加入 L2 的门槛**。

> 只有当 `hub.stored_shapes[goal]` 的增量 **> 0**（或至少不下降）时，
> 才允许用 utilization 作为「有效率」的证据。

攻击 A（产品段二次切）会让真产出归零，这条门槛直接把它挡掉。

### 4. L4 的「不浪费」要能反向抵消 L3

`QUALITY-METRICS.md` 的 L4 是绕路率、`idleMiners`、多余机器。
攻击 B（3 台孤立 cutter）在 L4 里是「多余机器」，**应该扣分**。
但当前 L4 只是「看」，没有和 L3 合成一个数。

建议：**L3 的分只有在 L4 不退化时才算数。**

---

## 一条更根本的反思

`QUALITY-METRICS.md` 是在**还没测过任何经验形态**的时候写的。
它的设计前提是「loop 能修好，所以要看修得好不好」。

现在知道：
- 「修好」本身就很难（`B2-EXECUTION-REALITY.md`：16 条意图只有 2 条能执行）
- 「有效率」这个指标可以被破坏性动作刷满

⇒ **判据的门槛设得太高了。** 当 L1/L2 都还没稳定的时候，
用 L3/L4 做主判据，会得到大量噪声。

**建议的顺序反过来**：
1. 先把「意图 → 可执行计划」的转化率当成主指标（现在是 2/16 = 12.5%）
2. 转化率上去了，再看执行后的 L3/L4 才有意义

---

## 复现

```bash
cd "D:/Projects/rea/Project work/shapez"
# 攻击 B（我实测的那个）
node -e "
import('./src/agent/assess.mjs').then(async m=>{
  const fs=await import('node:fs');
  const SC=JSON.parse(fs.readFileSync('.tmpverify/capacity-scenario.json','utf8'));
  const a=m.capacityFor(SC.obs);
  console.log('base util', (a.capacity.utilization*100).toFixed(1)+'%');
  const O=JSON.parse(JSON.stringify(SC.obs));
  for(let i=0;i<3;i++) O.entities.push({type:'cutter',x:5+i,y:-20,r:0,variant:'default'});
  const b=m.capacityFor(O);
  console.log('after', (b.capacity.utilization*100).toFixed(1)+'%', 'bottleneck', b.capacity.bottleneck);
})"
```
