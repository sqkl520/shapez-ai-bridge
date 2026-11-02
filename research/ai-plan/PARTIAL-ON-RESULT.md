# 打开 `PARTIAL_APPLY` 之后的真机结果

> 2026-11-02。`BUDGET.PARTIAL_APPLY` 默认改为 `true` 之后的三次真机 run。
> 世界：level 5，目标 `Cu----Cu`，`delivered 0/170`，45 实体。

---

## 三次 run 的实际行为

| run | 提交的轮次 | partial 轮次 | 结论 |
|---|---|---|---|
| 第一次（默认打开） | 1（`insert_machine`，2 ops） | **0** | `Cu----Cu` 零产出 |
| 第二次（同上，A/B 基线） | 1（同上） | **0** | 同上 |
| **第三次（最终）** | **2**（`connect` 18 ops + `replace_run` 2 ops） | **0** | 仍然零产出 |

**三次 run 里，partial 轮次都是 0。**

---

## ★ 最重要的结论：「永远 partial」的风险完全不成立

不仅不成立，而且是**反过来的**：打开 partial 之后，
模型每次提交的都是**完整执行**（`partial: false`）。

原因（实测）：
- 模型的计划里，要么全成功（单条 `insert_machine` / `connect`）⇒ 完整提交
- 要么有失败但剩下的也不可撤销 ⇒ `NO_REVERSIBLE_CALL` 拒绝

**「全成功但部分不可撤销」这个夹在中间的情况在实际样本里没出现。**

---

## 第三次 run 的详细数据（最有信息量）

```
round 1: connect      → 18 ops 提交（铺了 18 格带子）
round 2: connect      → 被拒 PLAN_REJECTED
round 3: replace_run  → 2 ops 提交（换了个修法）

实体: 45 → 63 (+18)
stored: {..., "RuRu----": 241, "--RuRu--": 317}
outcome = halt / NO_PROGRESS
achieved = false
why = ["L4-behavior 未通过（跑完 2400 tick 后 Cu----Cu 一件都没产出）"]
```

**两个观察：**

1. **模型确实在换修法**（`connect` → `replace_run`），不是重复同一个。
2. **但目标形状还是零产出。** 它铺了 18 格带子和 2 个 replace，都没能造出 `Cu----Cu`。

---

## 一个必须说清楚的判断

**打开 partial 没有让结果变好，也没有让它变糟。**

三次 run 的 `achieved` 都是 `false`，
而那**不是 partial 造成的** —— 是「改产线」这件事本身超出了模型当前的能力。

证据：partial 一次都没触发（`partial 轮次 = 0`）。

⇒ **partial 是一个「在需要时才有用」的能力，而我们还没走到需要它的场景。**

---

## ★ 第三次 run 之后我查了产线实际状态 —— 发现一件重要的事

`production` RPC 的实测（run 结束后）：

```
produced_total:  {"RuRuRuRu": 68}
delivered_total: {"RuRuRuRu": 66}
stored_delta:    {"CuCuCuCu":0, "----CuCu":0, "RuRuRuRu":54, "----RuRu":0, "RuRu----":0}
```

**整条线只产整块 `RuRuRuRu`，完全没有切割。** 两个半块（`----RuRu` / `RuRu----`）
的产出都是 **0**。

对照 run 之前的 `stored`：`RuRu----: 241`、`--RuRu--: 317` 都在，说明
之前是有切割的。而现在没了。

⇒ **模型第 1 轮那 18 格带子把产线改成了「绕过 cutter 直连 hub」。**

它不是「改坏了」，是**改成了一个只产整块的新产线** —— 而这与目标
`Cu----Cu`（铜的半切）毫无关系。

这解释了 `L4-behavior` 为什么红：`Cu----Cu` 零产出。
**判据是对的，世界确实没在造目标形状。**

⚠️ 而这也说明：**`achieved: false` 不是因为 partial，是因为模型改错了方向。**

---

## 真正的瓶颈（第三次 run 又指了一遍）

`Cu----Cu` 是**铜的半切**，而现有产线在产 `RuRu----`（钌的半切）。
模型需要：
- 把铜矿接进来
- 或者改切割对象

它试了 `connect`（18 格）和 `replace_run`（2 格），都不对。

这与 `FOUR-ROUNDS-FINAL.md`、`CONNECT-OCCUPIED-DIAGNOSIS.md` 的结论一致：
**模型的瓶颈是「理解产线拓扑并做正确的空间改造」，不是原子性。**

---

## 这一轮修的两个真漏洞（都是 A/B 抓出来的）

### 漏洞 1：不可逆的照样被提交

原条件 `if (partialMode && executed.length < res.calls.length)` ——
只有**存在失败调用**时才筛可撤销性。

于是「全部成功」的计划（单条 `insert_machine`）跳过筛选，
直接提交 `place:cutter`，而 `partial` 标记还是 `false`。

**实测抓到的**：真机 round 1 就这样提交了不可逆的机器。

### 漏洞 2：修完漏洞 1 之后，单条 `insert_machine` 一律被拒

那会让模型**永远无法加机器**，而 `insert_machine` 是产能修复的主力宏。

修法：区分两种情况
- **(a)** 全部成功 + 都不可撤销 ⇒ 完整提交，`partial:false`
- **(b)** 有失败 + 剩下的都不可撤销 ⇒ 拒绝 `NO_REVERSIBLE_CALL`

---

## A/B 的判据也修了

上一版把「完整执行里的不可逆」和「部分执行里的不可逆」混在一起报漏洞，
导致**假警报**。正确判据：

| 情况 | 判定 |
|---|---|
| `partial:false` + 不可逆 | **合法**（计划是完整的，只是撤不回来） |
| `partial:true` + 不可逆 | **真漏洞**（已经跳过东西了，不该再夹带不可逆） |

修完之后：`[OK] 部分执行的轮次里没有不可逆提交`、
`[i] 1 次不可逆发生在完整执行里（合法）`。

---

## 诚实边界

1. **只跑了 3 次 run，n 太小**，不能下统计结论。
2. **partial 一次都没触发** —— 所以「partial 能不能帮上忙」**这个问题本轮没回答**。
   只是证明了「它不会让事情变糟」。
3. **世界是 level 5**（`Cu----Cu`），比 L4 难得多。L4 那个世界 partial 也没机会触发
   （模型第一次就成功）。
4. **`--RuRu--: 317` 持续在涨** —— 那是某个中间产物，我没查它从哪来。
5. **`stored` 里 `RuRu----` 停在 241 没变，而 `RuRuRuRu` 从 2016 涨到 2171。**
   查了 `production`：整条线只产整块、完全不切割 —— 模型第 1 轮那 18 格带子
   把产线改成了「绕过 cutter 直连 hub」。**这是改错方向，不是 partial 的锅。**
6. **世界没有复原** —— 第三次 run 之后我查了产线状态但没 `snapshot_load`。
   快照 `pre-final-partial` 在，需要时能回滚。
