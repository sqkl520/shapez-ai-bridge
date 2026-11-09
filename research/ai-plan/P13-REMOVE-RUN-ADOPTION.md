# P13 —— `remove_run` 为什么只被选了 1 次

日期：2026-11-04
触发：上一轮量化出「1405 次真实调用里 `remove_run` 只有 2 次」。这一轮去查为什么。

**结论：不是「模型不愿拆」，而是「模型以为自己没法指定位置」。**

---

## 1. 数据

`.tmpverify/ab-real/results-v{2..6}.json`，150 个真实 LLM 样本。

### 宏分布

```
connect 257 | trash_unused 177 | replace_run 89 | insert_machine 4 | remove_run 1
```

### 按版本拆开看（关键）

| 文件 | 样本 | thinking 提到「不能算位置」 | 提到 `$ore` | 宏分布 |
|---|---|---|---|---|
| results-v2 | 30 | 17 | **0** | connect 56 / trash 50 / replace 10 |
| results-v3 | 30 | 21 | **0** | connect 58 / trash 32 / replace 17 / **remove_run 1** |
| results-v4 | 30 | 21 | **0** | connect 46 / trash 35 / replace 18 |
| results-v5 | 30 | 20 | **0** | connect 52 / trash 41 / replace 22 |
| results-v6 | 30 | 16 | **0** | connect 45 / trash 19 / replace 22 |

**`$ore` 在这 150 个样本的 thinking 里出现 0 次。**

### thinking 里的原话

```
"But we can't compute positions; the loop resolves handles. Do we have a place with ore? We don't know."

"The fix would be to move the miner onto ore, but we can't compute positions."
"We could insert_machine a miner elsewhere? But we don't know where ore is."

"Candidates: remove_run, replace_run, insert_machine. ... 
 But placing a miner elsewhere needs ore... we don't know where ore is."
```

模型在**候选里看到了 `remove_run`**（149/150 提到删除），它知道该拆，
但它更急的事是「矿机没矿，而我不知道矿在哪」—— 那件事它没法表达。

---

## 2. 根因：`$ore` 提示被预算降级吃掉

`prompt.mjs` 里有一段「预算不够时按价值从低到高撤」的逻辑，原顺序是：

```
① 先撤 $ore 用法提示（~120 字符，只是"告诉模型有这个算子"）
② 还不够才撤整条资源行（那是事实信息，价值更高）
```

理由写的是「提示是**教学**，资源行是**事实**；预算紧时先牺牲教学」。

**这个判断是错的。** 在模型根本不知道有这个算子时，「教学」不是可牺牲项 ——
它是**唯一的行动路径**。资源行说「矿在图上」，提示说「怎么指它」；缺了后者，前者只是废话。

实测（`buildPrompt` 默认预算 9800，L4 夹具）：

```
不撤任何东西: 总字符 10186 → 超出
```

那批实验的 prompt 是 ~12000 字符（默认上限），所以 `$ore` 提示被吃掉了。

---

## 3. 两个改动

### 3.1 `$ore` 示例的颜色跟着目标走（真 bug）

旧实现写死：

```js
lines.push('(`{"$ore":"Cu"}` anywhere a cell is expected = the nearest Cu ore tile — ...)');
```

在目标矿是 `Ru` 的世界里，那句示例让模型以为要去连**铜**矿 —— 而上一行刚说「目标矿是 Ru」。
在 `RuRu----` 的夹具上现在输出：

```
⇒ target ore Ru IS on the map: RuRuRuRu×171
(`{"$ore":"Ru"}` anywhere a cell is expected = the nearest Ru ore tile — use it as insert_machine.at)
```

### 3.2 降级顺序：先撤资源行的细节，最后才撤「怎么指」

新顺序：

```
① 先试资源行的 compact 模式（保住「有矿」+「怎么指」两句核心）
② 还不够才撤整条资源行
③ 真的没预算了才撤 $ore 提示
```

实测（L4 夹具，默认预算 9800）：资源行与提示现在一起保留，总字符 10066。

---

## 4. 诚实边界：这个夹具本来就超预算

必须写清楚：L4 夹具是「17 台机器 + 163 条带子」的极端场景，
`## MACHINES` 一段就 1650 字符。默认 9800 预算**本来就装不下全部**。

生产路径 `loop.mjs` 传的是 `16000 / 4600`（那边 `$ore` 提示一直在），
所以这条改动主要影响**默认预算**下的调用方（实验脚本、外部 runner）。

我没有去压缩 `MACHINES_MAX=20` 或带子卡片的 `example` / `legal values` ——
那些是「操作对象」与「防拼错」，砍它们的代价没有数据支撑。
**只改了有数据支撑的那两处。**

---

## 5. 测试

`prompt_resource.test.mjs` +1（R8：示例颜色跟着目标走，不许写死 `Cu`）。

全量：`node --test --test-concurrency=1 src/agent/` → **556 全绿**。

⚠️ 并行跑（默认并发）时 `gates.test.mjs` 会偶发变红 —— 单独跑 400/400 全过，
串行也全过。那是资源竞争导致的假失败，不是回归。

---

## 6. 下一步

这一轮只修了「提示被吃掉」与「颜色写死」。真正没解决的是：

1. **`remove_run` 仍然只被选 1 次** —— 但它不是主因。主因是模型想去接矿、
   而（在默认预算下）它不知道自己能指名矿格。修完这条之后要**重跑那批实验**，
   才能知道 `remove_run` 的采用率会不会自然上来。
2. **`we can't compute positions` 这句话本身**值得再查：95/150 提到它。
   即使有了 `$ore`，模型是否还觉得「不能算位置」？那要看新的 trace。
