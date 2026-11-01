# 决定性复核：B2 的「16/23 处理瓶颈」实际是 2/23，且 2 条都错

> 2026-11-02。我独立重放验证了红队 agent 的核心主张。
> **这条结论推翻了 `AB-PROMPT-RESULT.md` 第二轮的主要论断。**

---

## 一句话

**`CAPACITY` 段让模型「说出」了正确的动作，但让它「做成」的证据是 2/23，
而不是上一轮报告的 16/23 或 16/25。** 而且那 2 条跑通的，选址都在**产品段**——
切出来的形状是反的。

统计上：`2/23 vs 0/23 → Fisher p = 0.49`（不显著）。

---

## 1. 上一轮的判据只看「参数里有没有 cutter 这个词」

`arms.mjs:267-277` 的 `acts_capacity`：
`insert_machine.machine` 或 `replace_run.building` 里出现 `cutter` 就算命中。

**它从来没有把计划真的喂给宏。**

## 2. 我自己重放的结果（独立实现，不复用红队的脚本）

脚本：`.tmpverify/ab-correction/replay-b2.mjs`

方法：按 `loop.mjs:1177` + `:1200-1248` 的顺序
`resolveRefs(plan, handles, obs)` → 逐条 `fn(args, {entities})`。

宏表**逐字照抄** `loop.mjs:95-101`，并断言与 `MACRO_NAMES` 同集合（6 个）。

```
宏表自检 OK：6 个宏全部有实现
句柄表：45 个
B2 独立样本 23 条

  ✗ B2# 3  replace_run:precondition_failed
  ✗ B2# 5  insert_machine:ambiguous_site
  ✗ B2# 8  replace_run:precondition_failed
  ✗ B2# 9  replace_run:precondition_failed
  ✗ B2#12  replace_run:precondition_failed
  ✗ B2#13  insert_machine:ambiguous_site
  ✗ B2#15  replace_run:precondition_failed
  ✗ B2#16  replace_run:precondition_failed
  ✗ B2#19  insert_machine:ambiguous_site
  ✓ B2#21  宏全过  insert_machine
  ✓ B2#22  宏全过  replace_run
  ✗ B2#23  replace_run:precondition_failed

判据判「加 cutter」:  16
能解析成计划:         16
宏全部 ok:            2
```

失败分布：

| 次数 | 原因 |
|---|---|
| 7 | `replace_run:precondition_failed` |
| 3 | `resolveRefs:PATH_NOT_RECT` |
| 3 | `insert_machine:ambiguous_site` |
| 1 | `resolveRefs:REF_SHAPE` |

**16 → 2。与红队独立得到的数字完全一致。**

---

## 3. 那 2 条跑通的，错在哪

### `B2#21`

```json
{"macro":"insert_machine",
 "args":{"at":{"$ref":"B11","asCell":true},"facing":"top",
         "machine":{"kind":"cutter"},"opts":{"replace_belts":true}},
 "why":"B11 carries raw RuRuRuRu into the existing cutter;
        inserting a second cutter here adds parallel cutting capacity"}
```

**模型的说明是错的。** B11 在产品段（`C1.right → B11 → B35 → …`），
运的是 `RuRu----`（已经切好的半片），不是 `raw RuRuRuRu`。

它把 cutter 插在**产品段**上，切出来的形状是 `----RuRu`，与目标 `RuRu----` 相反。

### `B2#22`

```json
{"macro":"replace_run",
 "args":{"region":{"$path_of":["B26","B27"]},"building":[{"kind":"cutter"}]},
 "why":"B26/B27 are the two parallel belts feeding L1 (the last merge before the hub line)"}
```

**同样错。** B26/B27 也在产品段。

两段带子被换成一台**裸 cutter**（没有 trash 接废料）。它的 left（废料）出口正对
`(3,-10)` 那个 balancer 的输入，right 朝 `(4,-10)` 也是 balancer。
**产品的一半进废料口。**

### 共同点

两条都是**「产品段」**（`SEGMENT_OF_BELT` 实测：B11/B26/B27 全部 `product`）。

⇒ **模型在「要处理瓶颈」这件事上被 CAPACITY 说动了，
但在「处理哪一段」上完全没有空间概念。**

---

## 4. 为什么 `replace_run` 大面积失败

7 条挂 `precondition_failed`。根因（红队 §3.3）：

> cutter 的 `left` 废料口要落在 region **之外**一格，必须有 trash 接得住。

也就是说，模型最常见的那个动作（把 cutter 塞进矿机到 balancer 之间的那段带子）
**在这个世界里物理上放不下**，除非同时给它一个垃圾桶。

模型的反应是**删掉 trash、只放裸 cutter** 来绕过 precondition（`#22` 就是这么来的），
于是得到一个「把产品倒进废料口」的计划。

---

## 5. 统计后果

| 判据 | A2 | B2 | Fisher p |
|---|---|---|---|
| 文本层「加 cutter」（上一轮的口径） | 0/23 | 16/23 | **4.95e-07** |
| **真的喂给宏能跑通**（正确口径） | 0/23 | **2/23** | **0.4889** |

**上一轮的 p=2.85e-07 是「文本匹配」的 p 值，不是「能做成」的 p 值。**

---

## 6. 这对前面的结论意味着什么

### 必须撤回的

> ❌ 「CAPACITY 段把处理瓶颈从 0/26 拉到 16/25（p=2.85e-07）」
>
> ✅ 正确说法：**CAPACITY 段让模型在文本里提出「加 cutter」这个动作（p≈5e-07），
> 但让它真的做成这件事的证据是 2/23，与 0 无法区分（p=0.49）。**

### 仍然成立的

> ✅ **模型本来就想得到「加 cutter」**（红队实测：A2 臂 22/23 条 thinking 自己提出了这个想法）。
> CAPACITY 段的作用不是「教它想到」，是**「授权它去做」**——A2 想到之后被 RECIPE 段的
> `⇒ machines this shape needs: miner×1, cutter×1` 劝退了。
>
> ✅ 观察面 vs 诊断的区分仍然成立（诊断没覆盖产能，CAPACITY 覆盖了）。
>
> ✅ 第一轮（断点场景）负结果不受影响。
>
> ✅ 「EXCEPTION 段有害」是 n=10 假阳性，不受影响。

### 新发现的、比原结论更重要的东西

> **模型的空间推理是它现在的真正瓶颈，不是知识。**
>
> 它知道「瓶颈要加机器」（自带），知道「加 cutter」（自带），
> CAPACITY 一授权它就去做。但**它不知道加在哪一段**——
> 16 条意图里只有 9 条落在原料段，能跑通的 2 条全落在产品段。
>
> ⇒ **C 实验（经验形态）如果只教「瓶颈要加机器」，什么也改善不了** ——
> 它本来就会。要教的是**「加在瓶颈机器之前，不是之后」**这种空间约束。

---

## 7. 对正在跑的 C 实验（`ab-correction`）的影响

我在跑的三臂实验（A2 / B2 / B2+C）判的是 `handledBottleneck`，
**它继承了同一个毛病**：只看「参数里有没有 cutter」。

我已经给 `v3.mjs` 的 `judge()` 补了 `cutterSegment`（raw / product / waste / unknown），
并且**可以从存盘的 `text` 事后重算，不需要重跑**（已验证：`judge()` 对存盘数据可复现）。

跑完后的分析必须用**严判据**（`cutterSegment === "raw"`）作为主结论，
`handledBottleneck` 只作为「意图」指标。

---

## 8. 诚实边界

1. **我的重放不是 loop 的完整执行路径。** 我跳过了 `planToTxOps`、`verifyRuntime`、
   坐标溯源校验。所以「宏全过」是**必要条件不是充分条件**——真实 loop 里能过的只会更少，
   不会更多。红队额外跑了 `planToTxOps`，也是 2 条。

2. **`precondition_failed` 可能是我调用宏时少传了上下文。**
   我传的是 `{entities: obs.entities}`，与 `loop.mjs` 一致；但如果 loop 还传了别的东西
   （比如 `items`、`production`），某些 precondition 可能实际能过。
   我没有逐条核对每个宏的第二个参数契约。**这一条会低估宏通过率。**
   缓解：红队的实现（独立写的）得到同样数字，交叉验证成立。

3. **「落在产品段是错的」依赖我对 `SEGMENT_OF_BELT` 的手工划分。**
   这个划分来自 `VERIFY-THREE-FACTS.md` 的拓扑实测（37 条带子全部验证闭合），
   但它是**手工抄的静态表**，不是运行时算的。如果抄错了，结论方向会变。
   自检只核对条数（14/22/1），核不到拓扑。

4. **n=23 仍然不大。** 2/23 vs 0/23 的 95% CI 很宽。说「CAPACITY 没用」也是过头的——
   正确说法是「**没有证据表明它能让人做成**」。

---

## 9. 复现

```bash
cd "D:/Projects/rea/Project work/shapez"
node .tmpverify/ab-correction/replay-b2.mjs
```

输出应当包含 `宏全部 ok: 2` 与 `7 × replace_run:precondition_failed`。
