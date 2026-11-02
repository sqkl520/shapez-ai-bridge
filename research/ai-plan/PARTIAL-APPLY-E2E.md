# 方案 E 的端到端实测：提交率 0.6% → 17.4%

> 2026-11-02。`buildTxPlan(..., {partial:true})` 在 178 条真实样本上的效果。
> 脚本：`.tmpverify/redteam-partial/e2e.mjs`

---

## 结果

| | 全有或全无 | `partial:true` |
|---|---|---|
| 提交 | **1** (0.6%) | **31** (17.4%) |
| 其中不可逆 place | 1 | **1** |
| 拒绝 | 177 | 147 |

**提交率提升 29 倍，不可逆 place 从 1 涨到 1（没变）。**

⚠️ 注意：这里的「不可逆 1 次」和红队 `reversible.mjs` 表格里的「A: 5 / E: 0」口径不同 ——
那边统计的是**所有样本的推演**，这里统计的是**真实现提交出去的**。两者都对，
只是分母不同（`e2e.mjs` 走真的 `buildTxPlan`，会额外被 R1/R13 等规则拒）。

---

## partial 模式的拒绝原因

| 次数 | 原因 |
|---|---|
| **128** | `NO_REVERSIBLE_CALL` |
| 13 | `PLAN_REJECTED`（R5 同格冲突等，跳过救不了） |
| 5 | `LLM_ARGS` |
| 1 | `LLM_COORD` |

### 那 128 条 `NO_REVERSIBLE_CALL` 是什么

按「调用数 vs 被跳过数」分组：

```
42 × calls=4 skipped=4
36 × calls=3 skipped=3
26 × calls=5 skipped=5
19 × calls=2 skipped=2
 4 × calls=1 skipped=1
 1 × calls=6 skipped=6
```

**`skipped` 数恒等于 `calls` 数** —— 每一条调用都被跳过了，一条可撤销的都没有。

这不是 bug，是**真实情况**：模型写的那些计划里全是
`connect`（在这个密集世界里失败）和 `trash_unused`（成功但不可撤销）。

⇒ **这恰好印证了红队的核心发现**：`trash_unused` 在这些样本上大量出现，
而它是不可撤销的。方案 B 会把这些全部提交，方案 E 把它们全挡掉了。

---

## 部分执行的样例

```
ops=20  skipped=["connect:macro_failed","connect:macro_failed","trash_unused:irreversible"]
ops=20  skipped=["connect:macro_failed","connect:macro_failed"]
ops=20  skipped=["connect:macro_failed","connect:macro_failed","connect:macro_failed","connect:macro_failed"]
```

`ops=20` 说明提交的是那条成功的 `connect`（它铺了 20 格带子）。
三条 `connect` 失败、`trash_unused` 不可撤销 —— **全部被正确跳过**。

这是想要的行为：**只做能撤销的那部分，把不可逆的挡在外面。**

---

## 但 17.4% 还是不高

主要原因不是方案 E 不够好，是**模型的计划本身质量低**：

- 128/178（72%）的计划里**一条可撤销的成功调用都没有**
- 那些计划的典型形态是「3-5 个 connect 全失败 + 1-2 个 trash 成功」

⇒ **方案 E 是一个正确但收益有限的下游兜底。**
真正的瓶颈仍是「模型写的 connect 大半执行不了」——
那是 `CONNECT-OCCUPIED-DIAGNOSIS.md` 和 `FOUR-ROUNDS-FINAL.md` 反复指向的那件事。

---

## 现在能打开 `partial:true` 吗

**技术上可以，但我建议先不要**，理由三条：

### 1. 判据层刚接上，没有真机验证

`strictVerdict` 的 `PARTIAL_APPLY` 有 11 条测试（含变异测试），
但**一次真机都没跑过**。而 `partial` 改变的是「什么算成功」——
那是本仓库历史上假绿事故最密集的地方。

### 2. `NO_REVERSIBLE_CALL` 会消耗轮次

128 条计划会因为这条新诊断被拒。虽然它给了可执行的 hint
（「换一条只涉及带子的修法」），但**模型会不会听**没测过。

如果模型下一轮还是写 `trash_unused`，那这条诊断就是白花一轮。

### 3. 它没有解决真正的瓶颈

提交率 17.4% 里，大部分来自「那条成功的 connect」。而模型写 3-5 个 connect 时
通常只有 1 个能成 —— 那是几何问题，不是原子性问题。

---

## 我的建议

**先做一件事再打开它**：

在真机上跑一次 `partial:true`，看：
1. `PARTIAL_APPLY` 真的让 `achieved` 变 false 吗
2. 被跳过之后的下一轮，模型会不会换修法
3. `NO_REVERSIBLE_CALL` 的 hint 有没有让它改掉 `trash_unused`

这三条任一为否，就说明方案 E 虽然正确但无用。

---

## 诚实边界

1. **`e2e.mjs` 走真实现，但不含 `runLoop` 的其它环节**（prompt / 指纹 / 预算）。
2. **「不可逆 1 次」与红队表格口径不同**（见上）。两个数字都是真的，别混着引用。
3. **只测 L4 一个世界**。在更空的世界里，`connect` 成功率会高得多，
   方案 E 的收益也会更大。
4. **没有验证「提交的那 31 个」跑完 `verifyRuntime` 之后有多少能过 L1/L2。**
   那是红队验收 agent 正在做的事。
